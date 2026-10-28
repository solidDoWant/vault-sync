// The verified resync (#1019, docs/design/verified-core.md §4, SPEC.md §8
// "Divergence"): the step the shell runs on the server's divergence signal
// after a restore from backup, before the device's next round (ShellRun).
//
// The resync re-anchors the journal, then settles #874's rows (step 4);
// only that settlement touches files, each write under a persisted intent
// (IntentsCoverDiskEffects):
// 1. Re-anchor (ResyncRow). A base or ahead the server no longer holds is
//    dropped. The base becomes the newest revision of the document the
//    server holds that this device synced: its kept base, or a later
//    revision of its own (SPEC.md §8: the own-commit anchor), its landed
//    commit included, or the parent a commit in flight is sealed on, which
//    it synced too (#1080). With none, the row has no base. An unsent
//    outbox whose id the server holds as the device's own landed commit
//    (reopened after a lost answer) is sent again under a fresh id.
//    CoreInv then makes
//    the device send what it holds again: a bound file that differs from the
//    new base gets an outbox, carrying the file. A user's delete of a
//    document the server no longer has is dropped (SPEC.md §8, #829); one of
//    a document whose new base is live is sent as a tombstone.
// 2. Pull the whole feed (PullFeed): each revision is recorded as the
//    remote-revision handler records it (RemoteJournal, #949), so every
//    restored head newer than the row's base waits as `ahead` for the next
//    round's apply, which settles it (#1007).
// 3. Read the feed to its end (ReadFeed, #1030): the cursor is the feed's
//    length and the anchor its last entry.
// 4. Settle #874's rows (PulledHead, PulledPlan, #1080 item 2): an
//    unchanged file at a lost base the device only pulled takes the
//    restored head in place, after a `base-purged` copy of the file where
//    no live head holds the lost base's content (planner ruling (2)). The
//    copy is the apply's (ApplyCore's PathConflictCopy and MergeIntent).
include "Apply.dfy"

abstract module ResyncCore refines ApplyCore {

  // ---------------------------------------------------------------------
  // Re-anchoring (compiled)
  // ---------------------------------------------------------------------

  // A revision of `doc` the server holds that device `d` wrote, the row's
  // landed commit included (#1080): the base may be the outbox's own
  // revision, which the next round's acknowledgement settles (§4.1).
  predicate OwnSynced(server: Server, d: DeviceId, doc: DocId, document: Document, id: RevId) {
    doc in server.history && id in server.history[doc] && id in server.revisions
    && server.revisions[id].device == d
  }

  // The id of the newest such revision in the document's history (the last
  // one in history order), from index `i` down.
  function NewestOwn(server: Server, d: DeviceId, doc: DocId, document: Document, i: nat): (r: Option<RevId>)
    requires doc in server.history && i <= |server.history[doc]|
    ensures r.Some? ==> (exists j :: 0 <= j < i && server.history[doc][j] == r.value
                           && OwnSynced(server, d, doc, document, r.value)
                           && (forall k :: j < k < i ==> !OwnSynced(server, d, doc, document, server.history[doc][k])))
    ensures r.None? ==> forall k :: 0 <= k < i ==> !OwnSynced(server, d, doc, document, server.history[doc][k])
  {
    if i == 0 then None
    else
      var id := server.history[doc][i - 1];
      if OwnSynced(server, d, doc, document, id) then Some(id)
      else NewestOwn(server, d, doc, document, i - 1)
  }

  function OwnAnchor(server: Server, d: DeviceId, doc: DocId, document: Document): (r: Option<RevId>)
    ensures r.Some? ==> r.value in server.revisions
  {
    if doc in server.history then NewestOwn(server, d, doc, document, |server.history[doc]|) else None
  }

  // The base the resync leaves: the newest of the kept base, the own
  // anchor (a landed commit the outbox carries included), and the parent a
  // commit in flight is sealed on (#1080). Each is a revision of the
  // document the server holds. Only the last can be another device's, and
  // the commit made on it is kept as it was, so it settles nothing
  // (CarriedOnParent).
  function ResyncBase(server: Server, d: DeviceId, doc: DocId, document: Document): Option<Base> {
    var kept := if document.base.Some? && document.base.value.rev in server.revisions then document.base else None;
    var own := OwnAnchor(server, d, doc, document);
    var anchored :=
      if own.Some? && (kept.None? || kept.value.position < server.revisions[own.value].position)
      then Some(BaseOf(server.revisions[own.value]))
      else kept;
    Raise(server, doc, anchored, ParentOn(document))
  }

  // `base`, or revision `f` of `doc` where the server holds it and it is
  // newer.
  function Raise(server: Server, doc: DocId, base: Option<Base>, f: Option<RevId>): (r: Option<Base>)
    ensures base.Some? ==> r.Some? && r.value.position >= base.value.position
    ensures f.Some? && f.value in server.revisions && server.revisions[f.value].doc == doc
            ==> r.Some? && r.value.position >= server.revisions[f.value].position
    ensures r == base || (f.Some? && f.value in server.revisions && server.revisions[f.value].doc == doc
                          && r == Some(BaseOf(server.revisions[f.value])))
  {
    if f.Some? && f.value in server.revisions && server.revisions[f.value].doc == doc
       && (base.None? || base.value.position < server.revisions[f.value].position)
    then Some(BaseOf(server.revisions[f.value]))
    else base
  }

  // The parent a commit in flight is sealed on. An unsent outbox is
  // re-parented on the base the resync leaves, so it raises nothing.
  function ParentOn(document: Document): Option<RevId> {
    if document.outbox.Some? && document.outbox.value.sealed then document.outbox.value.baseRev else None
  }

  // The outbox's id is a revision of the device's own of this document
  // that the server holds: its commit landed.
  predicate Landed(server: Server, d: DeviceId, doc: DocId, outbox: Outbox) {
    outbox.rev in server.revisions && server.revisions[outbox.rev].device == d
    && server.revisions[outbox.rev].doc == doc
  }

  // BaseOf: the apply's (ApplyCore).

  // AheadOfBase, compiled.
  predicate Differs(document: Document)
    ensures Differs(document) == AheadOfBase(document)
  {
    document.binding.Some?
    && (document.base.None? || document.base.value.deleted
        || document.base.value.path != document.binding.value.spelling
        || document.base.value.content != document.binding.value.seen)
  }

  // One row after re-anchoring, with `rev` the id of its next outbox.
  function ResyncRow(server: Server, d: DeviceId, doc: DocId, document: Document, rev: RevId): Document {
    var base' := ResyncBase(server, d, doc, document);
    var ahead' :=
      if document.ahead.Some? && document.ahead.value.revision.id in server.revisions
         && (base'.None? || base'.value.position < document.ahead.value.revision.position)
      then document.ahead else None;
    var parent := if base'.Some? then Some(base'.value.rev) else None;
    var row := document.(base := base', ahead := ahead');
    if document.outbox.Some? && !document.outbox.value.sealed then
      // An unsent outbox is sent on the new base; one whose commit landed
      // (reopened after a lost answer) under a fresh id, as the base now
      // covers the landed one (#1080).
      var id := if Landed(server, d, doc, document.outbox.value) then rev else document.outbox.value.rev;
      row.(outbox := Some(document.outbox.value.(rev := id, baseRev := parent)))
    else if document.outbox.Some? then
      // A commit in flight stays as it was sealed until its answer (§3.2).
      row
    else if Differs(row) then
      // The server lacks what the file holds: send it again.
      row.(outbox := Some(Outbox(rev, parent, document.binding.value.spelling, document.binding.value.seen,
                                 KindOf(document), false, false, false)))
    else if document.binding.None? && document.absence == UserDeleted && !(base'.Some? && base'.value.deleted) then
      if base'.Some? then
        // A user's delete of a document the server has live: send it.
        row.(outbox := Some(Outbox(rev, parent, base'.value.path, base'.value.content, base'.value.kind, true, false, false)))
      else
        // The server lacks the document: the delete is dropped (#829).
        row.(absence := Never)
    else row
  }

  function ResyncDocs(server: Server, d: DeviceId, documents: map<DocId, Document>, revs: FreshRevs): map<DocId, Document>
    requires documents.Keys <= revs.Keys
  {
    map doc | doc in documents :: ResyncRow(server, d, doc, documents[doc], revs[doc])
  }

  // ---------------------------------------------------------------------
  // Pulling the whole feed (compiled)
  // ---------------------------------------------------------------------

  // The journal after recording the feed's entries from `i` on, each as a
  // remote revision.
  function PullFeed(journal: Journal, server: Server, i: nat): Journal
    requires i <= |server.feed|
    decreases |server.feed| - i
  {
    if i == |server.feed| then journal
    else
      var journal' := if server.feed[i] in server.revisions then RemoteJournal(journal, server.revisions[server.feed[i]]) else journal;
      PullFeed(journal', server, i + 1)
  }

  // The resync's journal.
  function ResyncJournal(server: Server, d: DeviceId, journal: Journal, revs: FreshRevs): Journal
    requires journal.documents.Keys <= revs.Keys
  {
    var reanchored := journal.(documents := ResyncDocs(server, d, journal.documents, revs));
    ReadFeed(PullFeed(reanchored, server, 0), server.feed, |server.feed|)
  }

  // ---------------------------------------------------------------------
  // The step
  // ---------------------------------------------------------------------

  // The journal-only resync (#1078's choice (ii)): every row re-anchored
  // and the feed pulled, with no disk effect. The resync is this step,
  // then the settlement of #874's rows (ResyncStepOf).
  ghost function ReanchorStepOf(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs): Step
    requires d in pre.devices
  {
    if pre.devices[d].journal.documents.Keys <= revs.Keys then
      var journal' := ResyncJournal(pre.server, d, pre.devices[d].journal, revs);
      Step(pre, Resync(d), [PersistJournal(journal')], After(pre, d, journal'))
    else Step(pre, Resync(d), [], pre)
  }


  // ---------------------------------------------------------------------
  // #874 after a resync (#1080 item 2, compiled)
  // ---------------------------------------------------------------------

  // The document's head, as the server holds it (Head, compiled).
  function HeadOf(server: Server, doc: DocId): (r: Option<Revision>)
    ensures r == Head(server, doc)
  {
    if doc in server.history && |server.history[doc]| > 0
       && server.history[doc][|server.history[doc]| - 1] in server.revisions
    then Some(server.revisions[server.history[doc][|server.history[doc]| - 1]])
    else None
  }

  // SPEC.md §8 (#874): a row whose unchanged file is at a base this device
  // only pulled, which the restore lost (no outbox, no deferral, no own
  // revision the server still holds), takes the restored head as usual: the
  // resync writes the head's content over the file, which the listing
  // still reads as the device last saw it, and no editor holds unsaved
  // text at. A local rename is kept (the outbox sends it on the head); a
  // remote rename the device has not made is not settled here (the file
  // would move: the round's path rule's business), nor is a head out of
  // the device's scope or a tombstone. Any other row stays as the
  // journal-only resync left it, and the next round settles it.
  function PulledHead(platform: Platform, server: Server, d: DeviceId, doc: DocId, document: Document, input: RoundInput): Option<Revision> {
    if document.outbox.None? && document.ahead.None? && document.absence == Never
       && document.base.Some? && document.base.value.rev !in server.revisions && !document.base.value.deleted
       && OwnAnchor(server, d, doc, document).None?
       && document.binding.Some? && !document.binding.value.displaced
       && document.binding.value.seen == document.base.value.content
       && document.binding.value.spelling in input.listing
       && input.listing[document.binding.value.spelling].0 == document.binding.value.seen
       && (forall u | u in input.unsaved :: !SameF(platform, u, document.binding.value.spelling))
       && document.binding.value.spelling !in input.outOfScope
       && HeadOf(server, doc).Some?
       && !HeadOf(server, doc).value.deleted
       && HeadOf(server, doc).value.path !in input.outOfScope
       && HeadOf(server, doc).value.kind == document.base.value.kind
       && (document.binding.value.spelling == HeadOf(server, doc).value.path
           || document.binding.value.spelling != document.base.value.path)
    then HeadOf(server, doc)
    else None
  }

  // The settled row: the head is the base and the file holds it; a local
  // rename is sent on it.
  function PulledRow(document: Document, h: Revision, rev: RevId): Document
    requires document.binding.Some?
  {
    var spelling := document.binding.value.spelling;
    document.(base := Some(BaseOf(h)), ahead := None,
              binding := Some(document.binding.value.(seen := h.content)),
              outbox := if spelling == h.path then None
                        else Some(Outbox(rev, Some(h.id), spelling, h.content, h.kind, false, false, false)))
  }

  // The rows the resync may settle, in order.
  function PulledDocs(platform: Platform, server: Server, d: DeviceId, documents: map<DocId, Document>, input: RoundInput): seq<DocId> {
    DocsInOrder(set doc | doc in documents && PulledHead(platform, server, d, doc, documents[doc], input).Some?)
  }

  // Some live head on the server holds content `c` (Retrievable's head
  // clause, compiled): bytes the server keeps without any device's file.
  predicate HeldByHead(server: Server, c: Hash) {
    exists doc | doc in server.history :: HeadOf(server, doc).Some? && !HeadOf(server, doc).value.deleted
                                         && HeadOf(server, doc).value.content == c
  }

  // A row the resync settles: its head, and the `base-purged` copy its
  // file's version is kept as first, where no live head holds the lost
  // base's content (#1080, planner ruling (2)): the writer may no longer
  // hold it, so writing the head over the file would lose the last copy of
  // bytes the server accepted (G1).
  datatype Settlement = Settlement(doc: DocId, head: Revision, copy: Option<Path>)

  // Every bound name, which a copy never takes (the apply's `bound`).
  function BoundSpellings(documents: map<DocId, Document>): set<Path> {
    set doc | doc in documents && documents[doc].binding.Some? :: documents[doc].binding.value.spelling
  }

  // The settlements, in order. A copy's name is the apply's (the
  // path-conflict function, PathConflictCopy, as Settle picks it), chosen
  // one after another against the listing with the earlier copies in it,
  // as Aside chooses names, so no two collide. A row that needs a copy and
  // has no free name is not settled: it takes the existing path (§8: the
  // next round merges it or saves a copy).
  function PulledPlan(platform: Platform, server: Server, d: DeviceId, documents: map<DocId, Document>, input: RoundInput,
                      docs: seq<DocId>, listing: Listing): seq<Settlement>
    requires forall doc :: doc in docs ==> doc in documents
    decreases |docs|
  {
    if |docs| == 0 then []
    else
      var document := documents[docs[0]];
      var head := PulledHead(platform, server, d, docs[0], document, input);
      if head.None? then PulledPlan(platform, server, d, documents, input, docs[1..], listing)
      else if HeldByHead(server, document.base.value.content) then
        [Settlement(docs[0], head.value, None)] + PulledPlan(platform, server, d, documents, input, docs[1..], listing)
      else
        var spelling := document.binding.value.spelling;
        if spelling !in listing then PulledPlan(platform, server, d, documents, input, docs[1..], listing)
        else
          var claims := ClaimsOf(documents, docs[0]);
          match PathConflictCopy(platform, listing, BoundSpellings(documents) + input.unsaved,
                                 claims.(listed := BoundSpellings(documents)), spelling, spelling)
          case None => PulledPlan(platform, server, d, documents, input, docs[1..], listing)
          case Some(c) =>
            [Settlement(docs[0], head.value, Some(c))]
            + PulledPlan(platform, server, d, documents, input, docs[1..], listing[c := listing[spelling]])
  }

  function PlanOf(platform: Platform, server: Server, d: DeviceId, documents: map<DocId, Document>, input: RoundInput): seq<Settlement> {
    PulledPlan(platform, server, d, documents, input, PulledDocs(platform, server, d, documents, input), input.listing)
  }

  // The writes of a settlement: the copy first, an untracked file holding
  // the file's version (the apply's `Write(None, copy, ...)`), then the
  // head's content over the file, in place, conditional on the file still
  // holding what the device last saw: the apply's write for a pulled
  // revision (Settled's).
  function SettlementWrites(documents: map<DocId, Document>, input: RoundInput, s: Settlement): seq<Effect> {
    if s.doc in documents && documents[s.doc].binding.Some? then
      var b := documents[s.doc].binding.value;
      (if s.copy.Some? && b.spelling in input.listing
       then [Write(None, s.copy.value, b.seen, input.listing[b.spelling].1, None)] else [])
      + [Write(Some(s.doc), b.spelling, s.head.content, s.head.kind, Some(b.seen))]
    else []
  }

  function PulledWrites(documents: map<DocId, Document>, input: RoundInput, plan: seq<Settlement>): seq<Effect>
    decreases |plan|
  {
    if |plan| == 0 then []
    else SettlementWrites(documents, input, plan[0]) + PulledWrites(documents, input, plan[1..])
  }

  // One intent per settlement, as the round records before an apply's
  // writes (§4.3): an ApplyIntent for a write in place, the apply's
  // MergeIntent for a copy and the write after it. Recovery finishes or
  // undoes each from the disk alone.
  function ResyncIntentId(n: nat): IntentId

  function SettlementIntent(documents: map<DocId, Document>, s: Settlement, n: nat): Intent {
    if s.copy.Some? && s.doc in documents && documents[s.doc].binding.Some? then
      var b := documents[s.doc].binding.value;
      Intent(ResyncIntentId(n), MergeIntent(s.doc, s.head, b.spelling, s.head.content, Some((s.copy.value, b.seen))))
    else Intent(ResyncIntentId(n), ApplyIntent(s.doc, s.head))
  }

  function PulledIntents(documents: map<DocId, Document>, plan: seq<Settlement>, n: nat): seq<Intent>
    decreases |plan|
  {
    if |plan| == 0 then [] else [SettlementIntent(documents, plan[0], n)] + PulledIntents(documents, plan[1..], n + 1)
  }

  // The head a row is settled at, if the plan settles it.
  function PlannedHead(plan: seq<Settlement>, doc: DocId): Option<Revision>
    decreases |plan|
  {
    if |plan| == 0 then None
    else if plan[0].doc == doc then Some(plan[0].head)
    else PlannedHead(plan[1..], doc)
  }

  // The journal after the settlement: each settled row as PulledRow leaves
  // it, read against the row before the resync, and no open intent (the
  // writes are done; like a round, a resync starts from a journal whose
  // intents the restart's recovery settled, §4.3). A copy is untracked, as
  // the apply's copies are: the next push sends it as a new document.
  function SettledJournal(before: Journal, after: Journal, plan: seq<Settlement>, revs: FreshRevs): Journal
    requires before.documents.Keys <= revs.Keys
  {
    after.(intents := [], documents := map doc | doc in after.documents ::
      if doc in before.documents && before.documents[doc].binding.Some? && PlannedHead(plan, doc).Some?
      then PulledRow(before.documents[doc], PlannedHead(plan, doc).value, revs[doc])
      else after.documents[doc])
  }

  // The resync: the journal-only re-anchoring, then #874's rows settled.
  // With nothing to write it is ReanchorStepOf. Otherwise it persists the
  // journal it started from with an intent per write, writes, and
  // persists the settled journal with no open intent (§4.3).
  ghost function ResyncStepOf(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs): Step
  {
    var reanchor := ReanchorStepOf(pre, d, input, revs);
    if pre.devices[d].journal.documents.Keys <= revs.Keys then
      var device := pre.devices[d];
      var journal := device.journal;
      var plan := PlanOf(device.platform, pre.server, d, journal.documents, input);
      var writes := PulledWrites(journal.documents, input, plan);
      if |writes| == 0 then reanchor
      else
        var journal' := SettledJournal(journal, reanchor.post.devices[d].journal, plan, revs);
        var effects := [PersistJournal(journal.(intents := PulledIntents(journal.documents, plan, 0)))] + writes + [PersistJournal(journal')];
        var device' := device.(journal := journal', disk := Rewritten(device.disk, writes));
        Step(pre, Resync(d), effects, pre.(devices := pre.devices[d := device']))
    else reanchor
  }


  // ---------------------------------------------------------------------
  // Lemmas
  // ---------------------------------------------------------------------

  lemma PullFeedKeeps(journal: Journal, server: Server, i: nat)
    requires i <= |server.feed|
    ensures var j := PullFeed(journal, server, i);
      j.cursor == journal.cursor && j.intents == journal.intents && j.anchor == journal.anchor
      && journal.documents.Keys <= j.documents.Keys
    decreases |server.feed| - i
  {
    if i < |server.feed| {
      var journal' := if server.feed[i] in server.revisions then RemoteJournal(journal, server.revisions[server.feed[i]]) else journal;
      PullFeedKeeps(journal', server, i + 1);
    }
  }

  // The resync reaches the feed's end and requests no disk effect.
  lemma ResyncReadsFeed(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs)
    ensures var step := ReanchorStepOf(pre, d, input, revs);
      step.pre == pre && step.event == Resync(d)
      && d in step.post.devices && step.post.devices[d].journal.cursor == |pre.server.feed|
      && IntentsCoverDiskEffects(step.effects)
  {
    var step := ReanchorStepOf(pre, d, input, revs);
    assert forall i :: 0 <= i < |step.effects| ==> !IsDiskEffect(step.effects[i]);
  }

  // ---------------------------------------------------------------------
  // The rows
  // ---------------------------------------------------------------------

  // What pulling the feed does to a journal's rows: only aheads change, each
  // to a revision the server holds under its id, and a new row is one with
  // nothing but an ahead.
  ghost predicate PulledRows(server: Server, before: map<DocId, Document>, after: map<DocId, Document>) {
    before.Keys <= after.Keys
    && (forall doc :: doc in before ==>
          after[doc] == before[doc].(ahead := after[doc].ahead)
          && (before[doc].ahead.Some? ==> after[doc].ahead.Some?)
          && (after[doc].ahead.Some? ==>
                after[doc].ahead == before[doc].ahead || after[doc].ahead.value.revision.id in server.revisions))
    && (forall doc :: doc in after && doc !in before ==>
          after[doc].base.None? && after[doc].binding.None? && after[doc].absence == Never && after[doc].outbox.None?
          && after[doc].ahead.Some? && after[doc].ahead.value.revision.id in server.revisions)
  }

  lemma PulledRowsTrans(server: Server, a: map<DocId, Document>, b: map<DocId, Document>, c: map<DocId, Document>)
    requires PulledRows(server, a, b) && PulledRows(server, b, c)
    ensures PulledRows(server, a, c)
  {}

  lemma PullFeedRows(journal: Journal, server: Server, i: nat)
    requires i <= |server.feed| && RevisionsKeyed(server)
    ensures PulledRows(server, journal.documents, PullFeed(journal, server, i).documents)
    decreases |server.feed| - i
  {
    if i < |server.feed| {
      var journal' := if server.feed[i] in server.revisions then RemoteJournal(journal, server.revisions[server.feed[i]]) else journal;
      assert PulledRows(server, journal.documents, journal'.documents);
      PullFeedRows(journal', server, i + 1);
      PulledRowsTrans(server, journal.documents, journal'.documents, PullFeed(journal', server, i + 1).documents);
    }
  }

  // Re-anchoring keeps the row invariant.
  lemma ResyncRowInv(server: Server, d: DeviceId, doc: DocId, document: Document, rev: RevId)
    requires RowInv(document)
    ensures RowInv(ResyncRow(server, d, doc, document, rev))
  {}

  // The re-anchored row names only revisions the server holds.
  lemma ResyncRowOnServer(server: Server, d: DeviceId, doc: DocId, document: Document, rev: RevId)
    requires RevisionsKeyed(server)
    ensures var row := ResyncRow(server, d, doc, document, rev);
      (row.base.Some? ==> row.base.value.rev in server.revisions)
      && (row.ahead.Some? ==> row.ahead.value.revision.id in server.revisions)
  {}

  // No revision of the device's own in the document's history is newer than
  // the re-anchored base but its outbox's.
  lemma ResyncRowAcknowledged(server: Server, d: DeviceId, doc: DocId, document: Document, rev: RevId, id: RevId)
    requires HistoryFollowsFeed(server)
    requires doc in server.history && id in server.history[doc] && id in server.revisions
    requires server.revisions[id].device == d
    requires var row := ResyncRow(server, d, doc, document, rev);
      row.base.None? || row.base.value.position < server.revisions[id].position
    ensures var row := ResyncRow(server, d, doc, document, rev);
      row.outbox.Some? && row.outbox.value.rev == id
  {
    var row := ResyncRow(server, d, doc, document, rev);
    assert OwnSynced(server, d, doc, document, id);
    var history := server.history[doc];
    var k :| 0 <= k < |history| && history[k] == id;
    var own := OwnAnchor(server, d, doc, document);
    assert own.Some?;
    var j :| 0 <= j < |history| && history[j] == own.value
             && OwnSynced(server, d, doc, document, own.value)
             && (forall k2 :: j < k2 < |history| ==> !OwnSynced(server, d, doc, document, history[k2]));
    assert k <= j;
    assert server.revisions[id].position <= server.revisions[own.value].position;
    assert row.base.Some? && row.base.value.position >= server.revisions[own.value].position;
    assert false;
  }

  // The re-anchored row keeps CommitsOnBase's clauses (#1080): its parent
  // is a sealed one, raised under by ResyncBase, or the new base's id; a
  // landed commit its outbox carries is a revision of the device's own
  // that the own anchor covers, so everything before it is at or below the
  // base.
  lemma {:isolate_assertions} ResyncRowCommits(server: Server, d: DeviceId, doc: DocId, document: Document, rev: RevId)
    requires HistoryFollowsFeed(server) && RevisionsAccepted(server) && RevisionsKeyed(server)
    requires RevisionsOnFeed(server) && FeedPositioned(server)
    requires forall x, r :: x in server.history && r in server.history[x] ==> r in server.revisions
    requires document.base.Some? ==>
      document.base.value.rev in server.accepted && BaseRecords(document.base.value, doc, server.accepted[document.base.value.rev])
    requires document.outbox.Some? && document.outbox.value.baseRev.Some? ==> document.outbox.value.baseRev.value in server.accepted
    ensures var row := ResyncRow(server, d, doc, document, rev);
      OutboxParentAtBase(server, doc, row) && OwnCommitOnBase(server, d, doc, row)
      && (row.outbox.Some? && row.outbox.value.baseRev.Some? ==> row.outbox.value.baseRev.value in server.accepted)
  {
    var row := ResyncRow(server, d, doc, document, rev);
    var base' := ResyncBase(server, d, doc, document);
    assert row.base == base';
    assert base'.Some? ==> (base'.value.rev in server.revisions
                            && server.revisions[base'.value.rev].position == base'.value.position);
    if row.outbox.Some? && row.outbox.value.rev in server.revisions
       && server.revisions[row.outbox.value.rev].device == d
       && server.revisions[row.outbox.value.rev].doc == doc && doc in server.history
    {
      var x := row.outbox.value.rev;
      var h := server.history[doc];
      assert x in server.feed;
      var i :| 0 <= i < |server.feed| && server.feed[i] == x;
      assert x in h;
      var kx :| 0 <= kx < |h| && h[kx] == x;
      forall a, b | 0 <= a < |h| && 0 <= b < |h| && h[a] == x && h[b] == x ensures a == b {
        if a < b { assert server.revisions[h[a]].position < server.revisions[h[b]].position; }
        if b < a { assert server.revisions[h[b]].position < server.revisions[h[a]].position; }
      }
      forall id | id in h && id in server.revisions && id != x
        && server.revisions[id].position < server.revisions[x].position
        ensures base'.Some? && server.revisions[id].position <= base'.value.position
      {
        var a :| 0 <= a < |h| && h[a] == id;
        if kx < a { assert server.revisions[h[kx]].position < server.revisions[h[a]].position; }
        assert a < kx;
        assert OwnSynced(server, d, doc, document, x);
        var own := OwnAnchor(server, d, doc, document);
        assert own.Some?;
        var j :| 0 <= j < |h| && h[j] == own.value
                 && OwnSynced(server, d, doc, document, own.value)
                 && (forall k2 :: j < k2 < |h| ==> !OwnSynced(server, d, doc, document, h[k2]));
        assert kx <= j;
        if kx < j { assert server.revisions[h[kx]].position < server.revisions[h[j]].position; }
        assert server.revisions[x].position <= server.revisions[own.value].position;
      }
    }
  }

  // The resync's post-state keeps CommitsOnBase and OutboxParentsAccepted
  // (#1080): pulling the feed changes only aheads and adds rows with no
  // outbox, so each of d's rows is as ResyncRowCommits leaves it, and no
  // other device changes.
  lemma {:isolate_assertions} ResyncCommitsOnBase(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs) && CoreReachable(pre)
    ensures var post := ReanchorStepOf(pre, d, input, revs).post;
      CommitsOnBase(post) && OutboxParentsAccepted(post)
  {
    var post := ReanchorStepOf(pre, d, input, revs).post;
    var server := pre.server;
    var journal := pre.devices[d].journal;
    var reanchored := journal.(documents := ResyncDocs(server, d, journal.documents, revs));
    var pulled := PullFeed(reanchored, server, 0);
    PullFeedRows(reanchored, server, 0);
    assert post == After(pre, d, ReadFeed(pulled, server.feed, |server.feed|));
    assert post.devices[d].journal.documents == pulled.documents;
    forall doc | doc in journal.documents
      ensures var row := ResyncRow(server, d, doc, journal.documents[doc], revs[doc]);
        OutboxParentAtBase(server, doc, row) && OwnCommitOnBase(server, d, doc, row)
        && (row.outbox.Some? && row.outbox.value.baseRev.Some? ==> row.outbox.value.baseRev.value in server.accepted)
    {
      ResyncRowCommits(server, d, doc, journal.documents[doc], revs[doc]);
    }
    forall x, doc | x in post.devices && doc in post.devices[x].journal.documents
      ensures var row := post.devices[x].journal.documents[doc];
        (ReadsFeed(post, x) ==> OutboxParentAtBase(post.server, doc, row) && OwnCommitOnBase(post.server, x, doc, row))
        && (row.outbox.Some? && row.outbox.value.baseRev.Some? ==> row.outbox.value.baseRev.value in post.server.accepted)
    {
      if x == d {
        if doc in journal.documents {
          var row := ResyncRow(server, d, doc, journal.documents[doc], revs[doc]);
          assert reanchored.documents[doc] == row;
          assert pulled.documents[doc] == row.(ahead := pulled.documents[doc].ahead);
        }
      } else {
        assert post.devices[x] == pre.devices[x];
        if ReadsFeed(post, x) { assert ReadsFeed(pre, x); }
      }
    }
  }

  // The resync's journal names only revisions the server holds, keeps every
  // row invariant, and leaves no revision of the device's own unacknowledged.
  lemma {:isolate_assertions} ResyncRowsHold(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs) && CoreReachable(pre)
    ensures var step := ReanchorStepOf(pre, d, input, revs);
      d in step.post.devices
      && JournalOnServer(step.post.server, step.post.devices[d].journal)
      && CoreInv(step.post)
      && OwnRevisionsAcknowledged(step.post, d)
  {
    var server := pre.server;
    var journal := pre.devices[d].journal;
    var reanchored := journal.(documents := ResyncDocs(server, d, journal.documents, revs));
    var pulled := PullFeed(reanchored, server, 0);
    var journal' := ResyncJournal(server, d, journal, revs);
    var step := ReanchorStepOf(pre, d, input, revs);
    assert step.post == After(pre, d, journal');
    assert journal'.documents == pulled.documents;
    PullFeedRows(reanchored, server, 0);
    CoreInvRows(pre);
    forall doc | doc in journal'.documents
      ensures RowInv(journal'.documents[doc])
      ensures journal'.documents[doc].base.Some? ==> journal'.documents[doc].base.value.rev in server.revisions
      ensures journal'.documents[doc].ahead.Some? ==> journal'.documents[doc].ahead.value.revision.id in server.revisions
    {
      if doc in journal.documents {
        ResyncRowInv(server, d, doc, journal.documents[doc], revs[doc]);
        ResyncRowOnServer(server, d, doc, journal.documents[doc], revs[doc]);
        assert reanchored.documents[doc] == ResyncRow(server, d, doc, journal.documents[doc], revs[doc]);
      }
    }
    assert JournalOnServer(step.post.server, step.post.devices[d].journal);
    CoreInvRows(step.post);
    forall doc, id | Unacknowledged(step.post, d, doc, id)
      ensures journal'.documents[doc].outbox.Some? && journal'.documents[doc].outbox.value.rev == id
    {
      assert doc in journal.documents;
      assert reanchored.documents[doc] == ResyncRow(server, d, doc, journal.documents[doc], revs[doc]);
      ResyncRowAcknowledged(server, d, doc, journal.documents[doc], revs[doc], id);
    }
  }

  // ---------------------------------------------------------------------
  // The step predicates
  // ---------------------------------------------------------------------

  // The resync keeps every binding and every disk.
  lemma ResyncKeepsBindings(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs) && RevisionsKeyed(pre.server)
    ensures var step := ReanchorStepOf(pre, d, input, revs);
      var journal := pre.devices[d].journal;
      var journal' := step.post.devices[d].journal;
      d in step.post.devices
      && step.post == After(pre, d, journal')
      && step.effects == [PersistJournal(journal')]
      && journal.documents.Keys <= journal'.documents.Keys
      && (forall doc :: doc in journal.documents ==> journal'.documents[doc].binding == journal.documents[doc].binding)
      && (forall doc :: doc in journal'.documents && doc !in journal.documents ==>
            journal'.documents[doc].binding.None? && journal'.documents[doc].base.None?
            && journal'.documents[doc].absence == Never)
      && (forall doc :: doc in journal.documents && journal'.documents[doc].base.Some? ==>
            (journal.documents[doc].base.Some? && journal'.documents[doc].base.value.rev == journal.documents[doc].base.value.rev)
            || (journal'.documents[doc].base.value.rev in pre.server.revisions
                && pre.server.revisions[journal'.documents[doc].base.value.rev].device == d)
            // The parent the row's commit in flight is sealed on (#1080).
            || Some(journal'.documents[doc].base.value.rev) == ParentOn(journal.documents[doc]))
      && journal'.intents == journal.intents
      // A commit in flight stays as it was sealed (§3.2).
      && (forall doc :: doc in journal.documents && journal.documents[doc].outbox.Some?
            && journal.documents[doc].outbox.value.sealed
            ==> journal'.documents[doc].outbox == journal.documents[doc].outbox)
  {
    var server := pre.server;
    var journal := pre.devices[d].journal;
    var reanchored := journal.(documents := ResyncDocs(server, d, journal.documents, revs));
    PullFeedRows(reanchored, server, 0);
    PullFeedKeeps(reanchored, server, 0);
    forall doc | doc in journal.documents
      ensures reanchored.documents[doc] == ResyncRow(server, d, doc, journal.documents[doc], revs[doc])
    {}
  }

  // A device whose disk and binding for `doc` are unchanged has the same
  // bound file for it.
  lemma SameBoundFile(before: Device, after: Device, doc: DocId)
    requires after.disk == before.disk && after.platform == before.platform
    requires doc in before.journal.documents && doc in after.journal.documents
    requires after.journal.documents[doc].binding == before.journal.documents[doc].binding
    requires forall p, q :: p in before.disk && q in before.disk && p != q ==> !CollideF(before.platform, p, q)
    ensures BoundFile(after, doc) == BoundFile(before, doc)
  {
    var binding := before.journal.documents[doc].binding;
    if binding.Some? && HasFile(before, binding.value.spelling) {
      var q :| q in before.disk && SameF(before.platform, q, binding.value.spelling);
      FileAtOnly(before, binding.value.spelling, q);
      FileAtOnly(after, binding.value.spelling, q);
    }
  }

  // With one file per name, the file at `p` is the one at the path `q`
  // that names it.
  lemma FileAtOnly(device: Device, p: Path, q: Path)
    requires forall a, b :: a in device.disk && b in device.disk && a != b ==> !CollideF(device.platform, a, b)
    requires q in device.disk && SameF(device.platform, q, p)
    ensures HasFile(device, p) && FileAt(device, p) == device.disk[q]
  {
    var q' := var q' :| q' in device.disk && SameF(device.platform, q', p) && FileAt(device, p) == device.disk[q']; q';
    if q' != q {
      SameFIsEquivalence(device.platform, q', p, q);
      SameFIsEquivalence(device.platform, q, p, q);
      assert SameF(device.platform, q', q);
      assert CollideF(device.platform, q', q);
    }
  }

  // A resync settles no conflict: every base it sets is the row's own, or a
  // revision of this device's.
  lemma {:isolate_assertions} ResyncGuarantees(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs) && CoreReachable(pre)
    ensures var step := ReanchorStepOf(pre, d, input, revs);
      G1_Retained(step.post) && G1_LatestNeverPurged(step.post)
      && G5_NeverJoined(step.post) && G7_OneFilePerName(step.post)
    ensures var step := ReanchorStepOf(pre, d, input, revs);
      CoreInv(step.post) && ServerRetains(step.post) && StepGuarantees(step)
      && (!FinishedSyncing(step.post, d) ==> MirrorInv(step.post) && StateInvariants(step.post))
  {
    var step := ReanchorStepOf(pre, d, input, revs);
    ResyncKeepsBindings(pre, d, input, revs);
    ResyncRowsHold(pre, d, input, revs);
    var post := step.post;
    var journal := pre.devices[d].journal;
    var journal' := post.devices[d].journal;
    var before := pre.devices[d];
    var after := post.devices[d];
    assert post.server == pre.server;
    assert forall x :: x in pre.devices ==> x in post.devices && post.devices[x].disk == pre.devices[x].disk;
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}
    // G1: no disk and no server changed.
    forall rev | rev in pre.server.accepted
      ensures Retrievable(pre, rev) <==> Retrievable(post, rev)
      ensures (exists x :: x in pre.devices && OnDisk(pre.devices[x], pre.server.accepted[rev].content))
          <==> (exists x :: x in post.devices && OnDisk(post.devices[x], pre.server.accepted[rev].content))
    {
      var version := pre.server.accepted[rev];
      if exists x :: x in pre.devices && OnDisk(pre.devices[x], version.content) {
        var x := var x0 :| x0 in pre.devices && OnDisk(pre.devices[x0], version.content); x0;
        assert OnDisk(post.devices[x], version.content);
      }
      if exists x :: x in post.devices && OnDisk(post.devices[x], version.content) {
        var x := var x0 :| x0 in post.devices && OnDisk(post.devices[x0], version.content); x0;
        assert OnDisk(pre.devices[x], version.content);
      }
    }
    assert G1_Retained(post);
    assert G7_OneFilePerName(post);
    assert ServerRetains(post);
    // Bindings are unchanged, so every binding-reading predicate carries over.
    assert after.disk == before.disk && after.platform == before.platform;
    forall doc ensures BoundIdentity(after, doc) == BoundIdentity(before, doc) {
      SameBound(before, after, doc);
    }
    forall p ensures Tracked(after, p) == Tracked(before, p) {
      if Tracked(after, p) { var doc := var doc0 :| BoundTo(after, doc0, p); doc0; assert BoundTo(before, doc, p); }
      if Tracked(before, p) { var doc := var doc0 :| BoundTo(before, doc0, p); doc0; assert BoundTo(after, doc, p); }
    }
    assert G5_NeverJoined(post);
    assert G1_LatestNeverPurged(post);
    assert G5_NeverMixedUp(step);
    assert G3_DeleteSeen(step);
    // G6: every base the resync sets is the row's, this device's own
    // revision, or the parent its commit in flight is sealed on and kept
    // on (CarriedOnParent), so it settles nothing.
    forall x, doc, remote | SettlesConcurrent(step, x, doc, remote)
      ensures G6_Settle(step, x, doc, remote)
    {
      assert x == d;
      assert doc in journal.documents;
      assert pre.server.accepted[remote.id] == remote;
      var document := journal.documents[doc];
      if document.outbox.Some? && document.outbox.value.sealed {
        assert journal'.documents[doc].outbox == document.outbox;
        assert G7_OneFilePerName(pre);
        SameBoundFile(before, after, doc);
        assert Some(remote.id) == ParentOn(document);
        assert CarriedOnParent(step, d, doc, remote);
        assert false;
      } else {
        assert ParentOn(document).None?;
        assert false;
      }
    }
    if !FinishedSyncing(post, d) {
      AfterKeepsFinished(step, d, journal');
      AfterKeepsG9(pre, d, journal');
      KeepsFinishedKeepsMirror(step);
    }
    assert ServerFollowsEvent(step);
    // DisksFollowEffects: the one effect leaves the disk as it is.
    var disk := before.disk;
    assert EffectTakes(before.platform, disk, PersistJournal(journal'), disk);
    assert EffectsTake(before.platform, disk, step.effects[1..], disk);
    assert EffectsTake(before.platform, disk, step.effects, disk);
  }

  // ---------------------------------------------------------------------
  // Witnesses: the resync's anchors for a commit (#1080)
  // ---------------------------------------------------------------------

  // Another device's `p` (position 0) and device d's landed commit `x` on
  // it (position 1), in the document's history. The row lost its base.
  function LandedServer(d: DeviceId, other: DeviceId, doc: DocId, p: RevId, x: RevId, n: Path, pc: Hash, xc: Hash): Server {
    var rp := Revision(p, doc, 0, None, n, pc, Binary, false, other);
    var rx := Revision(x, doc, 1, Some(p), n, xc, Binary, false, d);
    Server(map[p := rp, x := rx], map[doc := [p, x]], [p, x], {}, map[p := rp, x := rx])
  }

  // A commit in flight that landed with its answer lost: the base becomes
  // the landed commit itself (an own revision, settling nothing), not the
  // entry before it, and the commit stays as it was sealed for the next
  // round's acknowledgement.
  lemma SealedLandedAnchorsAtCommit(d: DeviceId, other: DeviceId, doc: DocId, p: RevId, x: RevId, y: RevId,
                                    n: Path, pc: Hash, xc: Hash, yc: Hash, rev: RevId)
    requires d != other && p != x && y != p && y != x
    ensures
      var server := LandedServer(d, other, doc, p, x, n, pc, xc);
      var outbox := Outbox(x, Some(p), n, xc, Binary, false, true, false);
      var document := Document(Some(Base(y, 2, n, yc, Binary, false)), None, Some(Binding(n, xc, false, None)), Never, Some(outbox));
      var row := ResyncRow(server, d, doc, document, rev);
      row.base == Some(Base(x, 1, n, xc, Binary, false)) && row.outbox == Some(outbox)
  {
    var server := LandedServer(d, other, doc, p, x, n, pc, xc);
    var outbox := Outbox(x, Some(p), n, xc, Binary, false, true, false);
    var document := Document(Some(Base(y, 2, n, yc, Binary, false)), None, Some(Binding(n, xc, false, None)), Never, Some(outbox));
    assert OwnAnchor(server, d, doc, document) == Some(x);
  }

  // The same commit reopened (unsent again, re-parented on the lost base):
  // the base is the landed commit, and the outbox is sent again on it under
  // a fresh id, carrying the same content.
  lemma ReopenedLandedFreshOnCommit(d: DeviceId, other: DeviceId, doc: DocId, p: RevId, x: RevId, y: RevId,
                                    n: Path, pc: Hash, xc: Hash, yc: Hash, rev: RevId)
    requires d != other && p != x && y != p && y != x && rev != x
    ensures
      var server := LandedServer(d, other, doc, p, x, n, pc, xc);
      var outbox := Outbox(x, Some(y), n, xc, Binary, false, false, false);
      var document := Document(Some(Base(y, 2, n, yc, Binary, false)), None, Some(Binding(n, xc, false, None)), Never, Some(outbox));
      var row := ResyncRow(server, d, doc, document, rev);
      row.base == Some(Base(x, 1, n, xc, Binary, false))
      && row.outbox == Some(Outbox(rev, Some(x), n, xc, Binary, false, false, false))
  {
    var server := LandedServer(d, other, doc, p, x, n, pc, xc);
    var outbox := Outbox(x, Some(y), n, xc, Binary, false, false, false);
    var document := Document(Some(Base(y, 2, n, yc, Binary, false)), None, Some(Binding(n, xc, false, None)), Never, Some(outbox));
    assert OwnAnchor(server, d, doc, document) == Some(x);
  }

  // An unsent outbox on another device's `p`, which the server holds, does
  // not raise a lost base to `p` (that would settle `p` against the change):
  // the row has no base and the outbox is sent as a create.
  lemma UnsentOutboxRaisesNothing(d: DeviceId, other: DeviceId, doc: DocId, p: RevId, x: RevId, y: RevId,
                                  n: Path, pc: Hash, xc: Hash, yc: Hash, rev: RevId)
    requires d != other && p != x && y != p
    ensures
      var rp := Revision(p, doc, 0, None, n, pc, Binary, false, other);
      var server := Server(map[p := rp], map[doc := [p]], [p], {}, map[p := rp]);
      var outbox := Outbox(x, Some(p), n, xc, Binary, false, false, false);
      var document := Document(Some(Base(y, 2, n, yc, Binary, false)), None, Some(Binding(n, xc, false, None)), Never, Some(outbox));
      var row := ResyncRow(server, d, doc, document, rev);
      row.base.None? && row.outbox == Some(outbox.(baseRev := None))
  {
    var rp := Revision(p, doc, 0, None, n, pc, Binary, false, other);
    var server := Server(map[p := rp], map[doc := [p]], [p], {}, map[p := rp]);
    var outbox := Outbox(x, Some(p), n, xc, Binary, false, false, false);
    var document := Document(Some(Base(y, 2, n, yc, Binary, false)), None, Some(Binding(n, xc, false, None)), Never, Some(outbox));
    assert OwnAnchor(server, d, doc, document).None?;
  }


  // ---------------------------------------------------------------------
  // The settlement's writes (#1080 item 2)
  // ---------------------------------------------------------------------

  lemma EffectsTakeAppend(platform: Platform, disk: map<Path, DiskFile>, a: seq<Effect>, b: seq<Effect>,
                          mid: map<Path, DiskFile>, disk': map<Path, DiskFile>)
    requires EffectsTake(platform, disk, a, mid) && EffectsTake(platform, mid, b, disk')
    ensures EffectsTake(platform, disk, a + b, disk')
    decreases |a|
  {
    if |a| == 0 {
      assert a + b == b;
    } else {
      var m1: map<Path, DiskFile> :| EffectTakes(platform, disk, a[0], m1) && EffectsTake(platform, m1, a[1..], mid);
      EffectsTakeAppend(platform, m1, a[1..], b, mid, disk');
      assert (a + b)[0] == a[0];
      assert (a + b)[1..] == a[1..] + b;
    }
  }

  // An identity no file on the disk has.
  ghost function FreshFor(disk: map<Path, DiskFile>): (identity: FileIdentity)
    ensures forall q :: q in disk ==> disk[q].identity != identity
  {
    FreshIdentityExists(set q | q in disk :: disk[q].identity);
    var identity: FileIdentity :| identity !in (set q | q in disk :: disk[q].identity);
    identity
  }

  // The disk after the settlement's writes: an in-place write leaves its
  // file holding the written content and kind, under its identity; a copy
  // is a new file under a fresh identity.
  ghost function Rewritten(disk: map<Path, DiskFile>, writes: seq<Effect>): map<Path, DiskFile>
    decreases |writes|
  {
    if |writes| == 0 then disk
    else
      var w := writes[0];
      var disk' := if w.Write? && w.path in disk then disk[w.path := DiskFile(w.content, w.kind, disk[w.path].identity)]
                   else if w.Write? && w.precondition.None? then
                     // A copy: a new file, under an identity no file has
                     // (EffectTakes' fresh write).
                     disk[w.path := DiskFile(w.content, w.kind, FreshFor(disk))]
                   else disk;
      Rewritten(disk', writes[1..])
  }

  lemma DocsInOrderDistinct(s: set<DocId>)
    ensures var docs := DocsInOrder(s); forall i, j | 0 <= i < j < |docs| :: docs[i] != docs[j]
    decreases |s|
  {
    if s != {} {
      var doc := LeastDoc(s);
      DocsInOrderDistinct(s - {doc});
      assert DocsInOrder(s) == [doc] + DocsInOrder(s - {doc});
    }
  }

  lemma RewrittenAppend(disk: map<Path, DiskFile>, a: seq<Effect>, b: seq<Effect>)
    ensures Rewritten(disk, a + b) == Rewritten(Rewritten(disk, a), b)
    decreases |a|
  {
    if |a| > 0 {
      assert (a + b)[0] == a[0];
      assert (a + b)[1..] == a[1..] + b;
      var w := a[0];
      var disk' := if w.Write? && w.path in disk then disk[w.path := DiskFile(w.content, w.kind, disk[w.path].identity)]
                   else if w.Write? && w.precondition.None? then
                     disk[w.path := DiskFile(w.content, w.kind, FreshFor(disk))]
                   else disk;
      RewrittenAppend(disk', a[1..], b);
    } else {
      assert a + b == b;
    }
  }

  // An in-place write at a listed file holding the precondition, on a disk
  // where no two files collide, takes effect there.
  lemma InPlaceTakes(platform: Platform, disk: map<Path, DiskFile>, w: Effect)
    requires forall p, q :: p in disk && q in disk && p != q ==> !CollideF(platform, p, q)
    requires w.Write? && w.precondition.Some? && w.path in disk && disk[w.path].content == w.precondition.value
    ensures EffectTakes(platform, disk, w, Rewritten(disk, [w]))
    ensures Rewritten(disk, [w]) == disk[w.path := DiskFile(w.content, w.kind, disk[w.path].identity)]
  {
    SameFIsEquivalence(platform, w.path, w.path, w.path);
    assert Holds(platform, disk, w.path, w.path, w.precondition.value);
    var disk' := disk[w.path := DiskFile(w.content, w.kind, disk[w.path].identity)];
    forall q | Holds(platform, disk, q, w.path, w.precondition.value)
      ensures q == w.path
    {
      if q != w.path {
        SameFIsEquivalence(platform, q, w.path, w.path);
        assert CollideF(platform, q, w.path);
      }
    }
    assert Rewritten(disk, [w]) == Rewritten(disk', []);
  }

  // A copy at a name free on the disk takes effect: a new file.
  lemma CopyTakes(platform: Platform, disk: map<Path, DiskFile>, w: Effect)
    requires w.Write? && w.precondition.None? && FreeOn(platform, disk, w.path)
    ensures EffectTakes(platform, disk, w, Rewritten(disk, [w]))
    ensures w.path !in disk && Rewritten(disk, [w]).Keys == disk.Keys + {w.path}
    ensures forall q | q in disk :: Rewritten(disk, [w])[q] == disk[q]
    ensures forall q | q in disk :: !CollideF(platform, q, w.path)
  {
    SameFIsEquivalence(platform, w.path, w.path, w.path);
    assert CollideF(platform, w.path, w.path);
    var disk' := disk[w.path := DiskFile(w.content, w.kind, FreshFor(disk))];
    assert Rewritten(disk, [w]) == Rewritten(disk', []);
  }

  lemma CollideFSymmetric(platform: Platform, p: Path, q: Path)
    ensures CollideF(platform, p, q) == CollideF(platform, q, p)
  {
    if SameF(platform, p, q) { SameFIsEquivalence(platform, q, p, p); }
    if SameF(platform, q, p) { SameFIsEquivalence(platform, p, q, q); }
  }

  // The plan's writes take effect one after the other: each copy lands at a
  // name free on the disk as it then is (the threaded listing has its
  // names), and each in-place write finds its file still holding `seen`.
  lemma {:isolate_assertions} PlanTakes(platform: Platform, server: Server, d: DeviceId, documents: map<DocId, Document>,
                                        input: RoundInput, docs: seq<DocId>, listing: Listing, disk: map<Path, DiskFile>)
    requires forall doc :: doc in docs ==> doc in documents
    requires forall i, j | 0 <= i < j < |docs| :: docs[i] != docs[j]
    requires listing.Keys == disk.Keys
    requires forall p, q :: p in disk && q in disk && p != q ==> !CollideF(platform, p, q)
    requires forall doc | doc in docs && PulledHead(platform, server, d, doc, documents[doc], input).Some? ::
               documents[doc].binding.value.spelling in disk
               && disk[documents[doc].binding.value.spelling].content == documents[doc].binding.value.seen
    requires forall doc1, doc2 | doc1 in docs && doc2 in docs && doc1 != doc2
               && documents[doc1].binding.Some? && documents[doc2].binding.Some? ::
               !SameF(platform, documents[doc1].binding.value.spelling, documents[doc2].binding.value.spelling)
    ensures var writes := PulledWrites(documents, input, PulledPlan(platform, server, d, documents, input, docs, listing));
      EffectsTake(platform, disk, writes, Rewritten(disk, writes)) && disk.Keys <= Rewritten(disk, writes).Keys
    decreases |docs|
  {
    var plan := PulledPlan(platform, server, d, documents, input, docs, listing);
    if |docs| > 0 {
      var doc := docs[0];
      var document := documents[doc];
      var head := PulledHead(platform, server, d, doc, document, input);
      forall doc2 | doc2 in docs[1..] && PulledHead(platform, server, d, doc2, documents[doc2], input).Some?
        ensures head.Some? ==> document.binding.value.spelling != documents[doc2].binding.value.spelling
      {
        if head.Some? {
          assert doc2 != doc;
          SameFIsEquivalence(platform, document.binding.value.spelling, document.binding.value.spelling, document.binding.value.spelling);
        }
      }
      var rest := PulledPlan(platform, server, d, documents, input, docs[1..], listing);
      if head.None? {
        assert plan == rest;
        PlanTakes(platform, server, d, documents, input, docs[1..], listing, disk);
      } else if HeldByHead(server, document.base.value.content) {
        var b := document.binding.value;
        var w := Write(Some(doc), b.spelling, head.value.content, head.value.kind, Some(b.seen));
        assert plan == [Settlement(doc, head.value, None)] + rest;
        assert SettlementWrites(documents, input, plan[0]) == [w];
        assert PulledWrites(documents, input, plan) == [w] + PulledWrites(documents, input, rest) by {
          assert plan[1..] == rest;
        }
        InPlaceTakes(platform, disk, w);
        var disk1 := Rewritten(disk, [w]);
        PlanTakes(platform, server, d, documents, input, docs[1..], listing, disk1);
        var tail := PulledWrites(documents, input, rest);
        RewrittenAppend(disk, [w], tail);
        assert EffectsTake(platform, disk, [w], disk1) by {
          assert EffectsTake(platform, disk1, [w][1..], disk1);
        }
        EffectsTakeAppend(platform, disk, [w], tail, disk1, Rewritten(disk1, tail));
      } else {
        var b := document.binding.value;
        var sp := b.spelling;
        assert sp in input.listing;
        if sp !in listing {
          assert plan == rest;
          PlanTakes(platform, server, d, documents, input, docs[1..], listing, disk);
        } else {
          var claims := ClaimsOf(documents, doc);
          var copy := PathConflictCopy(platform, listing, BoundSpellings(documents) + input.unsaved,
                                       claims.(listed := BoundSpellings(documents)), sp, sp);
          if copy.None? {
            assert plan == rest;
            PlanTakes(platform, server, d, documents, input, docs[1..], listing, disk);
          } else {
            var c := copy.value;
            var listing' := listing[c := listing[sp]];
            var rest' := PulledPlan(platform, server, d, documents, input, docs[1..], listing');
            assert plan == [Settlement(doc, head.value, Some(c))] + rest';
            var wc := Write(None, c, b.seen, input.listing[sp].1, None);
            var w := Write(Some(doc), sp, head.value.content, head.value.kind, Some(b.seen));
            assert SettlementWrites(documents, input, plan[0]) == [wc, w];
            assert PulledWrites(documents, input, plan) == [wc, w] + PulledWrites(documents, input, rest') by {
              assert plan[1..] == rest';
            }
            assert FreeOn(platform, disk, c) by {
              forall q | q in disk ensures !CollideF(platform, q, c) { assert q in listing; }
            }
            CopyTakes(platform, disk, wc);
            var disk1 := Rewritten(disk, [wc]);
            forall p, q | p in disk1 && q in disk1 && p != q ensures !CollideF(platform, p, q) {
              CollideFSymmetric(platform, p, q);
            }
            InPlaceTakes(platform, disk1, w);
            var disk2 := Rewritten(disk1, [w]);
            assert listing'.Keys == disk2.Keys;
            PlanTakes(platform, server, d, documents, input, docs[1..], listing', disk2);
            var tail := PulledWrites(documents, input, rest');
            RewrittenAppend(disk, [wc], [w]);
            assert [wc] + [w] == [wc, w];
            RewrittenAppend(disk, [wc, w], tail);
            assert EffectsTake(platform, disk, [wc], disk1) by {
              assert EffectsTake(platform, disk1, [wc][1..], disk1);
            }
            assert EffectsTake(platform, disk1, [w], disk2) by {
              assert EffectsTake(platform, disk2, [w][1..], disk2);
            }
            EffectsTakeAppend(platform, disk, [wc], [w], disk1, disk2);
            EffectsTakeAppend(platform, disk, [wc, w], tail, disk2, Rewritten(disk2, tail));
          }
        }
      }
    }
  }

  // G1's core (#1080, planner ruling (2)): the plan destroys no content.
  // Every content a file held before it is still on the disk after it, or
  // is held by a live head on the server: a write in place replaces only
  // `seen`, the lost base's content, which a live head holds or which the
  // copy written just before it keeps.
  lemma {:isolate_assertions} PlanKeeps(platform: Platform, server: Server, d: DeviceId, documents: map<DocId, Document>,
                                        input: RoundInput, docs: seq<DocId>, listing: Listing, disk: map<Path, DiskFile>)
    requires forall doc :: doc in docs ==> doc in documents
    requires forall i, j | 0 <= i < j < |docs| :: docs[i] != docs[j]
    requires listing.Keys == disk.Keys
    requires forall p, q :: p in disk && q in disk && p != q ==> !CollideF(platform, p, q)
    requires forall doc | doc in docs && PulledHead(platform, server, d, doc, documents[doc], input).Some? ::
               documents[doc].binding.value.spelling in disk
               && disk[documents[doc].binding.value.spelling].content == documents[doc].binding.value.seen
    requires forall doc1, doc2 | doc1 in docs && doc2 in docs && doc1 != doc2
               && documents[doc1].binding.Some? && documents[doc2].binding.Some? ::
               !SameF(platform, documents[doc1].binding.value.spelling, documents[doc2].binding.value.spelling)
    ensures var disk' := Rewritten(disk, PulledWrites(documents, input, PulledPlan(platform, server, d, documents, input, docs, listing)));
      forall q | q in disk :: HeldByHead(server, disk[q].content)
        || exists c :: c in disk' && disk'[c].content == disk[q].content
    decreases |docs|
  {
    var plan := PulledPlan(platform, server, d, documents, input, docs, listing);
    var disk' := Rewritten(disk, PulledWrites(documents, input, plan));
    if |docs| == 0 {
      forall q | q in disk ensures exists c :: c in disk' && disk'[c].content == disk[q].content {
        assert disk' == disk;
      }
      return;
    }
    var doc := docs[0];
    var document := documents[doc];
    var head := PulledHead(platform, server, d, doc, document, input);
    forall doc2 | doc2 in docs[1..] && PulledHead(platform, server, d, doc2, documents[doc2], input).Some?
      ensures head.Some? ==> document.binding.value.spelling != documents[doc2].binding.value.spelling
    {
      if head.Some? {
        assert doc2 != doc;
        SameFIsEquivalence(platform, document.binding.value.spelling, document.binding.value.spelling, document.binding.value.spelling);
      }
    }
    var rest := PulledPlan(platform, server, d, documents, input, docs[1..], listing);
    if head.None? {
      assert plan == rest;
      PlanKeeps(platform, server, d, documents, input, docs[1..], listing, disk);
    } else if HeldByHead(server, document.base.value.content) {
      var b := document.binding.value;
      var w := Write(Some(doc), b.spelling, head.value.content, head.value.kind, Some(b.seen));
      assert plan == [Settlement(doc, head.value, None)] + rest;
      assert SettlementWrites(documents, input, plan[0]) == [w];
      assert PulledWrites(documents, input, plan) == [w] + PulledWrites(documents, input, rest) by {
        assert plan[1..] == rest;
      }
      InPlaceTakes(platform, disk, w);
      var disk1 := Rewritten(disk, [w]);
      PlanKeeps(platform, server, d, documents, input, docs[1..], listing, disk1);
      RewrittenAppend(disk, [w], PulledWrites(documents, input, rest));
      assert disk' == Rewritten(disk1, PulledWrites(documents, input, rest));
      forall q | q in disk
        ensures HeldByHead(server, disk[q].content) || exists c :: c in disk' && disk'[c].content == disk[q].content
      {
        if q == b.spelling {
          assert disk[q].content == b.seen == document.base.value.content;
        } else {
          assert disk1[q] == disk[q];
        }
      }
    } else {
      var b := document.binding.value;
      var sp := b.spelling;
      if sp !in listing {
        assert plan == rest;
        PlanKeeps(platform, server, d, documents, input, docs[1..], listing, disk);
      } else {
        var claims := ClaimsOf(documents, doc);
        var copy := PathConflictCopy(platform, listing, BoundSpellings(documents) + input.unsaved,
                                     claims.(listed := BoundSpellings(documents)), sp, sp);
        if copy.None? {
          assert plan == rest;
          PlanKeeps(platform, server, d, documents, input, docs[1..], listing, disk);
        } else {
          var c := copy.value;
          var listing' := listing[c := listing[sp]];
          var rest' := PulledPlan(platform, server, d, documents, input, docs[1..], listing');
          assert plan == [Settlement(doc, head.value, Some(c))] + rest';
          var wc := Write(None, c, b.seen, input.listing[sp].1, None);
          var w := Write(Some(doc), sp, head.value.content, head.value.kind, Some(b.seen));
          assert SettlementWrites(documents, input, plan[0]) == [wc, w];
          assert PulledWrites(documents, input, plan) == [wc, w] + PulledWrites(documents, input, rest') by {
            assert plan[1..] == rest';
          }
          assert FreeOn(platform, disk, c) by {
            forall q | q in disk ensures !CollideF(platform, q, c) { assert q in listing; }
          }
          CopyTakes(platform, disk, wc);
          var disk1 := Rewritten(disk, [wc]);
          forall p, q | p in disk1 && q in disk1 && p != q ensures !CollideF(platform, p, q) {
            CollideFSymmetric(platform, p, q);
          }
          InPlaceTakes(platform, disk1, w);
          var disk2 := Rewritten(disk1, [w]);
          assert listing'.Keys == disk2.Keys;
          PlanKeeps(platform, server, d, documents, input, docs[1..], listing', disk2);
          var tail := PulledWrites(documents, input, rest');
          RewrittenAppend(disk, [wc], [w]);
          assert [wc] + [w] == [wc, w];
          RewrittenAppend(disk, [wc, w], tail);
          assert disk' == Rewritten(disk2, tail);
          assert c != sp;
          assert c in disk2 && disk2[c].content == b.seen;
          forall q | q in disk
            ensures HeldByHead(server, disk[q].content) || exists c' :: c' in disk' && disk'[c'].content == disk[q].content
          {
            if q == sp {
              assert disk[q].content == disk2[c].content;
            } else {
              assert q != c;
              assert disk2[q] == disk[q];
            }
          }
        }
      }
    }
  }

  // The settlement's effects take effect: the persisted journals leave the
  // disk alone, each copy lands at its free name and each write replaces
  // its row's file in place, so the disk after the resync is the rewritten
  // one, with every name it had.
  lemma {:isolate_assertions} SettleDisk(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs)
    requires G5_NeverJoined(pre) && G7_OneFilePerName(pre)
    ensures var device := pre.devices[d];
      var plan := PlanOf(device.platform, pre.server, d, device.journal.documents, input);
      var writes := PulledWrites(device.journal.documents, input, plan);
      var step := ResyncStepOf(pre, d, input, revs);
      |writes| > 0 ==>
        EffectsTake(device.platform, device.disk, step.effects, Rewritten(device.disk, writes))
        && step.post.devices[d].disk == Rewritten(device.disk, writes)
        && device.disk.Keys <= Rewritten(device.disk, writes).Keys
  {
    var device := pre.devices[d];
    var platform := device.platform;
    var disk := device.disk;
    var documents := device.journal.documents;
    var docs := PulledDocs(platform, pre.server, d, documents, input);
    var plan := PlanOf(platform, pre.server, d, documents, input);
    var writes := PulledWrites(documents, input, plan);
    var step := ResyncStepOf(pre, d, input, revs);
    if |writes| > 0 {
      var S := set doc | doc in documents && PulledHead(platform, pre.server, d, doc, documents[doc], input).Some?;
      assert docs == DocsInOrder(S);
      DocsInOrderDistinct(S);
      assert input.listing == DiskListing(device);
      assert forall p, q :: p in disk && q in disk && p != q ==> !CollideF(platform, p, q);
      PlanTakes(platform, pre.server, d, documents, input, docs, input.listing, disk);
      var disk' := Rewritten(disk, writes);
      var journal' := SettledJournal(device.journal, ReanchorStepOf(pre, d, input, revs).post.devices[d].journal, plan, revs);
      var first := [PersistJournal(device.journal.(intents := PulledIntents(documents, plan, 0)))];
      var last := [PersistJournal(journal')];
      assert step.effects == first + writes + last;
      assert EffectsTake(platform, disk, first, disk) by {
        assert EffectTakes(platform, disk, first[0], disk);
        assert EffectsTake(platform, disk, first[1..], disk);
      }
      assert EffectsTake(platform, disk', last, disk') by {
        assert EffectTakes(platform, disk', last[0], disk');
        assert EffectsTake(platform, disk', last[1..], disk');
      }
      EffectsTakeAppend(platform, disk, first, writes, disk, disk');
      EffectsTakeAppend(platform, disk, first + writes, last, disk', disk');
      assert EffectsTake(platform, disk, step.effects, disk');
    }
  }


  // Each write of the plan is covered by its settlement's intent: an
  // ApplyIntent covers the write in place, the apply's MergeIntent the copy
  // and the write after it.
  lemma PulledIntentsCover(documents: map<DocId, Document>, input: RoundInput, plan: seq<Settlement>, n: nat)
    ensures forall w | w in PulledWrites(documents, input, plan) ::
      exists intent :: intent in PulledIntents(documents, plan, n) && Covers(intent.kind, w)
    decreases |plan|
  {
    if |plan| > 0 {
      PulledIntentsCover(documents, input, plan[1..], n + 1);
      var intent := SettlementIntent(documents, plan[0], n);
      assert intent in PulledIntents(documents, plan, n);
      forall w | w in SettlementWrites(documents, input, plan[0]) ensures Covers(intent.kind, w) {}
      forall w | w in PulledWrites(documents, input, plan)
        ensures exists intent :: intent in PulledIntents(documents, plan, n) && Covers(intent.kind, w)
      {
        if w !in SettlementWrites(documents, input, plan[0]) {
          assert w in PulledWrites(documents, input, plan[1..]);
          var other :| other in PulledIntents(documents, plan[1..], n + 1) && Covers(other.kind, w);
          assert other in PulledIntents(documents, plan, n);
        }
      }
    }
  }

  // Crash safety: each write comes after the first persisted journal,
  // whose intents cover it, and the last persisted journal has no open
  // intent and comes after every write.
  lemma {:isolate_assertions} SettleIntents(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs)
    ensures IntentsCoverDiskEffects(ResyncStepOf(pre, d, input, revs).effects)
  {
    var device := pre.devices[d];
    var platform := device.platform;
    var documents := device.journal.documents;
    var plan := PlanOf(platform, pre.server, d, documents, input);
    var writes := PulledWrites(documents, input, plan);
    var step := ResyncStepOf(pre, d, input, revs);
    if |writes| == 0 {
      assert step == ReanchorStepOf(pre, d, input, revs);
      assert forall i :: 0 <= i < |step.effects| ==> !IsDiskEffect(step.effects[i]);
    } else {
      PulledIntentsCover(documents, input, plan, 0);
      var journal' := SettledJournal(device.journal, ReanchorStepOf(pre, d, input, revs).post.devices[d].journal, plan, revs);
      var first := PersistJournal(device.journal.(intents := PulledIntents(documents, plan, 0)));
      var effects := [first] + writes + [PersistJournal(journal')];
      assert step.effects == effects;
      forall i | 0 <= i < |effects| && IsDiskEffect(effects[i])
        ensures exists j ::
                  0 <= j < i && effects[j].PersistJournal?
                  && exists intent :: intent in effects[j].journal.intents && Covers(intent.kind, effects[i])
      {
        assert 1 <= i <= |writes|;
        assert effects[i] == writes[i - 1];
        assert writes[i - 1] in writes;
        assert effects[0] == first;
      }
      var k := |effects| - 1;
      assert effects[k] == PersistJournal(journal') && |journal'.intents| == 0;
      assert forall i :: k < i < |effects| ==> !IsDiskEffect(effects[i]) && !effects[i].PersistJournal?;
    }
  }


  // A settled row keeps the row invariant, names the head the server
  // holds, and keeps CommitsOnBase's clauses: its outbox (a kept rename)
  // is on the head, which is the base, and carries an id the own anchor
  // would have covered had it landed (there is none).
  lemma {:isolate_assertions} SettledRowHolds(platform: Platform, server: Server, d: DeviceId, doc: DocId, document: Document,
                                              input: RoundInput, rev: RevId)
    requires RevisionsAccepted(server) && RevisionsKeyed(server) && HistoryFollowsFeed(server) && RevisionsOnFeed(server)
    requires PulledHead(platform, server, d, doc, document, input).Some?
    ensures var h := PulledHead(platform, server, d, doc, document, input).value;
      var row := PulledRow(document, h, rev);
      RowInv(row)
      && row.base.Some? && row.base.value.rev in server.revisions && row.base.value.rev in server.accepted
      && BaseRecords(row.base.value, doc, server.accepted[row.base.value.rev])
      && row.ahead.None?
      && OutboxParentAtBase(server, doc, row) && OwnCommitOnBase(server, d, doc, row)
      && (row.outbox.Some? && row.outbox.value.baseRev.Some? ==> row.outbox.value.baseRev.value in server.accepted)
      && row.binding.Some? && row.binding.value.spelling == document.binding.value.spelling
      && row.absence == Never
  {
    var h := PulledHead(platform, server, d, doc, document, input).value;
    var row := PulledRow(document, h, rev);
    assert h == Head(server, doc).value;
    var hist := server.history[doc];
    assert h.id == hist[|hist| - 1];
    assert server.revisions[h.id] == h;
    assert h.doc == doc;
    assert server.accepted[h.id] == h;
    if row.outbox.Some? && row.outbox.value.rev in server.revisions
       && server.revisions[row.outbox.value.rev].device == d
       && server.revisions[row.outbox.value.rev].doc == doc && doc in server.history
    {
      var x := row.outbox.value.rev;
      assert x in server.feed;
      assert x in hist;
      assert OwnSynced(server, d, doc, document, x);
      assert OwnAnchor(server, d, doc, document).Some?;
      assert false;
    }
  }


  // A row the plan settles is one PulledHead admits, at its head.
  lemma PlannedHeadIsPulled(platform: Platform, server: Server, d: DeviceId, documents: map<DocId, Document>, input: RoundInput,
                            docs: seq<DocId>, listing: Listing, doc: DocId)
    requires forall x :: x in docs ==> x in documents
    ensures var h := PlannedHead(PulledPlan(platform, server, d, documents, input, docs, listing), doc);
      h.Some? ==> doc in docs && PulledHead(platform, server, d, doc, documents[doc], input) == h
    decreases |docs|
  {
    if |docs| > 0 {
      var document := documents[docs[0]];
      PlannedHeadIsPulled(platform, server, d, documents, input, docs[1..], listing, doc);
      var head := PulledHead(platform, server, d, docs[0], document, input);
      if head.Some? && !HeldByHead(server, document.base.value.content) && document.binding.value.spelling in listing {
        var sp := document.binding.value.spelling;
        var claims := ClaimsOf(documents, docs[0]);
        var copy := PathConflictCopy(platform, listing, BoundSpellings(documents) + input.unsaved,
                                     claims.(listed := BoundSpellings(documents)), sp, sp);
        if copy.Some? {
          PlannedHeadIsPulled(platform, server, d, documents, input, docs[1..], listing[copy.value := listing[sp]], doc);
        }
      }
    }
  }

  // The settled step in terms of the re-anchoring: only d's journal and
  // disk differ; the journal is the re-anchored one with each settled row
  // replaced and no open intent; the disk is rewritten.
  lemma {:isolate_assertions} SettleShape(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs)
    requires G5_NeverJoined(pre) && G7_OneFilePerName(pre)
    ensures var device := pre.devices[d];
      var plan := PlanOf(device.platform, pre.server, d, device.journal.documents, input);
      var writes := PulledWrites(device.journal.documents, input, plan);
      var reanchor := ReanchorStepOf(pre, d, input, revs);
      var step := ResyncStepOf(pre, d, input, revs);
      var journal := device.journal;
      var jr := reanchor.post.devices[d].journal;
      var journal' := step.post.devices[d].journal;
      |writes| > 0 ==>
        step.pre == pre && step.event == Resync(d)
        && step.post.server == pre.server
        && step.post.devices.Keys == pre.devices.Keys
        && (forall x :: x in pre.devices && x != d ==> step.post.devices[x] == pre.devices[x])
        && step.post.devices[d] == device.(journal := journal', disk := Rewritten(device.disk, writes))
        && journal'.cursor == jr.cursor && journal'.anchor == jr.anchor && |journal'.intents| == 0
        && journal'.documents.Keys == jr.documents.Keys
        && (forall doc :: doc in journal'.documents ==>
              if doc in journal.documents && journal.documents[doc].binding.Some? && PlannedHead(plan, doc).Some?
              then journal'.documents[doc] == PulledRow(journal.documents[doc], PlannedHead(plan, doc).value, revs[doc])
              else journal'.documents[doc] == jr.documents[doc])
        && (forall doc :: PlannedHead(plan, doc).Some? ==>
              (doc in journal.documents
               && PulledHead(device.platform, pre.server, d, doc, journal.documents[doc], input) == PlannedHead(plan, doc)))
  {
    var device := pre.devices[d];
    var platform := device.platform;
    var documents := device.journal.documents;
    var docs := PulledDocs(platform, pre.server, d, documents, input);
    var plan := PlanOf(platform, pre.server, d, documents, input);
    var writes := PulledWrites(documents, input, plan);
    if |writes| > 0 {
      var S := set doc | doc in documents && PulledHead(platform, pre.server, d, doc, documents[doc], input).Some?;
      assert docs == DocsInOrder(S);
      forall doc | PlannedHead(plan, doc).Some?
        ensures doc in documents && PulledHead(platform, pre.server, d, doc, documents[doc], input) == PlannedHead(plan, doc)
      {
        PlannedHeadIsPulled(platform, pre.server, d, documents, input, docs, input.listing, doc);
      }
      SettleDisk(pre, d, input, revs);
    }
  }


  // The settled journal keeps the journal clauses the re-anchored one has:
  // each settled row by SettledRowHolds, every other row as it was.
  lemma {:isolate_assertions} SettleJournalClaims(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].running && CoreReachable(pre)
    requires RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs)
    requires ResyncKeeps(pre, d, ReanchorStepOf(pre, d, input, revs))
    ensures var step := ResyncStepOf(pre, d, input, revs);
      d in step.post.devices
      && step.post.devices[d].journal.cursor == |pre.server.feed|
      && JournalOnServer(step.post.server, step.post.devices[d].journal)
      && OwnRevisionsAcknowledged(step.post, d)
      && ResyncKeepsUserDelete(pre.devices[d].journal, step.post.devices[d].journal)
      && CoreInv(step.post) && JournalsNameAccepted(step.post)
      && CommitsOnBase(step.post) && OutboxParentsAccepted(step.post)
  {
    var device := pre.devices[d];
    var platform := device.platform;
    var plan := PlanOf(platform, pre.server, d, device.journal.documents, input);
    var writes := PulledWrites(device.journal.documents, input, plan);
    var step := ResyncStepOf(pre, d, input, revs);
    var reanchor := ReanchorStepOf(pre, d, input, revs);
    if |writes| == 0 {
      assert step == reanchor;
      assert ClaimsCore(step.post);
      return;
    }
    assert StateInvariants(pre) && ClaimsCore(pre);
    SettleShape(pre, d, input, revs);
    var server := pre.server;
    var journal := device.journal;
    var jr := reanchor.post.devices[d].journal;
    var post := step.post;
    var journal' := post.devices[d].journal;
    assert ClaimsCore(reanchor.post);
    assert reanchor.post.server == server;
    forall doc | doc in journal.documents && journal.documents[doc].binding.Some? && PlannedHead(plan, doc).Some?
      ensures var h := PlannedHead(plan, doc).value;
        var row := PulledRow(journal.documents[doc], h, revs[doc]);
        RowInv(row)
        && row.base.Some? && row.base.value.rev in server.revisions && row.base.value.rev in server.accepted
        && BaseRecords(row.base.value, doc, server.accepted[row.base.value.rev])
        && row.ahead.None?
        && OutboxParentAtBase(server, doc, row) && OwnCommitOnBase(server, d, doc, row)
        && (row.outbox.Some? && row.outbox.value.baseRev.Some? ==> row.outbox.value.baseRev.value in server.accepted)
        && row.absence == Never
    {
      SettledRowHolds(platform, server, d, doc, journal.documents[doc], input, revs[doc]);
    }
    // Every other device is as it was, and d's other rows as re-anchored.
    assert forall x :: x in post.devices && x != d ==> post.devices[x] == reanchor.post.devices[x];
    CoreInvRows(reanchor.post);
    CoreInvRows(post);
    assert ReadsFeed(post, d) <==> ReadsFeed(reanchor.post, d);
    forall x | x in post.devices ensures ReadsFeed(post, x) <==> ReadsFeed(reanchor.post, x) {}
    // Unacknowledged revisions of a settled row: none, as it has no own
    // revision in its history (no own anchor).
    forall doc, id | Unacknowledged(post, d, doc, id)
      ensures journal'.documents[doc].outbox.Some? && journal'.documents[doc].outbox.value.rev == id
    {
      if doc in journal.documents && journal.documents[doc].binding.Some? && PlannedHead(plan, doc).Some? {
        assert OwnSynced(server, d, doc, journal.documents[doc], id);
        assert OwnAnchor(server, d, doc, journal.documents[doc]).Some?;
        assert false;
      } else {
        assert Unacknowledged(reanchor.post, d, doc, id);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Witnesses: #874 after a resync (#1080 item 2)
  // ---------------------------------------------------------------------

  // Another device's head `h` of `doc` at `n` (content `hc`) is all the
  // restored server has; the row's base `b` at `n` (content `bc`), which
  // this device only pulled, is lost; the user renamed the unchanged file
  // to `m`.
  function PulledShapeServer(other: DeviceId, doc: DocId, h: RevId, n: Path, hc: Hash): Server {
    var rh := Revision(h, doc, 0, None, n, hc, Binary, false, other);
    Server(map[h := rh], map[doc := [h]], [h], {}, map[h := rh])
  }

  function PulledShapeRow(b: RevId, n: Path, m: Path, bc: Hash): Document {
    Document(Some(Base(b, 1, n, bc, Binary, false)), None, Some(Binding(m, bc, false, None)), Never, None)
  }

  // The last-copy trace (#1080, planner ruling (2)): no live head holds
  // the lost base's content `bc` (the head's is `hc`), so the file is
  // this device's only copy of it. The resync keeps it first as a
  // `base-purged` copy at the name the path-conflict function picks, then
  // settles the head: it becomes the base, the file at `m` is written with
  // its content (conditional on still holding `bc`), and the rename is
  // kept, sent on the head. With no free copy name the row is not settled.
  lemma PulledShapeSettled(platform: Platform, d: DeviceId, other: DeviceId, doc: DocId, h: RevId, b: RevId,
                           n: Path, m: Path, hc: Hash, bc: Hash, rev: RevId, file: FileIdentity)
    requires d != other && h != b && m != n && !SameF(platform, m, n) && hc != bc
    ensures
      var server := PulledShapeServer(other, doc, h, n, hc);
      var row := PulledShapeRow(b, n, m, bc);
      var input := RoundInput(map[m := (bc, Binary)], {}, [], {});
      var rh := Revision(h, doc, 0, None, n, hc, Binary, false, other);
      var documents := map[doc := row];
      var claims := ClaimsOf(documents, doc);
      var copy := PathConflictCopy(platform, input.listing, {m}, claims.(listed := {m}), m, m);
      var plan := PulledPlan(platform, server, d, documents, input, [doc], input.listing);
      PulledHead(platform, server, d, doc, row, input) == Some(rh)
      && !HeldByHead(server, bc)
      && PulledRow(row, rh, rev) == Document(Some(Base(h, 0, n, hc, Binary, false)), None, Some(Binding(m, hc, false, None)), Never,
                                             Some(Outbox(rev, Some(h), m, hc, Binary, false, false, false)))
      && (copy.Some? ==>
            plan == [Settlement(doc, rh, copy)]
            && PulledWrites(documents, input, plan) == [Write(None, copy.value, bc, Binary, None), Write(Some(doc), m, hc, Binary, Some(bc))]
            && copy.value != m
            && var disk := Rewritten(map[m := DiskFile(bc, Binary, file)], PulledWrites(documents, input, plan));
               copy.value in disk && disk[copy.value].content == bc && m in disk && disk[m].content == hc)
      && (copy.None? ==> plan == [])
  {
    var server := PulledShapeServer(other, doc, h, n, hc);
    var row := PulledShapeRow(b, n, m, bc);
    var input := RoundInput(map[m := (bc, Binary)], {}, [], {});
    var documents := map[doc := row];
    assert OwnAnchor(server, d, doc, row).None? by {
      assert !OwnSynced(server, d, doc, row, h);
    }
    assert documents[doc].binding.value.spelling == m;
    assert m in BoundSpellings(documents);
    assert forall x | x in BoundSpellings(documents) :: x == m;
    assert BoundSpellings(documents) == {m};
    assert BoundSpellings(documents) + input.unsaved == {m};
    SameFIsEquivalence(platform, m, m, m);
    var claims := ClaimsOf(documents, doc);
    var copy := PathConflictCopy(platform, input.listing, {m}, claims.(listed := {m}), m, m);
    var rh := Revision(h, doc, 0, None, n, hc, Binary, false, other);
    assert PulledHead(platform, server, d, doc, row, input) == Some(rh);
    assert !HeldByHead(server, bc) by {
      forall x | x in server.history ensures !(HeadOf(server, x).Some? && !HeadOf(server, x).value.deleted
                                               && HeadOf(server, x).value.content == bc) {
        assert x == doc;
      }
    }
    assert [doc][1..] == [];
    if copy.Some? {
      assert CollideF(platform, m, m);
      assert copy.value != m;
      var plan := PulledPlan(platform, server, d, documents, input, [doc], input.listing);
      assert plan == [Settlement(doc, rh, copy)] + PulledPlan(platform, server, d, documents, input, [], input.listing[copy.value := input.listing[m]]);
      assert plan == [Settlement(doc, rh, copy)];
      var w := PulledWrites(documents, input, plan);
      assert plan[1..] == [];
      assert row.binding.Some? && m in input.listing && input.listing[m].1 == Binary;
      assert SettlementWrites(documents, input, plan[0])
          == [Write(None, copy.value, bc, Binary, None), Write(Some(doc), m, hc, Binary, Some(bc))];
      assert PulledWrites(documents, input, plan[1..]) == [];
      assert w == SettlementWrites(documents, input, plan[0]) + PulledWrites(documents, input, plan[1..]);
      assert |w| == 2;
      var disk0 := map[m := DiskFile(bc, Binary, file)];
      RewrittenAppend(disk0, [w[0]], [w[1]]);
      assert w == [w[0]] + [w[1]];
    }
  }

  // The no-copy branch: a live head holds the lost base's content (here
  // the head itself), so the resync settles the row with no copy.
  lemma PulledShapeHeldNoCopy(platform: Platform, d: DeviceId, other: DeviceId, doc: DocId, h: RevId, b: RevId,
                              n: Path, m: Path, bc: Hash, file: FileIdentity)
    requires d != other && h != b && m != n && !SameF(platform, m, n)
    ensures
      var server := PulledShapeServer(other, doc, h, n, bc);
      var row := PulledShapeRow(b, n, m, bc);
      var input := RoundInput(map[m := (bc, Binary)], {}, [], {});
      var rh := Revision(h, doc, 0, None, n, bc, Binary, false, other);
      var documents := map[doc := row];
      var plan := PulledPlan(platform, server, d, documents, input, [doc], input.listing);
      HeldByHead(server, bc)
      && plan == [Settlement(doc, rh, None)]
      && PulledWrites(documents, input, plan) == [Write(Some(doc), m, bc, Binary, Some(bc))]
  {
    var server := PulledShapeServer(other, doc, h, n, bc);
    var row := PulledShapeRow(b, n, m, bc);
    assert OwnAnchor(server, d, doc, row).None? by {
      assert !OwnSynced(server, d, doc, row, h);
    }
    assert HeadOf(server, doc).Some?;
    SameFIsEquivalence(platform, m, m, m);
  }

  // An editor holding unsaved text at the file: the resync settles
  // nothing there and writes nothing (the next round merges or copies).
  lemma PulledShapeUnsavedWritesNothing(platform: Platform, d: DeviceId, other: DeviceId, doc: DocId, h: RevId, b: RevId,
                                        n: Path, m: Path, hc: Hash, bc: Hash)
    requires d != other && h != b && m != n
    ensures
      var server := PulledShapeServer(other, doc, h, n, hc);
      var row := PulledShapeRow(b, n, m, bc);
      var input := RoundInput(map[m := (bc, Binary)], {m}, [], {});
      PulledHead(platform, server, d, doc, row, input).None?
      && PulledWrites(map[doc := row], input, PulledPlan(platform, server, d, map[doc := row], input, [doc], input.listing)) == []
  {
    SameFIsEquivalence(platform, m, m, m);
  }

  // ---------------------------------------------------------------------
  // The claims
  // ---------------------------------------------------------------------

  // JournalsNameAccepted, one row at a time (as MergedClaims.dfy's
  // RowNamesAccepted, which this module cannot reach).
  ghost predicate RowNamed(server: Server, doc: DocId, document: Document) {
    (document.base.Some? ==>
       document.base.value.rev in server.accepted
       && BaseRecords(document.base.value, doc, server.accepted[document.base.value.rev]))
    && (document.ahead.Some? ==>
          document.ahead.value.revision.id in server.accepted
          && document.ahead.value.revision.doc == doc
          && server.accepted[document.ahead.value.revision.id] == document.ahead.value.revision)
  }

  // A row after a pulled revision knows of its document at least what it
  // knew before.
  ghost predicate KnowsNoLess(before: Document, after: Document) {
    KnownPosition(before).Some? ==>
      KnownPosition(after).Some? && KnownPosition(after).value >= KnownPosition(before).value
  }

  // A row knows feed entry `id` (a revision the server holds): it has the
  // revision's document, at that revision's position or later.
  ghost predicate EntryKnown(server: Server, documents: map<DocId, Document>, id: RevId) {
    id in server.revisions ==>
      var r := server.revisions[id];
      r.doc in documents && KnownPosition(documents[r.doc]).Some?
      && KnownPosition(documents[r.doc]).value >= r.position
  }

  lemma RemoteKnows(journal: Journal, r: Revision)
    ensures var docs' := RemoteJournal(journal, r).documents;
      r.doc in docs' && KnownPosition(docs'[r.doc]).Some? && KnownPosition(docs'[r.doc]).value >= r.position
      && journal.documents.Keys <= docs'.Keys
      && (forall doc :: doc in journal.documents ==> KnowsNoLess(journal.documents[doc], docs'[doc]))
  {}

  lemma PullFeedCovers(journal: Journal, server: Server, i: nat)
    requires i <= |server.feed|
    requires forall k :: 0 <= k < i ==> EntryKnown(server, journal.documents, server.feed[k])
    ensures forall k :: 0 <= k < |server.feed| ==> EntryKnown(server, PullFeed(journal, server, i).documents, server.feed[k])
    decreases |server.feed| - i
  {
    if i < |server.feed| {
      var journal' := if server.feed[i] in server.revisions then RemoteJournal(journal, server.revisions[server.feed[i]]) else journal;
      if server.feed[i] in server.revisions {
        RemoteKnows(journal, server.revisions[server.feed[i]]);
      }
      forall k | 0 <= k <= i ensures EntryKnown(server, journal'.documents, server.feed[k]) {
        if k < i && server.feed[k] in server.revisions {
          var r := server.revisions[server.feed[k]];
          assert KnowsNoLess(journal.documents[r.doc], journal'.documents[r.doc]);
        }
      }
      PullFeedCovers(journal', server, i + 1);
    }
  }

  // Pulling keeps every row naming accepted revisions.
  lemma PullFeedNamed(journal: Journal, server: Server, i: nat)
    requires i <= |server.feed| && RevisionsAccepted(server) && RevisionsKeyed(server)
    requires forall doc :: doc in journal.documents ==> RowNamed(server, doc, journal.documents[doc])
    ensures forall doc :: doc in PullFeed(journal, server, i).documents
              ==> RowNamed(server, doc, PullFeed(journal, server, i).documents[doc])
    decreases |server.feed| - i
  {
    if i < |server.feed| {
      var journal' := if server.feed[i] in server.revisions then RemoteJournal(journal, server.revisions[server.feed[i]]) else journal;
      PullFeedNamed(journal', server, i + 1);
    }
  }

  lemma ResyncRowNamed(server: Server, d: DeviceId, doc: DocId, document: Document, rev: RevId)
    requires RevisionsAccepted(server) && RevisionsKeyed(server) && HistoryFollowsFeed(server)
    requires RowNamed(server, doc, document)
    ensures RowNamed(server, doc, ResyncRow(server, d, doc, document, rev))
  {
    var own := OwnAnchor(server, d, doc, document);
    if own.Some? {
      assert doc in server.history;
      var j :| 0 <= j < |server.history[doc]| && server.history[doc][j] == own.value;
      assert server.revisions[own.value].doc == doc;
    }
  }

  // The resync keeps every clause of ClaimsReachable but MirrorInv, whose
  // finished-device case ResyncKeepsAll settles.
  lemma {:isolate_assertions} ResyncClaims(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs) && CoreReachable(pre)
    ensures var post := ReanchorStepOf(pre, d, input, revs).post;
      FeedPositioned(post.server) && ClaimsCoverCursor(post)
      && HistoryFollowsFeed(post.server) && RevisionsAccepted(post.server) && JournalsNameAccepted(post)
      && FeedAccepted(post.server) && RevisionsKeyed(post.server) && CutsHeadsApart(post.server)
      && ScopesClosedUnderF(post) && OwnDocsKnown(post) && ReadsFeed(post, d) && !Diverged(post, d)
      && (forall x :: ReadsFeed(post, x) ==> OwnRevisionsAcknowledged(post, x))
  {
    var step := ReanchorStepOf(pre, d, input, revs);
    ResyncKeepsBindings(pre, d, input, revs);
    ResyncRowsHold(pre, d, input, revs);
    var post := step.post;
    var server := pre.server;
    var journal := pre.devices[d].journal;
    var reanchored := journal.(documents := ResyncDocs(server, d, journal.documents, revs));
    var journal' := post.devices[d].journal;
    assert journal'.documents == PullFeed(reanchored, server, 0).documents;
    assert journal'.cursor == |server.feed|;
    assert journal'.anchor == (if |server.feed| == 0 then None else Some(server.feed[|server.feed| - 1]));
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}
    // The cursor's claims: the whole feed was pulled.
    PullFeedCovers(reanchored, server, 0);
    assert ReadsFeed(post, d);
    forall x, i | ReadsFeed(post, x) && 0 <= i < post.devices[x].journal.cursor
      && i < |post.server.feed| && post.server.feed[i] in post.server.revisions
      ensures var r := post.server.revisions[post.server.feed[i]];
        r.doc in post.devices[x].journal.documents
        && KnownPosition(post.devices[x].journal.documents[r.doc]).Some?
        && KnownPosition(post.devices[x].journal.documents[r.doc]).value >= r.position
    {
      if x == d {
        assert EntryKnown(server, journal'.documents, server.feed[i]);
      } else {
        assert ReadsFeed(pre, x);
      }
    }
    assert ClaimsCoverCursor(post);
    ResyncNamesAccepted(pre, d, input, revs);
    assert OwnDocsKnown(post);
    assert ScopesClosedUnderF(post);
    assert !Diverged(post, d);
    forall x | ReadsFeed(post, x) ensures OwnRevisionsAcknowledged(post, x) {
      if x != d {
        assert ReadsFeed(pre, x);
        assert OwnRevisionsAcknowledged(pre, x);
        assert post.devices[x] == pre.devices[x];
        forall doc, id | Unacknowledged(post, x, doc, id)
          ensures post.devices[x].journal.documents[doc].outbox.Some?
          ensures post.devices[x].journal.documents[doc].outbox.value.rev == id
        {
          assert Unacknowledged(pre, x, doc, id);
        }
      }
    }
  }

  lemma {:isolate_assertions} ResyncNamesAccepted(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs)
    requires RevisionsAccepted(pre.server) && RevisionsKeyed(pre.server) && HistoryFollowsFeed(pre.server)
    requires FeedAccepted(pre.server) && JournalsNameAccepted(pre)
    ensures JournalsNameAccepted(ReanchorStepOf(pre, d, input, revs).post)
  {
    var post := ReanchorStepOf(pre, d, input, revs).post;
    var server := pre.server;
    var journal := pre.devices[d].journal;
    var reanchored := journal.(documents := ResyncDocs(server, d, journal.documents, revs));
    var pulled := PullFeed(reanchored, server, 0).documents;
    assert post.devices[d].journal.documents == pulled;
    assert post.devices[d].journal.anchor == (if |server.feed| == 0 then None else Some(server.feed[|server.feed| - 1]));
    assert post.server == server;
    forall doc | doc in reanchored.documents ensures RowNamed(server, doc, reanchored.documents[doc]) {
      assert RowNamed(server, doc, journal.documents[doc]);
      assert reanchored.documents[doc] == ResyncRow(server, d, doc, journal.documents[doc], revs[doc]);
      ResyncRowNamed(server, d, doc, journal.documents[doc], revs[doc]);
    }
    PullFeedNamed(reanchored, server, 0);
    forall x | x in post.devices
      ensures var j := post.devices[x].journal;
        (j.anchor.Some? ==> j.anchor.value in post.server.accepted)
        && forall doc :: doc in j.documents ==> RowNamed(post.server, doc, j.documents[doc])
    {
      if x == d {
        assert |server.feed| > 0 ==> server.feed[|server.feed| - 1] in server.accepted;
        forall doc | doc in pulled ensures RowNamed(post.server, doc, pulled[doc]) {
          assert RowNamed(server, doc, pulled[doc]);
        }
      } else {
        assert post.devices[x] == pre.devices[x];
        var j := pre.devices[x].journal;
        forall doc | doc in j.documents ensures RowNamed(post.server, doc, j.documents[doc]) {}
      }
    }
  }

  // ---------------------------------------------------------------------
  // The contract
  // ---------------------------------------------------------------------

  // The state with every device but d stopped: d is then the only device
  // that can be finished, so G9 holds of it by d's agreement with itself.
  ghost function OthersStopped(state: State, d: DeviceId): State {
    state.(devices := map x | x in state.devices :: if x == d then state.devices[x] else state.devices[x].(running := false))
  }

  // ClaimsCore without G9: what the resync proves of its post-state before
  // MirrorInv, and what OthersStopped keeps.
  ghost predicate CoreButG9(state: State) {
    G1_Retained(state) && G1_LatestNeverPurged(state) && G5_NeverJoined(state) && G7_OneFilePerName(state)
    && CoreInv(state) && ServerRetains(state)
    && FeedPositioned(state.server) && ClaimsCoverCursor(state) && RevisionsOnFeed(state.server)
    && HistoryFollowsFeed(state.server) && RevisionsAccepted(state.server) && JournalsNameAccepted(state)
    && FeedAccepted(state.server) && RevisionsKeyed(state.server) && CutsHeadsApart(state.server)
    && ScopesClosedUnderF(state) && OwnDocsKnown(state)
    && (forall x :: ReadsFeed(state, x) ==> OwnRevisionsAcknowledged(state, x))
    && CommitsOnBase(state) && OutboxParentsAccepted(state)
  }

  lemma {:isolate_assertions} OthersStoppedCore(state: State, d: DeviceId)
    requires d in state.devices && CoreButG9(state)
    ensures ClaimsCore(OthersStopped(state, d))
  {
    var S := OthersStopped(state, d);
    assert S.server == state.server && S.devices.Keys == state.devices.Keys;
    assert forall x :: x in S.devices ==> S.devices[x] == state.devices[x].(running := S.devices[x].running);
    forall rev | rev in state.server.accepted
      ensures (exists x :: x in state.devices && OnDisk(state.devices[x], state.server.accepted[rev].content))
          <==> (exists x :: x in S.devices && OnDisk(S.devices[x], state.server.accepted[rev].content))
    {
      var version := state.server.accepted[rev];
      if exists x :: x in state.devices && OnDisk(state.devices[x], version.content) {
        var x := var x0 :| x0 in state.devices && OnDisk(state.devices[x0], version.content); x0;
        assert OnDisk(S.devices[x], version.content);
      }
      if exists x :: x in S.devices && OnDisk(S.devices[x], version.content) {
        var x := var x0 :| x0 in S.devices && OnDisk(S.devices[x0], version.content); x0;
        assert OnDisk(state.devices[x], version.content);
      }
    }
    assert G1_Retained(S);
    assert ServerRetains(S);
    assert G5_NeverJoined(S);
    assert G7_OneFilePerName(S);
    forall d1, d2, p | FinishedSyncing(S, d1) && FinishedSyncing(S, d2)
      && p in S.devices[d1].disk && p !in S.devices[d1].outOfScope && p !in S.devices[d2].outOfScope
      ensures G9Agrees(S, S.devices[d1], S.devices[d2], p)
    {
      assert d1 == d && d2 == d;
      SameNameModuloFoldersRefl(S.devices[d].platform, p);
    }
    assert G9(S);
    assert CoreInv(S);
    forall x | ReadsFeed(S, x) ensures OwnRevisionsAcknowledged(S, x) {
      assert ReadsFeed(state, x);
      assert OwnRevisionsAcknowledged(state, x);
      forall doc, id | Unacknowledged(S, x, doc, id)
        ensures S.devices[x].journal.documents[doc].outbox.Some?
        ensures S.devices[x].journal.documents[doc].outbox.value.rev == id
      {
        assert Unacknowledged(state, x, doc, id);
      }
    }
    forall x, doc | ReadsFeed(S, x) && doc in S.devices[x].journal.documents
      ensures OutboxParentAtBase(S.server, doc, S.devices[x].journal.documents[doc])
      ensures OwnCommitOnBase(S.server, x, doc, S.devices[x].journal.documents[doc])
    {
      assert ReadsFeed(state, x);
    }
    assert CommitsOnBase(S);
    assert OutboxParentsAccepted(S);
    assert ClaimsCoverCursor(S);
    assert JournalsNameAccepted(S);
    assert ScopesClosedUnderF(S);
    assert OwnDocsKnown(S);
  }

  // A device finished in `state` mirrors the heads if it does in
  // OthersStopped, which has the same server and leaves it as it is.
  lemma MirrorAtStopped(state: State, d: DeviceId)
    requires d in state.devices && FinishedSyncing(state, d) && MirrorInv(OthersStopped(state, d))
    ensures FilesMirrorHeads(state, state.devices[d]) && HeadsMirrored(state, state.devices[d])
  {
    var S := OthersStopped(state, d);
    assert S.devices[d] == state.devices[d] && S.server == state.server;
    assert FinishedSyncing(S, d);
    assert FilesMirrorHeads(S, S.devices[d]) && HeadsMirrored(S, S.devices[d]);
  }

  // A device a step leaves as it was, on the same server, mirrors the heads
  // after it if it did before.
  lemma MirrorOfUnchanged(pre: State, post: State, x: DeviceId)
    requires MirrorInv(pre) && post.server == pre.server
    requires x in pre.devices && x in post.devices && post.devices[x] == pre.devices[x]
    requires FinishedSyncing(post, x)
    ensures FilesMirrorHeads(post, post.devices[x]) && HeadsMirrored(post, post.devices[x])
  {
    assert FinishedSyncing(pre, x);
    assert FilesMirrorHeads(pre, pre.devices[x]) && HeadsMirrored(pre, pre.devices[x]);
  }

  // The resync keeps a user's pending delete of a document the server has
  // live: re-anchoring sends it as a tombstone, and pulling the feed
  // changes only aheads.
  lemma {:isolate_assertions} ResyncKeepsDelete(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs) && RevisionsKeyed(pre.server)
    ensures ResyncKeepsUserDelete(pre.devices[d].journal, ReanchorStepOf(pre, d, input, revs).post.devices[d].journal)
  {
    var server := pre.server;
    var journal := pre.devices[d].journal;
    var reanchored := journal.(documents := ResyncDocs(server, d, journal.documents, revs));
    var pulled := PullFeed(reanchored, server, 0);
    PullFeedRows(reanchored, server, 0);
    var post := ReanchorStepOf(pre, d, input, revs).post;
    assert post.devices[d].journal.documents == pulled.documents;
    forall doc | doc in journal.documents && journal.documents[doc].binding.None?
      && journal.documents[doc].absence == UserDeleted
      ensures doc in pulled.documents
      ensures pulled.documents[doc].base.None? || pulled.documents[doc].base.value.deleted
              || pulled.documents[doc].absence == UserDeleted
    {
      var row := ResyncRow(server, d, doc, journal.documents[doc], revs[doc]);
      assert reanchored.documents[doc] == row;
      assert pulled.documents[doc] == row.(ahead := pulled.documents[doc].ahead);
    }
  }

  // The resync keeps every invariant: ClaimsCore from the lemmas above,
  // MirrorInv and MirrorAtCursor from ClaimsImplyMirrorContract (proven by
  // ClaimsMirror.ClaimsImplyMirror, #1078; this module cannot refine
  // ClaimsMirror, Dafny 4.11's resolver crashes). A device the resync leaves
  // finished mirrors the heads by the contract at OthersStopped, where it
  // is the only finished device.
  lemma {:isolate_assertions} ReanchorKeepsAll(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires ClaimsImplyMirrorContract()
    requires d in pre.devices && pre.devices[d].running && CoreReachable(pre)
       && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs)
    ensures ResyncKeeps(pre, d, ReanchorStepOf(pre, d, input, revs))
  {
    {
      var step := ReanchorStepOf(pre, d, input, revs);
      var post := step.post;
      ResyncReadsFeed(pre, d, input, revs);
      ResyncRowsHold(pre, d, input, revs);
      ResyncGuarantees(pre, d, input, revs);
      ResyncClaims(pre, d, input, revs);
      ResyncKeepsBindings(pre, d, input, revs);
      ResyncCommitsOnBase(pre, d, input, revs);
      ResyncKeepsDelete(pre, d, input, revs);
      assert post.server == pre.server;
      assert RevisionsOnFeed(post.server);
      assert CoreButG9(post);
      if FinishedSyncing(post, d) {
        var S := OthersStopped(post, d);
        OthersStoppedCore(post, d);
        assert MirrorInv(S);
        MirrorAtStopped(post, d);
        forall x | x in post.devices && FinishedSyncing(post, x) && x != d
          ensures FilesMirrorHeads(post, post.devices[x]) && HeadsMirrored(post, post.devices[x])
        {
          MirrorOfUnchanged(pre, post, x);
        }
        assert MirrorInv(post);
        MirrorImpliesG9(post);
      }
      assert StateInvariants(post);
      assert ClaimsCore(post);
      assert ClaimsReachable(post);
      assert MirrorAtCursor(post);
    }
  }

  // The resync: with nothing to settle it is the journal-only re-anchoring
  // (ReanchorKeepsAll); otherwise #874's rows are settled on top of it
  // (SettleKeepsAll).
  lemma ResyncKeepsAll(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires ClaimsImplyMirrorContract()
    ensures ResyncContract(pre, d, input, revs)
  {
    if d in pre.devices && pre.devices[d].running && CoreReachable(pre)
       && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs) {
      var device := pre.devices[d];
      var plan := PlanOf(device.platform, pre.server, d, device.journal.documents, input);
      var writes := PulledWrites(device.journal.documents, input, plan);
      ReanchorKeepsAll(pre, d, input, revs);
      if |writes| == 0 {
        assert ResyncStepOf(pre, d, input, revs) == ReanchorStepOf(pre, d, input, revs);
      } else {
        SettleKeepsAll(pre, d, input, revs);
      }
    }
  }

  // OPEN (#1080 item 2): the settlement of #874's rows keeps everything.
  lemma SettleKeepsAll(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires ClaimsImplyMirrorContract()
    requires d in pre.devices && pre.devices[d].running && CoreReachable(pre)
       && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs)
    requires ResyncKeeps(pre, d, ReanchorStepOf(pre, d, input, revs))
    ensures ResyncKeeps(pre, d, ResyncStepOf(pre, d, input, revs))
  {
  }
}
