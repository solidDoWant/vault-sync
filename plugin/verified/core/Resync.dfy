// The verified resync (#1019, docs/design/verified-core.md §4, SPEC.md §8
// "Divergence"): the step the shell runs on the server's divergence signal
// after a restore from backup, before the device's next round (ShellRun).
//
// The resync changes only the device's journal and touches no file, so it
// needs no intent (IntentsCoverDiskEffects holds with no disk effect):
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
include "../spec/Contracts.dfy"

abstract module ResyncCore refines StepContracts {

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

  function BaseOf(r: Revision): Base {
    Base(r.id, r.position, r.path, r.content, r.kind, r.deleted)
  }

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

  ghost function ResyncStepOf(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs): Step
  {
    if pre.devices[d].journal.documents.Keys <= revs.Keys then
      var journal' := ResyncJournal(pre.server, d, pre.devices[d].journal, revs);
      Step(pre, Resync(d), [PersistJournal(journal')], After(pre, d, journal'))
    else Step(pre, Resync(d), [], pre)
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
    ensures var step := ResyncStepOf(pre, d, input, revs);
      step.pre == pre && step.event == Resync(d)
      && d in step.post.devices && step.post.devices[d].journal.cursor == |pre.server.feed|
      && IntentsCoverDiskEffects(step.effects)
  {
    var step := ResyncStepOf(pre, d, input, revs);
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
    ensures var post := ResyncStepOf(pre, d, input, revs).post;
      CommitsOnBase(post) && OutboxParentsAccepted(post)
  {
    var post := ResyncStepOf(pre, d, input, revs).post;
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
    ensures var step := ResyncStepOf(pre, d, input, revs);
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
    var step := ResyncStepOf(pre, d, input, revs);
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
    ensures var step := ResyncStepOf(pre, d, input, revs);
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
    ensures var step := ResyncStepOf(pre, d, input, revs);
      G1_Retained(step.post) && G1_LatestNeverPurged(step.post)
      && G5_NeverJoined(step.post) && G7_OneFilePerName(step.post)
    ensures var step := ResyncStepOf(pre, d, input, revs);
      CoreInv(step.post) && ServerRetains(step.post) && StepGuarantees(step)
      && (!FinishedSyncing(step.post, d) ==> MirrorInv(step.post) && StateInvariants(step.post))
  {
    var step := ResyncStepOf(pre, d, input, revs);
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
    ensures var post := ResyncStepOf(pre, d, input, revs).post;
      FeedPositioned(post.server) && ClaimsCoverCursor(post)
      && HistoryFollowsFeed(post.server) && RevisionsAccepted(post.server) && JournalsNameAccepted(post)
      && FeedAccepted(post.server) && RevisionsKeyed(post.server) && CutsHeadsApart(post.server)
      && ScopesClosedUnderF(post) && OwnDocsKnown(post) && ReadsFeed(post, d) && !Diverged(post, d)
      && (forall x :: ReadsFeed(post, x) ==> OwnRevisionsAcknowledged(post, x))
  {
    var step := ResyncStepOf(pre, d, input, revs);
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
    ensures JournalsNameAccepted(ResyncStepOf(pre, d, input, revs).post)
  {
    var post := ResyncStepOf(pre, d, input, revs).post;
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

  // The resync keeps every invariant: ClaimsCore from the lemmas above,
  // MirrorInv and MirrorAtCursor from ClaimsImplyMirrorContract (proven by
  // ClaimsMirror.ClaimsImplyMirror, #1078; this module cannot refine
  // ClaimsMirror, Dafny 4.11's resolver crashes). A device the resync leaves
  // finished mirrors the heads by the contract at OthersStopped, where it
  // is the only finished device.
  lemma {:isolate_assertions} ResyncKeepsAll(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires ClaimsImplyMirrorContract()
    ensures ResyncContract(pre, d, input, revs)
  {
    if d in pre.devices && pre.devices[d].running && CoreReachable(pre)
       && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs) {
      var step := ResyncStepOf(pre, d, input, revs);
      var post := step.post;
      ResyncReadsFeed(pre, d, input, revs);
      ResyncRowsHold(pre, d, input, revs);
      ResyncGuarantees(pre, d, input, revs);
      ResyncClaims(pre, d, input, revs);
      ResyncKeepsBindings(pre, d, input, revs);
      ResyncCommitsOnBase(pre, d, input, revs);
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
}
