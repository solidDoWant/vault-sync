// The verified resync (#1019, docs/design/verified-core.md §4, SPEC.md §8
// "Divergence"): the step the shell runs on the server's divergence signal
// after a restore from backup, before the device's next round (ShellRun).
//
// The resync changes only the device's journal and touches no file, so it
// needs no intent (IntentsCoverDiskEffects holds with no disk effect):
// 1. Re-anchor (ResyncRow). A base or ahead the server no longer holds is
//    dropped. The base becomes the newest revision of the document the
//    server holds that this device synced: its kept base, or a later
//    revision of its own that is not its commit in flight (SPEC.md §8: the
//    own-commit anchor). With none, the row has no base. CoreInv then makes
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

  // A revision of `doc` the server holds that device `d` wrote and that is
  // not the row's commit in flight (or its unsent outbox).
  predicate OwnSynced(server: Server, d: DeviceId, doc: DocId, document: Document, id: RevId) {
    doc in server.history && id in server.history[doc] && id in server.revisions
    && server.revisions[id].device == d
    && (document.outbox.None? || document.outbox.value.rev != id)
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

  // The base the resync leaves: the kept base, or the own anchor where it is
  // newer.
  function ResyncBase(server: Server, d: DeviceId, doc: DocId, document: Document): Option<Base> {
    var kept := if document.base.Some? && document.base.value.rev in server.revisions then document.base else None;
    var own := OwnAnchor(server, d, doc, document);
    if own.Some? && (kept.None? || kept.value.position < server.revisions[own.value].position)
    then Some(BaseOf(server.revisions[own.value]))
    else kept
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
      // An unsent outbox is sent on the new base.
      row.(outbox := Some(document.outbox.value.(baseRev := parent)))
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
    if document.outbox.Some? && document.outbox.value.rev == id {
      assert row.outbox.Some? && row.outbox.value.rev == id;
    } else {
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
                && pre.server.revisions[journal'.documents[doc].base.value.rev].device == d))
      && journal'.intents == journal.intents
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

  // A resync settles no conflict: every base it sets is the row's own, or a
  // revision of this device's.
  lemma {:isolate_assertions} ResyncGuarantees(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RevsCover(pre.devices[d].journal, input, revs) && CoreReachable(pre)
    ensures var step := ResyncStepOf(pre, d, input, revs);
      StateInvariants(step.post) || FinishedSyncing(step.post, d)
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
    assert G5_NeverMixedUp(step);
    assert G3_DeleteSeen(step);
    // G6: every base the resync sets is the row's, or this device's own
    // revision, so it settles nothing.
    forall x, doc, remote | SettlesConcurrent(step, x, doc, remote)
      ensures G6_Settle(step, x, doc, remote)
    {
      assert x == d;
      assert doc in journal.documents;
      assert pre.server.accepted[remote.id] == remote;
      assert false;
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
}
