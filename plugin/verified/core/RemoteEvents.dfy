// The verified core's handling of remote revisions and push results (#949,
// docs/design/verified-core.md §3.5). It builds on the local core (#948):
// the same step shape (only the event's device's journal is replaced, disks
// follow the effects, the server follows the event) and the same invariant
// CoreInv.
//
// - A remote revision newer than everything the device knows of its document
//   is recorded as the document's `ahead`; the core requests no disk effect
//   for it yet. Applying it to disk needs the single path-conflict function
//   (#962) in the sync round (#982).
// - A push result answers the document's sealed outbox (the commit in
//   flight). An accept makes the revision the document's base and keeps an
//   outbox only for a change made after the commit was sealed; a refusal or
//   "unavailable" unseals the outbox, which then carries the document as the
//   device last saw it (OutboxCurrent), to be sent again.
//
// It also states the invariant behind G9 (#992, §3.7): a finished device's
// in-scope files mirror the server's live heads (MirrorInv).
//
// Its proofs pick witnesses with `var x := var x0 :| P(x0); x0;`, as
// LocalEvents.dfy explains: the push half (Push.dfy, #991) refines this
// module, and Dafny 4.11's precedence linter crashes on the statement form
// in a refining module.
include "LocalEvents.dfy"

abstract module RemoteCore {
  import opened L : LocalCore
  import opened L.P

  // ---------------------------------------------------------------------
  // Remote revisions (compiled)
  // ---------------------------------------------------------------------

  // The newest server position of a document the device knows: its ahead,
  // else its base.
  function KnownPosition(document: Document): Option<nat> {
    if document.ahead.Some? then Some(document.ahead.value.revision.position)
    else if document.base.Some? then Some(document.base.value.position)
    else None
  }

  // The revision is newer than everything the device knows of its document.
  predicate Newer(document: Document, revision: Revision) {
    KnownPosition(document).None? || KnownPosition(document).value < revision.position
  }

  // The device has a change of the document the server has not got (in the
  // journal: something to send, or a user's delete).
  predicate JournalChange(document: Document) {
    document.outbox.Some? || document.absence == UserDeleted
  }

  // Why a newer revision waits: local changes, or (for now) the apply that
  // needs the path rule of #962 in the sync round (#982), marked postponed.
  function Waiting(document: Document, revision: Revision): Ahead {
    if JournalChange(document) then Ahead(revision, LocalChanges, false)
    else Ahead(revision, PathHeld, true)
  }

  // One document's row after a remote revision of it.
  function RemoteDoc(document: Document, revision: Revision): Document {
    if Newer(document, revision) then document.(ahead := Some(Waiting(document, revision)))
    else document
  }

  function RemoteJournal(journal: Journal, revision: Revision): Journal {
    var doc := revision.doc;
    var document := if doc in journal.documents then journal.documents[doc]
                    else Document(None, None, None, Never, None);
    var document' := RemoteDoc(document, revision);
    if doc !in journal.documents && document' == document then journal
    else journal.(documents := journal.documents[doc := document'])
  }

  // The core's answer to a remote revision: the new journal, and the effects.
  function OnRemote(journal: Journal, revision: Revision): (Journal, seq<Effect>) {
    var journal' := RemoteJournal(journal, revision);
    (journal', [PersistJournal(journal')])
  }

  // ---------------------------------------------------------------------
  // Push results (compiled)
  // ---------------------------------------------------------------------

  predicate InFlight(document: Document) {
    document.outbox.Some? && document.outbox.value.sealed
  }

  // A commit that did not land: the outbox is unsealed and carries the
  // document as the device last saw it (its file's name and content, or the
  // user's delete), to be sent again. `rejected` marks a commit the server
  // refused as invalid (SPEC.md §6.2); a later local change clears it (Send).
  function Reopen(document: Document, rejected: bool): Document
    requires InFlight(document)
  {
    var o := document.outbox.value;
    var o' :=
      if document.binding.Some? then
        o.(path := document.binding.value.spelling, content := document.binding.value.seen, deleted := false)
      else if document.absence == UserDeleted then o.(deleted := true)
      else o;
    document.(outbox := Some(o'.(sealed := false, rejected := rejected)))
  }

  // The outbox after an accept of revision r: none if r carries the document
  // as the device last saw it, otherwise a new one, on top of r, with the
  // change made after the commit was sealed.
  function AfterAccept(document: Document, r: Revision, nextRev: RevId): Option<Outbox> {
    if document.binding.Some? then
      var b := document.binding.value;
      if b.seen == r.content && b.spelling == r.path && !r.deleted then None
      else Some(Outbox(nextRev, Some(r.id), b.spelling, b.seen, r.kind, false, false, false))
    else if document.absence == UserDeleted && !r.deleted then
      Some(Outbox(nextRev, Some(r.id), r.path, r.content, r.kind, true, false, false))
    else None
  }

  function Accept(document: Document, r: Revision, nextRev: RevId): Document {
    document.(base := Some(Base(r.id, r.position, r.path, r.content, r.kind, r.deleted)),
              ahead := if document.ahead.Some? && document.ahead.value.revision.position <= r.position
                       then None else document.ahead,
              outbox := AfterAccept(document, r, nextRev))
  }

  // One document's row after a push result. `nextRev` is the revision id the
  // shell assigns to an outbox the accept opens.
  function PushedDoc(doc: DocId, document: Document, result: PushResult, nextRev: RevId): Document {
    if !InFlight(document) then document
    else match result
      case Accepted(d, r) =>
        if d == doc && r.id == document.outbox.value.rev then Accept(document, r, nextRev) else document
      case HeadMoved(d) => if d == doc then Reopen(document, false) else document
      case AlreadyExists(d) => if d == doc then Reopen(document, false) else document
      case InvalidArgument(d) => if d == doc then Reopen(document, true) else document
      // Every commit in flight is answered "unavailable".
      case Unavailable => Reopen(document, false)
  }

  function PushedJournal(journal: Journal, result: PushResult, nextRev: RevId): Journal {
    journal.(documents := map doc | doc in journal.documents :: PushedDoc(doc, journal.documents[doc], result, nextRev))
  }

  function OnPushed(journal: Journal, result: PushResult, nextRev: RevId): (Journal, seq<Effect>) {
    var journal' := PushedJournal(journal, result, nextRev);
    (journal', [PersistJournal(journal')])
  }

  // ---------------------------------------------------------------------
  // The core's view of the server, and the row invariant
  // ---------------------------------------------------------------------

  // What the proofs of push results need of the server, beyond
  // StateInvariants (verified-core.md §3.5). Every reachable state must
  // satisfy it; #950 (restore, purge) and #966 (whole runs) must keep it.
  // - no device has read past the feed;
  // - the server's history and purges name only revisions it holds;
  // - every accepted revision is in the history, or its bytes are in a file
  //   on some device, or retention purged it (and it is no head). This is
  //   G1_Retained without "the content of some live head": that way out
  //   does not survive a later accept of that head's document.
  ghost predicate ServerInv(state: State) {
    (forall d :: d in state.devices ==> state.devices[d].journal.cursor <= |state.server.feed|)
    && state.server.purged <= state.server.revisions.Keys
    && (forall doc, rev :: doc in state.server.history && rev in state.server.history[doc] ==> rev in state.server.revisions)
    && (forall rev :: rev in state.server.accepted ==>
          InHistory(state.server, rev)
          || (!state.server.accepted[rev].deleted
              && exists d :: d in state.devices && OnDisk(state.devices[d], state.server.accepted[rev].content))
          || (rev in state.server.purged && !IsHead(state.server, rev)))
  }

  lemma InitialServerInv(platforms: map<DeviceId, Platform>)
    ensures ServerInv(Initial(platforms))
  {}

  // A step that changes only a journal's documents keeps ServerInv: local
  // events and the scan (#948) are such steps.
  lemma JournalOnlyKeepsServerInv(pre: State, d: DeviceId, journal': Journal)
    requires d in pre.devices && ServerInv(pre)
    requires journal' == pre.devices[d].journal.(documents := journal'.documents)
    ensures ServerInv(After(pre, d, journal'))
  {
    var post := After(pre, d, journal');
    forall rev | rev in post.server.accepted && exists x :: x in pre.devices && OnDisk(pre.devices[x], pre.server.accepted[rev].content)
      ensures exists x :: x in post.devices && OnDisk(post.devices[x], post.server.accepted[rev].content)
    {
      var x := var x0 :| x0 in pre.devices && OnDisk(pre.devices[x0], pre.server.accepted[rev].content); x0;
      assert OnDisk(post.devices[x], post.server.accepted[rev].content);
    }
  }

  lemma LocalKeepsServerInv(pre: State, d: DeviceId, local: LocalEvent, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys && ServerInv(pre)
    ensures ServerInv(LocalStep(pre, d, local, revs).post)
  {
    var device := pre.devices[d];
    var input := map p | p in LocalEventPaths(local) :: ReadAt(device, p);
    JournalOnlyKeepsServerInv(pre, d, LocalJournal(device.platform, device.journal, local, input, revs));
  }

  lemma ScanKeepsServerInv(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys && ServerInv(pre)
    requires ListingDistinct(pre.devices[d].platform, ListingOf(pre.devices[d]))
    ensures ServerInv(ScanStep(pre, d, revs).post)
  {
    var device := pre.devices[d];
    JournalOnlyKeepsServerInv(pre, d, ScanJournal(device.platform, device.journal, ListingOf(device), revs));
  }

  // CoreInv, one row at a time.
  ghost predicate RowInv(document: Document) {
    ((document.binding.None? && document.absence == UserDeleted) ==>
      document.outbox.Some? || (document.base.Some? && document.base.value.deleted))
    && (AheadOfBase(document) ==> document.outbox.Some?)
    && OutboxCurrent(document)
  }

  lemma CoreInvRows(state: State)
    ensures CoreInv(state) <==>
      forall d, doc :: d in state.devices && doc in state.devices[d].journal.documents ==>
        RowInv(state.devices[d].journal.documents[doc])
  {}

  // ---------------------------------------------------------------------
  // The steps
  // ---------------------------------------------------------------------

  ghost function RemoteStep(pre: State, d: DeviceId, revision: Revision): Step
    requires d in pre.devices
  {
    var answer := OnRemote(pre.devices[d].journal, revision);
    Step(pre, RemoteRevision(d, revision), answer.1, After(pre, d, answer.0))
  }

  // A push result other than an accept leaves the server as it is.
  ghost function RefusedStep(pre: State, d: DeviceId, result: PushResult, nextRev: RevId): Step
    requires d in pre.devices && !result.Accepted?
  {
    var answer := OnPushed(pre.devices[d].journal, result, nextRev);
    Step(pre, Pushed(d, result), answer.1, After(pre, d, answer.0))
  }

  // An accept appends the revision to the server (ServerFollowsEvent).
  ghost function AcceptStep(pre: State, d: DeviceId, doc: DocId, r: Revision, nextRev: RevId): Step
    requires d in pre.devices
  {
    var answer := OnPushed(pre.devices[d].journal, Accepted(doc, r), nextRev);
    var mid := After(pre, d, answer.0);
    Step(pre, Pushed(d, Accepted(doc, r)), answer.1, mid.(server := Appended(pre.server, doc, r)))
  }

  // What an accept step needs of the world: the server accepted exactly the
  // device's commit in flight, on the head it was based on (the
  // preconditions of ServerFollowsEvent's accept clause).
  ghost predicate AcceptHappens(pre: State, d: DeviceId, doc: DocId, r: Revision) {
    d in pre.devices && doc in pre.devices[d].journal.documents
    && var outbox := pre.devices[d].journal.documents[doc].outbox;
    outbox.Some? && outbox.value.sealed
    && r.id == outbox.value.rev && r.parent == outbox.value.baseRev
    && r.path == outbox.value.path && r.content == outbox.value.content
    && r.kind == outbox.value.kind && r.deleted == outbox.value.deleted
    && r.device == d
    && Appendable(pre.server, doc, r)
  }

  // ---------------------------------------------------------------------
  // The theorems
  // ---------------------------------------------------------------------

  lemma RemoteRevisionSafe(pre: State, d: DeviceId, revision: Revision)
    requires d in pre.devices
    requires StateInvariants(pre) && CoreInv(pre) && ServerInv(pre)
    // The revision is one on the server's feed (ServerFollowsEvent).
    requires revision.id in pre.server.revisions && pre.server.revisions[revision.id] == revision
    requires revision.id in pre.server.feed
    ensures var step := RemoteStep(pre, d, revision);
      StateInvariants(step.post) && CoreInv(step.post) && ServerInv(step.post) && StepGuarantees(step)
      && KeepsFinished(step)
  {
    var step := RemoteStep(pre, d, revision);
    var journal := pre.devices[d].journal;
    var journal' := RemoteJournal(journal, revision);
    assert step.post == After(pre, d, journal');
    assert step.effects == [PersistJournal(journal')];
    CoreInvRows(pre);
    forall doc | doc in journal'.documents
      ensures doc in journal.documents ==> QuietRow(journal.documents[doc], journal'.documents[doc])
      ensures doc !in journal.documents ==> NewAheadRow(journal'.documents[doc])
    {
      if doc in journal.documents {
        assert RowInv(journal.documents[doc]);
      }
    }
    QuietStep(step, d, journal');
  }

  lemma RefusedSafe(pre: State, d: DeviceId, result: PushResult, nextRev: RevId)
    requires d in pre.devices && !result.Accepted?
    requires StateInvariants(pre) && CoreInv(pre) && ServerInv(pre)
    ensures var step := RefusedStep(pre, d, result, nextRev);
      StateInvariants(step.post) && CoreInv(step.post) && ServerInv(step.post) && StepGuarantees(step)
      && KeepsFinished(step)
  {
    var step := RefusedStep(pre, d, result, nextRev);
    var journal := pre.devices[d].journal;
    var journal' := PushedJournal(journal, result, nextRev);
    assert step.post == After(pre, d, journal');
    CoreInvRows(pre);
    forall doc | doc in journal'.documents
      ensures doc in journal.documents ==> QuietRow(journal.documents[doc], journal'.documents[doc])
    {
      assert RowInv(journal.documents[doc]);
    }
    QuietStep(step, d, journal');
  }

  lemma AcceptSafe(pre: State, d: DeviceId, doc: DocId, r: Revision, nextRev: RevId)
    requires AcceptHappens(pre, d, doc, r)
    requires StateInvariants(pre) && CoreInv(pre) && ServerInv(pre)
    ensures var step := AcceptStep(pre, d, doc, r, nextRev);
      StateInvariants(step.post) && CoreInv(step.post) && ServerInv(step.post) && StepGuarantees(step)
      && KeepsFinished(step)
  {
    var step := AcceptStep(pre, d, doc, r, nextRev);
    var journal := pre.devices[d].journal;
    var journal' := PushedJournal(journal, Accepted(doc, r), nextRev);
    var server := pre.server;
    var server' := Appended(server, doc, r);
    var post := step.post;
    assert post == After(pre, d, journal').(server := server');
    assert step.effects == [PersistJournal(journal')];
    var before := pre.devices[d];
    var after := post.devices[d];
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}
    assert after.disk == before.disk && after.platform == before.platform;

    // Rows: only doc changes, by Accept; bindings never change.
    forall x | x in journal.documents
      ensures journal'.documents[x].binding == journal.documents[x].binding
      ensures journal'.documents[x].absence == journal.documents[x].absence
      ensures x != doc ==> journal'.documents[x] == journal.documents[x]
    {}
    assert journal'.documents[doc] == Accept(journal.documents[doc], r, nextRev);
    CoreInvRows(pre);
    CoreInvRows(post);

    // The server's heads after the append.
    forall x ensures Head(server', x) == (if x == doc then Some(r) else Head(server, x)) {
      if x != doc {
        assert x in server'.history <==> x in server.history;
        if x in server.history && |server.history[x]| > 0 {
          var last := server.history[x][|server.history[x]| - 1];
          assert last in server.revisions;
          assert last != r.id;
        }
      } else {
        assert server'.history[doc][|server'.history[doc]| - 1] == r.id;
      }
    }
    forall rev | rev in server.accepted ensures IsHead(server', rev) ==> IsHead(server, rev) {
      if IsHead(server', rev) {
        var x := var x0 :| Head(server', x0).Some? && Head(server', x0).value.id == rev; x0;
        assert x != doc;
      }
    }
    assert InHistory(server', r.id) by {
      assert r.id in server'.history[doc];
    }
    forall rev | InHistory(server, rev) ensures InHistory(server', rev) {
      var x := var x0 :| x0 in server.history && rev in server.history[x0]; x0;
      assert rev in server'.history[x];
    }

    // G1, and ServerInv's retention clause.
    forall rev | rev in server'.accepted
      ensures InHistory(server', rev)
          || (!server'.accepted[rev].deleted
              && exists x :: x in post.devices && OnDisk(post.devices[x], server'.accepted[rev].content))
          || (rev in server'.purged && !IsHead(server', rev))
    {
      if rev != r.id {
        assert rev in server.accepted;
        if exists x :: x in pre.devices && OnDisk(pre.devices[x], server.accepted[rev].content) {
          var x := var x0 :| x0 in pre.devices && OnDisk(pre.devices[x0], server.accepted[rev].content); x0;
          assert OnDisk(post.devices[x], server.accepted[rev].content);
        }
      }
    }
    assert G1_Retained(post);
    forall x | Head(server', x).Some? ensures Head(server', x).value.id !in server'.purged {
      if x == doc { assert r.id !in server.revisions; }
    }
    assert G1_LatestNeverPurged(post);
    forall rev | rev in server.accepted && rev in server'.accepted && Retrievable(pre, rev) && !Retrievable(post, rev)
      ensures rev in server.purged
    {
      if exists x :: x in pre.devices && OnDisk(pre.devices[x], server.accepted[rev].content) {
        var x := var x0 :| x0 in pre.devices && OnDisk(pre.devices[x0], server.accepted[rev].content); x0;
        assert OnDisk(post.devices[x], server.accepted[rev].content);
      }
    }
    assert G1_OnlyRetentionRemoves(step);

    // G7: disks unchanged; the new head's path collides with no other live head.
    forall doc1, doc2 | doc1 != doc2 && Head(server', doc1).Some? && Head(server', doc2).Some?
      && !Head(server', doc1).value.deleted && !Head(server', doc2).value.deleted
      ensures !CollideK(Head(server', doc1).value.path, Head(server', doc2).value.path)
    {}
    assert G7_OneFilePerName(post);

    // G9: the feed grew, so no device has finished.
    forall x | x in post.devices ensures !FinishedSyncing(post, x) {
      assert post.devices[x].journal.cursor == pre.devices[x].journal.cursor;
    }
    assert G9(post);

    // Bindings and disks are unchanged.
    forall x ensures BoundIdentity(after, x) == BoundIdentity(before, x) {
      SameBound(before, after, x);
    }
    assert G5_NeverJoined(post);
    assert G5_NeverMixedUp(step);
    assert G3_DeleteSeen(step);

    // G6: the only new base is the device's own revision.
    forall x, y, remote | SettlesConcurrent(step, x, y, remote)
      ensures G6_Settle(step, x, y, remote)
    {
      if x != d { assert false; }
      if y != doc { assert y in journal.documents; assert false; }
      assert remote.id == r.id;
      assert server'.accepted[r.id] == r;
      assert false;
    }

    // CoreInv: every row keeps RowInv.
    forall x, y | x in post.devices && y in post.devices[x].journal.documents
      ensures RowInv(post.devices[x].journal.documents[y])
    {
      if x == d && y == doc {
        AcceptRow(journal.documents[doc], r, nextRev);
      }
    }
    assert ServerInv(post);
    assert ServerFollowsEvent(step);
    var disk := before.disk;
    assert EffectTakes(before.platform, disk, PersistJournal(journal'), disk);
    assert EffectsTake(before.platform, disk, step.effects[1..], disk);
    assert EffectsTake(before.platform, disk, step.effects, disk);
  }

  // A user's delete made after a live commit was sealed survives its
  // accept: the device opens a tombstone outbox on top of the accepted
  // revision (#974 item 4). If the sealed commit was itself the tombstone,
  // the server has the delete as the document's base.
  lemma AcceptKeepsUserDelete(doc: DocId, document: Document, r: Revision, nextRev: RevId)
    requires document.binding.None? && document.absence == UserDeleted
    requires InFlight(document) && r.id == document.outbox.value.rev
    ensures var after := PushedDoc(doc, document, Accepted(doc, r), nextRev);
      after.base == Some(Base(r.id, r.position, r.path, r.content, r.kind, r.deleted))
      && (!r.deleted ==>
            after.outbox.Some? && after.outbox.value.deleted && !after.outbox.value.sealed
            && after.outbox.value.baseRev == Some(r.id))
      && (r.deleted ==> after.base.value.deleted)
  {}

  // The bound-document counterpart: an edit or a rename made after a commit
  // was sealed survives its accept, in a new unsealed outbox on top of the
  // accepted revision that carries the file as the device last saw it. The
  // row invariant forces it (AheadOfBase: the accepted revision, now the
  // base, differs from the file), so every transition must keep it (#984).
  lemma AcceptKeepsLaterChange(doc: DocId, document: Document, r: Revision, nextRev: RevId)
    requires document.binding.Some? && InFlight(document) && r.id == document.outbox.value.rev
    requires var b := document.binding.value; b.spelling != r.path || b.seen != r.content || r.deleted
    ensures var after := PushedDoc(doc, document, Accepted(doc, r), nextRev);
      after.base == Some(Base(r.id, r.position, r.path, r.content, r.kind, r.deleted))
      && after.binding == document.binding
      && after.outbox.Some? && !after.outbox.value.sealed && after.outbox.value.baseRev == Some(r.id)
      && after.outbox.value.path == document.binding.value.spelling
      && after.outbox.value.content == document.binding.value.seen
      && !after.outbox.value.deleted
  {
    AcceptRow(document, r, nextRev);
  }

  lemma AcceptRow(document: Document, r: Revision, nextRev: RevId)
    ensures RowInv(Accept(document, r, nextRev))
  {}

  lemma SameBound(before: Device, after: Device, doc: DocId)
    requires before.disk == after.disk && before.platform == after.platform
    requires forall p, q :: p in before.disk && q in before.disk && p != q ==> !CollideF(before.platform, p, q)
    requires forall x :: (x in after.journal.documents && after.journal.documents[x].binding.Some?) <==>
                         (x in before.journal.documents && before.journal.documents[x].binding.Some?)
    requires forall x :: x in before.journal.documents && before.journal.documents[x].binding.Some? ==>
                         after.journal.documents[x].binding == before.journal.documents[x].binding
    ensures BoundFile(after, doc) == BoundFile(before, doc)
  {
    if doc in before.journal.documents && before.journal.documents[doc].binding.Some? {
      var s := before.journal.documents[doc].binding.value.spelling;
      if HasFile(before, s) { SameFileOnSameDisk(before, after, s); }
    }
  }

  // ---------------------------------------------------------------------
  // Steps that leave the server and the disks as they are
  // ---------------------------------------------------------------------

  // A row update that keeps the binding, the absence and the base, keeps
  // RowInv, and leaves the device unfinished (an outbox to send, or a
  // waiting revision it can hold).
  ghost predicate QuietRow(before: Document, after: Document) {
    after == before
    || (after.binding == before.binding && after.absence == before.absence && after.base == before.base
        && RowInv(after)
        && (after.outbox.Some? || (after.ahead.Some? && !CannotHold(after.ahead.value.blocker))))
  }

  // A new row that only records a waiting server revision.
  ghost predicate NewAheadRow(after: Document) {
    after.base.None? && after.binding.None? && after.absence == Never && after.outbox.None?
    && after.ahead.Some? && !CannotHold(after.ahead.value.blocker)
  }

  // A step whose post is pre with d's journal replaced by `journal'`, whose
  // only effect persists the journal, whose server follows the event by
  // staying as it is, and which changes rows only as QuietRow allows, keeps
  // every invariant and satisfies every step predicate.
  lemma QuietStep(step: Step, d: DeviceId, journal': Journal)
    requires d in step.pre.devices && EventDevice(step.event) == Some(d)
    requires step.event.RemoteRevision? || (step.event.Pushed? && !step.event.result.Accepted?)
    requires step.event.RemoteRevision? ==>
      step.event.revision.id in step.pre.server.revisions
      && step.pre.server.revisions[step.event.revision.id] == step.event.revision
      && step.event.revision.id in step.pre.server.feed
    requires step.post == After(step.pre, d, journal') && step.effects == [PersistJournal(journal')]
    requires StateInvariants(step.pre) && CoreInv(step.pre) && ServerInv(step.pre)
    requires var journal := step.pre.devices[d].journal;
      journal.documents.Keys <= journal'.documents.Keys
      && journal' == journal.(documents := journal'.documents)
      && (forall doc :: doc in journal.documents ==> QuietRow(journal.documents[doc], journal'.documents[doc]))
      && (forall doc :: doc in journal'.documents && doc !in journal.documents ==> NewAheadRow(journal'.documents[doc]))
    ensures StateInvariants(step.post) && CoreInv(step.post) && ServerInv(step.post) && StepGuarantees(step)
    ensures KeepsFinished(step)
  {
    var pre := step.pre;
    var post := step.post;
    var journal := pre.devices[d].journal;
    var before := pre.devices[d];
    var after := post.devices[d];
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
    assert ServerInv(post);
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
    // G6: no base changes, so no step settles anything.
    forall x, doc, remote | SettlesConcurrent(step, x, doc, remote)
      ensures G6_Settle(step, x, doc, remote)
    {
      assert x == d;
      assert doc in journal.documents;
      assert false;
    }
    // CoreInv: every row keeps RowInv.
    CoreInvRows(pre);
    forall x, y | x in post.devices && y in post.devices[x].journal.documents
      ensures RowInv(post.devices[x].journal.documents[y])
    {
      if x == d && y in journal.documents {
        assert QuietRow(journal.documents[y], journal'.documents[y]);
      }
    }
    CoreInvRows(post);
    // G9: either nothing changed, or d is not finished.
    if journal' == journal {
      assert post == pre;
      AfterKeepsFinished(step, d, journal');
    } else {
      assert exists doc :: doc in journal'.documents && (doc !in journal.documents || journal'.documents[doc] != journal.documents[doc]) by {
        if forall doc :: doc in journal'.documents ==> doc in journal.documents && journal'.documents[doc] == journal.documents[doc] {
          assert journal'.documents == journal.documents;
          assert journal' == journal;
        }
      }
      var doc := var doc0 :| doc0 in journal'.documents && (doc0 !in journal.documents || journal'.documents[doc0] != journal.documents[doc0]); doc0;
      assert !FinishedSyncing(post, d);
      AfterKeepsFinished(step, d, journal');
      forall d1, d2, p | FinishedSyncing(post, d1) && FinishedSyncing(post, d2)
        && p in post.devices[d1].disk && p !in post.devices[d1].outOfScope && p !in post.devices[d2].outOfScope
        ensures (exists q :: q in post.devices[d2].disk
                   && (SameNameModuloFolders(post.devices[d1].platform, p, q) || SameNameModuloFolders(post.devices[d2].platform, p, q))
                   && post.devices[d2].disk[q].content == post.devices[d1].disk[p].content)
                || ReportedCannotHold(post, post.devices[d2], p)
      {
        assert d1 != d && d2 != d;
        assert FinishedSyncing(pre, d1) && FinishedSyncing(pre, d2);
      }
    }
    assert ServerFollowsEvent(step);
    // DisksFollowEffects: the one effect leaves the disk as it is.
    var disk := before.disk;
    assert EffectTakes(before.platform, disk, PersistJournal(journal'), disk);
    assert EffectsTake(before.platform, disk, step.effects[1..], disk);
    assert EffectsTake(before.platform, disk, step.effects, disk);
  }

  // ---------------------------------------------------------------------
  // The mirror invariant behind G9 (#992, verified-core.md §3.7)
  // ---------------------------------------------------------------------

  // A device that has finished syncing mirrors the server's live heads. Two
  // devices that mirror the same server agree with each other, which is G9.
  // The invariant holds initially and every transition of the core so far
  // keeps it: local events and the start-up scan (#948), remote revisions and
  // push results (#949), with CoreInv as #984 left it. None of them makes a
  // device finish (KeepsFinished). The sync round, the step that finishes a
  // device, is assumed to keep it until #982 proves that it does.

  // A document the server has live, and its head.
  ghost predicate LiveHead(server: Server, doc: DocId) {
    Head(server, doc).Some? && !Head(server, doc).value.deleted
  }

  // Every in-scope file on the device holds the content of a live head
  // whose path is exactly the file's name.
  ghost predicate FilesMirrorHeads(state: State, device: Device) {
    forall p :: p in device.disk && p !in device.outOfScope ==>
      exists doc :: LiveHead(state.server, doc)
        && Head(state.server, doc).value.path == p
        && Head(state.server, doc).value.content == device.disk[p].content
  }

  // Every live head is on the device: a file at exactly its path holds its
  // content, or its path is one the device does not sync, or the device
  // reports that it cannot hold it (G9's exceptions).
  ghost predicate HeadsMirrored(state: State, device: Device) {
    forall doc :: LiveHead(state.server, doc) ==>
      var head := Head(state.server, doc).value;
      (head.path in device.disk && device.disk[head.path].content == head.content)
      || head.path in device.outOfScope
      || ReportedCannotHold(state, device, head.path)
  }

  // "A finished device's in-scope files mirror the server's live heads."
  ghost predicate MirrorInv(state: State) {
    forall d :: d in state.devices && FinishedSyncing(state, d) ==>
      FilesMirrorHeads(state, state.devices[d]) && HeadsMirrored(state, state.devices[d])
  }

  // ---------------------------------------------------------------------
  // The invariant implies G9
  // ---------------------------------------------------------------------

  // Two finished devices: a file in scope on both is on the other device,
  // with its content, under the same name, or the other device reports
  // that it cannot hold it.
  lemma MirrorG9(state: State, d1: DeviceId, d2: DeviceId, p: Path)
    requires MirrorInv(state) && FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
    requires p in state.devices[d1].disk
    requires p !in state.devices[d1].outOfScope && p !in state.devices[d2].outOfScope
    ensures var one := state.devices[d1];
      var other := state.devices[d2];
      (exists q :: q in other.disk
         && (SameNameModuloFolders(one.platform, p, q) || SameNameModuloFolders(other.platform, p, q))
         && other.disk[q].content == one.disk[p].content)
      || ReportedCannotHold(state, other, p)
  {
    var one := state.devices[d1];
    var other := state.devices[d2];
    // The file mirrors a live head at its name (d1), which d2 holds there
    // too, unless it reports it cannot hold it (p is in scope on d2).
    var doc := var doc0 :| LiveHead(state.server, doc0)
      && Head(state.server, doc0).value.path == p
      && Head(state.server, doc0).value.content == one.disk[p].content; doc0;
    var head := Head(state.server, doc).value;
    assert HeadsMirrored(state, other);
    if p in other.disk && other.disk[p].content == one.disk[p].content {
      // d2 holds it under the same name: the witness is p itself.
      SameNameModuloFoldersRefl(one.platform, p);
      assert p in other.disk && SameNameModuloFolders(one.platform, p, p)
        && other.disk[p].content == one.disk[p].content;
    } else {
      // Not out of scope on d2, so d2 reports it cannot hold it.
      assert head.path == p && p !in other.outOfScope;
      assert ReportedCannotHold(state, other, p);
    }
  }

  lemma MirrorImpliesG9(state: State)
    requires MirrorInv(state)
    ensures G9(state)
  {
    forall d1, d2, p | FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
      && p in state.devices[d1].disk
      && p !in state.devices[d1].outOfScope && p !in state.devices[d2].outOfScope
      ensures var one := state.devices[d1];
        var other := state.devices[d2];
        (exists q :: q in other.disk
           && (SameNameModuloFolders(one.platform, p, q) || SameNameModuloFolders(other.platform, p, q))
           && other.disk[q].content == one.disk[p].content)
        || ReportedCannotHold(state, other, p)
    {
      MirrorG9(state, d1, d2, p);
    }
  }

  // ---------------------------------------------------------------------
  // The invariant holds initially and every transition so far keeps it
  // ---------------------------------------------------------------------

  // Initially the server has no head and every disk is empty.
  lemma InitialMirror(platforms: map<DeviceId, Platform>)
    ensures MirrorInv(Initial(platforms))
  {}

  // A step that makes no device finish keeps the invariant: a device
  // finished after it was finished before, unchanged, on the same server.
  lemma KeepsFinishedKeepsMirror(step: Step)
    requires MirrorInv(step.pre) && KeepsFinished(step)
    ensures MirrorInv(step.post)
  {
    forall d | d in step.post.devices && FinishedSyncing(step.post, d)
      ensures FilesMirrorHeads(step.post, step.post.devices[d]) && HeadsMirrored(step.post, step.post.devices[d])
    {
      assert FinishedSyncing(step.pre, d);
      assert step.post.devices[d] == step.pre.devices[d] && step.post.server == step.pre.server;
      assert FilesMirrorHeads(step.pre, step.pre.devices[d]) && HeadsMirrored(step.pre, step.pre.devices[d]);
    }
  }

  // Local events (#948).
  lemma LocalEventKeepsMirror(pre: State, d: DeviceId, local: LocalEvent, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
    requires StateInvariants(pre) && CoreInv(pre) && MirrorInv(pre)
    ensures MirrorInv(LocalStep(pre, d, local, revs).post)
  {
    LocalEventSafe(pre, d, local, revs);
    KeepsFinishedKeepsMirror(LocalStep(pre, d, local, revs));
  }

  // The start-up scan (#948).
  lemma ScanKeepsMirror(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
    requires StateInvariants(pre) && CoreInv(pre) && MirrorInv(pre)
    ensures ListingDistinct(pre.devices[d].platform, ListingOf(pre.devices[d]))
    ensures MirrorInv(ScanStep(pre, d, revs).post)
  {
    ScanSafe(pre, d, revs);
    KeepsFinishedKeepsMirror(ScanStep(pre, d, revs));
  }

  // A remote revision delivered outside a sync round (#949).
  lemma RemoteRevisionKeepsMirror(pre: State, d: DeviceId, revision: Revision)
    requires d in pre.devices
    requires StateInvariants(pre) && CoreInv(pre) && ServerInv(pre) && MirrorInv(pre)
    requires revision.id in pre.server.revisions && pre.server.revisions[revision.id] == revision
    requires revision.id in pre.server.feed
    ensures MirrorInv(RemoteStep(pre, d, revision).post)
  {
    RemoteRevisionSafe(pre, d, revision);
    KeepsFinishedKeepsMirror(RemoteStep(pre, d, revision));
  }

  // A push refused or not answered (#949).
  lemma RefusedKeepsMirror(pre: State, d: DeviceId, result: PushResult, nextRev: RevId)
    requires d in pre.devices && !result.Accepted?
    requires StateInvariants(pre) && CoreInv(pre) && ServerInv(pre) && MirrorInv(pre)
    ensures MirrorInv(RefusedStep(pre, d, result, nextRev).post)
  {
    RefusedSafe(pre, d, result, nextRev);
    KeepsFinishedKeepsMirror(RefusedStep(pre, d, result, nextRev));
  }

  // An accepted push (#949): the feed grows, so no device is finished
  // after it.
  lemma AcceptKeepsMirror(pre: State, d: DeviceId, doc: DocId, r: Revision, nextRev: RevId)
    requires AcceptHappens(pre, d, doc, r)
    requires StateInvariants(pre) && CoreInv(pre) && ServerInv(pre) && MirrorInv(pre)
    ensures MirrorInv(AcceptStep(pre, d, doc, r, nextRev).post)
  {
    AcceptSafe(pre, d, doc, r, nextRev);
    KeepsFinishedKeepsMirror(AcceptStep(pre, d, doc, r, nextRev));
  }
}
