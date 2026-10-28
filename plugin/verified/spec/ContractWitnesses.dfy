// Satisfiability witnesses and rejections for the step contracts of
// Contracts.dfy (#1025). As in Witnesses.dfy, a witness shows a contract's
// hypotheses or conclusion can be met by the case it is meant to cover, so
// no correct core is ruled out; a rejection shows it excludes the failure
// its comment rules out.
include "Contracts.dfy"

abstract module StepContractWitnesses refines StepContracts {

  // ---------------------------------------------------------------------
  // CrashContract: the cut is the core's own step
  // ---------------------------------------------------------------------

  // Witnesses.dfy's crash after the first of two requested effects
  // (CrashAfterFirstEffectCutsShort), restated with the requested effects
  // being the core's round's: a crash that performed the first of them
  // meets every hypothesis CrashContract places on the cut.
  lemma CrashAfterFirstRequestedEffect(pre: State, post: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs)
    requires |RoundStepOf(pre, d, input, revs).effects| >= 2
    ensures
      var requested := RoundStepOf(pre, d, input, revs).effects;
      var step := Step(pre, Crash(d, Some(Cut(SyncRound(d), requested))), requested[..1], post);
      CrashCutsShort(step) && CutRequestedByCore(step)
  {
    var requested := RoundStepOf(pre, d, input, revs).effects;
    assert CoreRequests(pre, SyncRound(d), requested);
  }

  // A crash whose cut lists a PersistJournal of a journal other than the
  // one the core persists for a remote revision is a prefix of what it
  // lists (CrashCutsShort alone admits it), but not the core's step: it
  // fails CutRequestedByCore, so CrashContract does not admit it, and the
  // journal CrashLeaves would keep (`j`) is never one a crash can leave.
  lemma CrashOfArbitraryJournalRejected(pre: State, post: State, d: DeviceId, revision: Revision, j: Journal)
    requires d in pre.devices && j != RemoteJournal(pre.devices[d].journal, revision)
    ensures
      var step := Step(pre, Crash(d, Some(Cut(RemoteRevision(d, revision), [PersistJournal(j)]))), [PersistJournal(j)], post);
      CrashCutsShort(step) && !CutRequestedByCore(step)
  {
    var requested := [PersistJournal(j)];
    assert requested[..1] == requested;
    assert RemoteStep(pre, d, revision).effects == [PersistJournal(RemoteJournal(pre.devices[d].journal, revision))];
  }

  // The same for a local event, whose step function also takes fresh
  // revision ids: no choice of them makes the core persist a journal with
  // another cursor (a local event never moves the cursor).
  lemma CrashOfOtherCursorRejected(pre: State, post: State, d: DeviceId, local: LocalEvent, j: Journal)
    requires d in pre.devices && j.cursor != pre.devices[d].journal.cursor
    ensures
      var step := Step(pre, Crash(d, Some(Cut(Local(d, local), [PersistJournal(j)]))), [PersistJournal(j)], post);
      CrashCutsShort(step) && !CutRequestedByCore(step)
  {
    var requested := [PersistJournal(j)];
    assert requested[..1] == requested;
    forall revs: FreshRevs | pre.devices[d].journal.documents.Keys <= revs.Keys
      ensures LocalStep(pre, d, local, revs).effects != requested
    {
      var device := pre.devices[d];
      var input := map p | p in LocalEventPaths(local) :: ReadAt(device, p);
      var journal' := LocalJournal(device.platform, device.journal, local, input, revs);
      assert LocalStep(pre, d, local, revs).effects == [PersistJournal(journal')];
      assert journal'.cursor == device.journal.cursor;
    }
  }

  // CoreRequests' last arm: an event the core does not handle on a device
  // (here another crash, or a user's action) requests nothing, so a cut on
  // it fails CutRequestedByCore whatever it lists, even nothing.
  lemma CrashOfUnhandledEventRejected(pre: State, post: State, d: DeviceId, action: UserAction, requested: seq<Effect>)
    ensures !CutRequestedByCore(Step(pre, Crash(d, Some(Cut(Crash(d, None), requested))), [], post))
    ensures !CutRequestedByCore(Step(pre, Crash(d, Some(Cut(User(d, action), requested))), [], post))
  {
  }

  // ---------------------------------------------------------------------
  // ApplySettlesContract: the row after the path rule
  // ---------------------------------------------------------------------

  // A clean bound file at `p`, synced at revision `rev0`.
  function CleanRow(rev0: RevId, p: Path, h: Hash): Document {
    Document(Some(Base(rev0, 0, p, h, Note, false)), None, Some(Binding(p, h, false, None)), Never, None)
  }

  // A remote move of a clean file to `q`, a name the path rule clears (no
  // file in its way, or every one moved aside): the row after the rule
  // binds the file at `q` and takes the revision as its base, with nothing
  // left waiting, and no user must act. ApplySettlesContract holds of it.
  lemma RuledRemoteMoveSettles(rev0: RevId, rev1: RevId, doc: DocId, device: DeviceId, p: Path, q: Path, h: Hash)
    requires p != q
    ensures
      var r := Revision(rev1, doc, 1, Some(rev0), q, h, Note, false, device);
      var before := CleanRow(rev0, p, h);
      var after := Document(Some(Base(rev1, 1, q, h, Note, false)), None, Some(Binding(q, h, false, None)), Never, None);
      ApplySettlesContract(before, after, r, Some((h, Note)), false, false)
  {
  }

  // A row that holds the same move for its name (PathHeld, as
  // ApplyRevision leaves a remote move it does not place itself) where no
  // user must act fails ApplySettlesContract: the contract is about the
  // rule's row, and the rule must settle the move.
  lemma HeldRemoteMoveRejected(rev0: RevId, rev1: RevId, doc: DocId, device: DeviceId, p: Path, q: Path, h: Hash)
    requires p != q
    ensures
      var r := Revision(rev1, doc, 1, Some(rev0), q, h, Note, false, device);
      var before := CleanRow(rev0, p, h);
      var held := before.(ahead := Some(Ahead(r, PathHeld, true)));
      !ApplySettlesContract(before, held, r, Some((h, Note)), false, false)
  {
  }

  // ---------------------------------------------------------------------
  // ApplySettlesContract: the user's delete and the outbox's own revision
  // ---------------------------------------------------------------------

  // #1061 note 3's trace (regression): a live commit `rev1` of `doc` at `p`
  // is sealed and the server accepts it, but its answer is lost
  // (CommitLanded). The user then deletes the file: no binding,
  // `UserDeleted`, the outbox still sealed. The next round pulls `rev1`
  // itself. It is the outbox's acknowledgement, taken as §3.5's accept
  // (`Accept`), which keeps the user's delete and opens a tombstone outbox
  // on top of it (AcceptKeepsUserDelete). The contract holds of that row;
  // before #1061 its user's-delete clause demanded the file back here,
  // which no row meeting the acknowledgement clause and the accept could do.
  function LostAnswerDeletedRow(rev0: RevId, rev1: RevId, p: Path, h0: Hash, h1: Hash): Document {
    Document(Some(Base(rev0, 0, p, h0, Note, false)), None, None, UserDeleted,
             Some(Outbox(rev1, Some(rev0), p, h1, Note, false, true, false)))
  }

  lemma LostAnswerThenDeleteSettles(rev0: RevId, rev1: RevId, rev2: RevId, doc: DocId, d: DeviceId, p: Path, h0: Hash, h1: Hash)
    ensures
      var r := Revision(rev1, doc, 1, Some(rev0), p, h1, Note, false, d);
      var before := LostAnswerDeletedRow(rev0, rev1, p, h0, h1);
      var after := Accept(before, r, rev2);
      RowInv(before)
      && after == PushedDoc(doc, before, Accepted(doc, r), rev2)
      && after.binding.None? && after.outbox.Some? && after.outbox.value.deleted
      && ApplySettlesContract(before, after, r, None, false, false)
  {
  }

  // The settled clause still binds a remote revision (witness that it is
  // not vacuous): against the same user's delete, with the tombstone not
  // yet sealed, another device's live revision `rev2` must bring the file
  // back. A row that does, at the revision's name and with the tombstone's
  // outbox dropped, meets the contract; a row that takes the revision as its
  // base but keeps the delete fails it.
  lemma RemoteRevisionAgainstDeleteStillBinds(rev0: RevId, rev1: RevId, rev2: RevId, doc: DocId, other: DeviceId,
                                              p: Path, h0: Hash, h2: Hash)
    requires rev1 != rev2
    ensures
      var r := Revision(rev2, doc, 1, Some(rev0), p, h2, Note, false, other);
      var before := Document(Some(Base(rev0, 0, p, h0, Note, false)), None, None, UserDeleted,
                             Some(Outbox(rev1, Some(rev0), p, h0, Note, true, false, false)));
      var back := Document(Some(Base(rev2, 1, p, h2, Note, false)), None, Some(Binding(p, h2, false, None)), Never, None);
      var kept := before.(base := Some(Base(rev2, 1, p, h2, Note, false)));
      RowInv(before)
      && ApplySettlesContract(before, back, r, None, false, false)
      && !ApplySettlesContract(before, kept, r, None, false, false)
  {
  }

  // ---------------------------------------------------------------------
  // ApplySettlesContract: a commit in flight, and unsaved text at the name
  // ---------------------------------------------------------------------

  // #1061 notes 1 and 2 (rejections). Against another device's live
  // revision `rev2`, a row that drops a sealed outbox the revision does not
  // answer fails the contract, and so does a row that drops the binding of a
  // file with unsaved text at its name (here: missing from the listing,
  // recorded as the user's delete). Witness: holding the revision with the
  // row otherwise unchanged meets both clauses where a user must act.
  lemma InFlightAndUnsavedKept(rev0: RevId, rev1: RevId, rev2: RevId, doc: DocId, other: DeviceId,
                               p: Path, h0: Hash, h1: Hash, h2: Hash)
    requires rev1 != rev2
    ensures
      var r := Revision(rev2, doc, 1, Some(rev0), p, h2, Note, false, other);
      var sealed := Some(Outbox(rev1, Some(rev0), p, h1, Note, false, true, false));
      var before := Document(Some(Base(rev0, 0, p, h0, Note, false)), None, Some(Binding(p, h1, false, None)), Never, sealed);
      var dropped := Document(Some(Base(rev2, 1, p, h2, Note, false)), None, Some(Binding(p, h2, false, None)), Never, None);
      var unbound := before.(binding := None, absence := UserDeleted);
      var held := before.(ahead := Some(Ahead(r, LocalChanges, true)));
      RowInv(before)
      && !ApplySettlesContract(before, dropped, r, Some((h2, Note)), false, false)
      && !ApplySettlesContract(before, unbound, r, None, true, true)
      && ApplySettlesContract(before, held, r, None, true, true)
  {
  }

  // ---------------------------------------------------------------------
  // ApplySettlesContract and G6_Settle: a revision identical to the file
  // ---------------------------------------------------------------------

  // #1007's trace (regression): device d has `doc` bound at `n`, base rev1
  // with content `b`, and the user changed the file to `x`, a binary file
  // (so no merge can combine anything), not yet reported. Another device's
  // revision rev2 of `doc` at `n` with content `x` is accepted, and d's
  // round pulls it while the listing reads `x` at `n`. The round takes it
  // as the base and writes or copies nothing. That settles a concurrent
  // change (SettlesConcurrent holds: the file differed from the base), and
  // G6_Settle and ApplySettlesContract's identical clause both hold of it.
  // Before #1025, G6_Settle demanded a conflict copy of `x` here, which the
  // contract forbids.
  function IdenticalTraceStep(d: DeviceId, other: DeviceId, doc: DocId, rev1: RevId, rev2: RevId,
                              n: Path, b: Hash, x: Hash, platform: Platform, file: FileIdentity): Step
  {
    var r := Revision(rev2, doc, 2, Some(rev1), n, x, Binary, false, other);
    var beforeRow := Document(Some(Base(rev1, 1, n, b, Binary, false)), None, Some(Binding(n, b, false, None)), Never, None);
    var afterRow := Document(Some(Base(rev2, 2, n, x, Binary, false)), None, Some(Binding(n, x, false, None)), Never, None);
    var disk := map[n := DiskFile(x, Binary, file)];
    var journal := Journal(map[doc := beforeRow], 0, [], []);
    var journal' := Journal(map[doc := afterRow], 1, [], []);
    var server := Server(map[rev2 := r], map[doc := [rev2]], [rev2], {}, map[rev2 := r], {});
    var pre := State(map[d := Device(platform, true, journal, disk, {}, {})], server);
    var post := State(map[d := Device(platform, true, journal', disk, {}, {})], server);
    Step(pre, SyncRound(d), [PersistJournal(journal')], post)
  }

  lemma IdenticalRevisionSettlesBoth(d: DeviceId, other: DeviceId, doc: DocId, rev1: RevId, rev2: RevId,
                                     n: Path, b: Hash, x: Hash, platform: Platform, file: FileIdentity)
    requires d != other && rev1 != rev2 && x != b
    ensures
      var step := IdenticalTraceStep(d, other, doc, rev1, rev2, n, b, x, platform, file);
      var r := Revision(rev2, doc, 2, Some(rev1), n, x, Binary, false, other);
      var beforeRow := step.pre.devices[d].journal.documents[doc];
      var afterRow := step.post.devices[d].journal.documents[doc];
      SettlesConcurrent(step, d, doc, r)
      && G6_Settle(step, d, doc, r)
      && ApplySettlesContract(beforeRow, afterRow, r, Some((x, Binary)), false, false)
      // No conflict copy: every file on the device is the document's.
      && (forall p :: p in step.post.devices[d].disk ==> Tracked(step.post.devices[d], p))
  {
    var step := IdenticalTraceStep(d, other, doc, rev1, rev2, n, b, x, platform, file);
    var r := Revision(rev2, doc, 2, Some(rev1), n, x, Binary, false, other);
    var before := step.pre.devices[d];
    var after := step.post.devices[d];
    SameFIsEquivalence(platform, n, n, n);
    assert HasFile(before, n) && HasFile(after, n);
    forall q | q in before.disk && SameF(platform, q, n) ensures q == n {}
    assert FileAt(before, n) == DiskFile(x, Binary, file);
    assert FileAt(after, n) == DiskFile(x, Binary, file);
    assert BoundFile(before, doc) == Some(DiskFile(x, Binary, file));
    assert BoundFile(after, doc) == Some(DiskFile(x, Binary, file));
    assert LocalChange(before, doc);
    assert Outgoing(after, doc) == Some(x);
    assert BoundTo(after, doc, n);
  }

  // The new first case of G6_Settle has teeth: in the same trace, a round
  // that settles on the base's content `b` instead (dropping both sides'
  // identical change) fails it.
  lemma IdenticalRevisionRevertRejected(d: DeviceId, other: DeviceId, doc: DocId, rev1: RevId, rev2: RevId,
                                        n: Path, b: Hash, x: Hash, platform: Platform, file: FileIdentity)
    requires d != other && rev1 != rev2 && x != b
    ensures
      var step0 := IdenticalTraceStep(d, other, doc, rev1, rev2, n, b, x, platform, file);
      var r := Revision(rev2, doc, 2, Some(rev1), n, x, Binary, false, other);
      var reverted := step0.post.devices[d].(disk := map[n := DiskFile(b, Binary, file)]);
      var step := step0.(post := step0.post.(devices := map[d := reverted]));
      SettlesConcurrent(step, d, doc, r) && !G6_Settle(step, d, doc, r)
  {
    var step0 := IdenticalTraceStep(d, other, doc, rev1, rev2, n, b, x, platform, file);
    var reverted := step0.post.devices[d].(disk := map[n := DiskFile(b, Binary, file)]);
    var step := step0.(post := step0.post.(devices := map[d := reverted]));
    var before := step.pre.devices[d];
    SameFIsEquivalence(platform, n, n, n);
    assert HasFile(before, n) && HasFile(reverted, n);
    assert FileAt(before, n) == DiskFile(x, Binary, file);
    assert FileAt(reverted, n) == DiskFile(b, Binary, file);
    assert BoundFile(before, doc) == Some(DiskFile(x, Binary, file));
    assert BoundFile(reverted, doc) == Some(DiskFile(b, Binary, file));
    assert LocalChange(before, doc);
    assert Outgoing(reverted, doc) == Some(b);
  }

  // ---------------------------------------------------------------------
  // ServerEventContract: a restore to a device's cursor (#950's gap)
  // ---------------------------------------------------------------------

  // Under MirrorAtCursor, a restore keeps MirrorInv: a device it finishes
  // has its cursor at the restored feed's length, and the restored server
  // is a cut there, so the device mirrors it already. (This is the clause
  // of ServerEventContract that #950's trace broke; the rest of the
  // contract is #950's proof.)
  lemma RestoreKeepsMirror(step: Step)
    requires step.event.Restore? && ServerFollowsEvent(step) && step.post.devices == step.pre.devices
    requires MirrorAtCursor(step.pre)
    ensures MirrorInv(step.post)
  {
    var cut := step.post.server;
    assert EarlierServer(step.pre.server, step.event.restored);
    assert EarlierServer(step.pre.server, cut);
    assert step.pre.(server := cut) == step.post;
    forall d | d in step.post.devices && FinishedSyncing(step.post, d)
      ensures FilesMirrorHeads(step.post, step.post.devices[d]) && HeadsMirrored(step.post, step.post.devices[d])
    {
      assert step.pre.devices[d].journal.cursor == |cut.feed| <= |step.pre.server.feed|;
    }
  }

  // #950's trace (regression): device d has read one revision of the feed
  // [r1, r2] (cursor 1) and holds no row and no file, though r1 is a live
  // head. Before #1025 that state was CoreReachable, and a restore to [r1]
  // finished d while it mirrored nothing, so ServerEventContract was false.
  // It now fails MirrorAtCursor (d would be finished against the server cut
  // at its cursor and does not hold r1), so it is not CoreReachable, and
  // ServerEventContract holds of the restore from it.
  lemma RestoreTraceExcluded(
    d: DeviceId, platform: Platform, x: DocId, y: DocId, r1: Revision, r2: Revision)
    requires x != y && r1.id != r2.id && r1.doc == x && r2.doc == y && !r1.deleted && r2.deleted
    ensures
      var device := Device(platform, true, Journal(map[], 1, [], [], Some(r1.id)), map[], {}, {});
      var accepted := map[r1.id := r1, r2.id := r2];
      var pre := State(map[d := device],
        Server(accepted, map[x := [r1.id], y := [r2.id]], [r1.id, r2.id], {}, accepted));
      var restored := Server(map[r1.id := r1], map[x := [r1.id]], [r1.id], {}, map[]);
      var post := State(map[d := device], restored.(accepted := accepted, lost := {r2.id}));
      var step := Step(pre, Restore(restored), [], post);
      !MirrorAtCursor(pre) && !CoreReachable(pre) && ServerEventContract(step)
  {
    var device := Device(platform, true, Journal(map[], 1, [], [], Some(r1.id)), map[], {}, {});
    var accepted := map[r1.id := r1, r2.id := r2];
    var pre := State(map[d := device],
      Server(accepted, map[x := [r1.id], y := [r2.id]], [r1.id, r2.id], {}, accepted));
    var restored := Server(map[r1.id := r1], map[x := [r1.id]], [r1.id], {}, map[]);
    var kept: set<RevId> := set i | 0 <= i < |restored.feed| :: restored.feed[i];
    assert restored.feed[0] == r1.id;
    assert kept == {r1.id} by {
      forall id | id in kept ensures id == r1.id {}
      assert r1.id in kept;
    }
    assert Keep(pre.server.history[x], kept) == [r1.id];
    assert Keep(pre.server.history[y], kept) == [];
    assert restored.revisions == (map id | id in pre.server.revisions && id in kept :: pre.server.revisions[id]);
    assert restored.history == (map doc | doc in pre.server.history && |Keep(pre.server.history[doc], kept)| > 0
                                  :: Keep(pre.server.history[doc], kept));
    assert EarlierServer(pre.server, restored);
    var atCut := pre.(server := restored);
    assert FinishedSyncing(atCut, d);
    assert LiveHead(restored, x);
    assert !ReportedCannotHold(atCut, device, r1.path);
    assert !HeadsMirrored(atCut, device);
  }

  // ---------------------------------------------------------------------
  // SavedNextToIt: a copy the round already sends (#1025, G6 vs G10_NoLoop)
  // ---------------------------------------------------------------------

  // A copy of `x` bound to a new document whose outbox creates it is saved
  // next to the settled document; a file of `x` bound to a document the
  // server already has, with nothing to send, is not a copy.
  lemma CopyBoundToNewDocumentIsSaved(platform: Platform, p: Path, doc: DocId, rev0: RevId, rev: RevId, x: Hash, file: FileIdentity)
    ensures
      var row := Document(None, None, Some(Binding(p, x, false, None)), Never, Some(Outbox(rev, None, p, x, Binary, false, false, false)));
      SavedNextToIt(Device(platform, true, Journal(map[doc := row], 0, [], []), map[p := DiskFile(x, Binary, file)], {}, {}), x)
    ensures
      var row := Document(Some(Base(rev0, 1, p, x, Binary, false)), None, Some(Binding(p, x, false, None)), Never, None);
      !SavedNextToIt(Device(platform, true, Journal(map[doc := row], 0, [], []), map[p := DiskFile(x, Binary, file)], {}, {}), x)
  {
    SameFIsEquivalence(platform, p, p, p);
    var row := Document(None, None, Some(Binding(p, x, false, None)), Never, Some(Outbox(rev, None, p, x, Binary, false, false, false)));
    var device := Device(platform, true, Journal(map[doc := row], 0, [], []), map[p := DiskFile(x, Binary, file)], {}, {});
    assert BoundTo(device, doc, p);
    assert NewDocumentAt(device, p);
    var row' := Document(Some(Base(rev0, 1, p, x, Binary, false)), None, Some(Binding(p, x, false, None)), Never, None);
    var device' := Device(platform, true, Journal(map[doc := row'], 0, [], []), map[p := DiskFile(x, Binary, file)], {}, {});
    assert BoundTo(device', doc, p);
    assert Tracked(device', p);
    assert !NewDocumentAt(device', p);
  }

  // ---------------------------------------------------------------------
  // G8_AsIfNoCrash: existential, not universal (#1025, gap 3.11)
  // ---------------------------------------------------------------------

  // G8's former universal reading: `crashed` ends equal to EVERY crash-free
  // run with its start and outside world that finishes.
  ghost predicate UniversalAsIfNoCrash(crashed: Trace, clean: Trace) {
    |crashed| > 0 && |clean| > 0
    && crashed[0].pre == clean[0].pre
    && OutsideWorld(crashed) == OutsideWorld(clean)
    && (forall i :: 0 <= i < |clean| ==> !clean[i].event.Crash? && !clean[i].event.Restart?)
    && AllFinishedSyncing(crashed[|crashed| - 1].post)
    && AllFinishedSyncing(clean[|clean| - 1].post) ==>
      EquivModuloCopyNames(crashed[|crashed| - 1].post, clean[|clean| - 1].post)
  }

  // Regression (two devices each create `a.md`, with x and y): two
  // crash-free runs with the same start and outside world that differ only
  // in which device syncs first end with `a.md` holding x in one and y in
  // the other. No run, crashed or not, ends equal to both, so whenever the
  // crashed run finishes, the universal reading fails against one of them,
  // whatever the core does.
  lemma UniversalAsIfNoCrashUnsatisfiable(crashed: Trace, clean1: Trace, clean2: Trace, d: DeviceId, a: Path, x: Hash, y: Hash)
    requires |crashed| > 0 && |clean1| > 0 && |clean2| > 0
    requires crashed[0].pre == clean1[0].pre == clean2[0].pre
    requires OutsideWorld(crashed) == OutsideWorld(clean1) == OutsideWorld(clean2)
    requires forall i :: 0 <= i < |clean1| ==> !clean1[i].event.Crash? && !clean1[i].event.Restart?
    requires forall i :: 0 <= i < |clean2| ==> !clean2[i].event.Crash? && !clean2[i].event.Restart?
    requires AllFinishedSyncing(crashed[|crashed| - 1].post)
    requires AllFinishedSyncing(clean1[|clean1| - 1].post) && AllFinishedSyncing(clean2[|clean2| - 1].post)
    requires !IsCopyName(a) && x != y
    requires d in clean1[|clean1| - 1].post.devices && d in clean2[|clean2| - 1].post.devices
    requires a in clean1[|clean1| - 1].post.devices[d].disk && clean1[|clean1| - 1].post.devices[d].disk[a].content == x
    requires a in clean2[|clean2| - 1].post.devices[d].disk && clean2[|clean2| - 1].post.devices[d].disk[a].content == y
    ensures !(UniversalAsIfNoCrash(crashed, clean1) && UniversalAsIfNoCrash(crashed, clean2))
  {
    if UniversalAsIfNoCrash(crashed, clean1) && UniversalAsIfNoCrash(crashed, clean2) {
      var end := crashed[|crashed| - 1].post;
      var end1 := clean1[|clean1| - 1].post;
      var end2 := clean2[|clean2| - 1].post;
      assert EquivModuloCopyNames(end, end1) && EquivModuloCopyNames(end, end2);
      assert d in end.devices;
      assert a in end.devices[d].disk;
      assert end.devices[d].disk[a].content == x;
      assert end.devices[d].disk[a].content == y;
    }
  }

  // ---------------------------------------------------------------------
  // The restore window: the anchor (#1025, gap 3.9)
  // ---------------------------------------------------------------------

  // Regression: d read [r1, r2] (cursor 2, anchor r2) and holds no row; a
  // restore cut the feed to [r1] and another device committed r3, so the
  // feed is [r1, r3]. The cursor is on the feed again and the journal names
  // nothing lost, but d never read r3: only the anchor shows it, and d is
  // Diverged (its resync must come first, ShellRun).
  lemma GrownBackFeedDiverges(d: DeviceId, platform: Platform, r1: Revision, r2: Revision, r3: Revision)
    requires r2.id != r3.id
    ensures
      var device := Device(platform, true, Journal(map[], 2, [], [], Some(r2.id)), map[], {}, {});
      var server := Server(map[r1.id := r1, r3.id := r3], map[], [r1.id, r3.id], {}, map[]);
      var state := State(map[d := device], server);
      device.journal.cursor <= |server.feed| && JournalOnServer(server, device.journal)
      && !AnchorOnFeed(server, device.journal) && Diverged(state, d)
  {
  }

  // ---------------------------------------------------------------------
  // Claims cover the cursor (#1025, gap 3.7)
  // ---------------------------------------------------------------------

  // Regression: d read both revisions of `doc` (cursor 2, anchor h2), yet
  // its row's base is the older h1 with nothing ahead. The round pulls
  // nothing past the cursor, so no core could bring d to h2: the state is
  // not CoreReachable, though d is not Diverged.
  lemma StaleBaseBehindCursorExcluded(d: DeviceId, platform: Platform, doc: DocId, h1: Revision, h2: Revision, p: Path)
    requires h1.id != h2.id && h1.doc == doc && h2.doc == doc && h1.position == 0 && h2.position == 1
    ensures
      var row := Document(Some(Base(h1.id, 0, p, h1.content, h1.kind, false)), None, None, Never, None);
      var device := Device(platform, true, Journal(map[doc := row], 2, [], [], Some(h2.id)), map[], {}, {});
      var server := Server(map[h1.id := h1, h2.id := h2], map[doc := [h1.id, h2.id]], [h1.id, h2.id], {}, map[]);
      var state := State(map[d := device], server);
      !Diverged(state, d) && !ClaimsCoverCursor(state) && !CoreReachable(state)
  {
    var row := Document(Some(Base(h1.id, 0, p, h1.content, h1.kind, false)), None, None, Never, None);
    var device := Device(platform, true, Journal(map[doc := row], 2, [], [], Some(h2.id)), map[], {}, {});
    var server := Server(map[h1.id := h1, h2.id := h2], map[doc := [h1.id, h2.id]], [h1.id, h2.id], {}, map[]);
    var state := State(map[d := device], server);
    assert !Diverged(state, d);
    assert server.feed[1] == h2.id && server.revisions[h2.id] == h2;
    assert KnownPosition(row) == Some(0);
  }

  // ---------------------------------------------------------------------
  // Own revisions (#1025, gaps 3.10 and 3.13)
  // ---------------------------------------------------------------------

  // A restore from history attributed to a syncing device does not follow
  // the server's semantics: that device would hold a revision it never
  // sent, with no outbox to acknowledge it.
  lemma RestoreFromHistoryOwnedByDeviceRejected(pre: State, post: State, d: DeviceId, doc: DocId, from: RevId, r: Revision)
    requires d in pre.devices && r.device == d
    ensures !ServerFollowsEvent(Step(pre, RestoreFromHistory(doc, from, r), [], post))
  {
  }

  // A commit the server accepted whose answer was lost: d crashed right
  // after the Commit effect of its sealed outbox, and the server appended
  // it. The crash follows the server's semantics, and d's sealed outbox
  // still acknowledges the revision (OwnRevisionsAcknowledged), so its next
  // round takes the pulled revision as "accepted" (§4.1).
  lemma CrashAfterAcceptedCommit(d: DeviceId, platform: Platform, doc: DocId, o: Outbox)
    requires o.sealed && o.baseRev.None?
    ensures
      var r := Revision(o.rev, doc, 0, None, o.path, o.content, o.kind, o.deleted, d);
      var empty := Server(map[], map[], [], {}, map[]);
      var journal := Journal(map[doc := Document(None, None, None, Never, Some(o))], 0, [], []);
      var device := Device(platform, true, journal, map[], {}, {});
      var pre := State(map[d := device], empty);
      var post := State(map[d := device.(running := false)], Appended(empty, doc, r));
      var step := Step(pre, Crash(d, Some(Cut(SyncRound(d), [Commit(doc, o)]))), [Commit(doc, o)], post);
      ServerFollowsEvent(step) && OwnRevisionsAcknowledged(post, d)
  {
    var r := Revision(o.rev, doc, 0, None, o.path, o.content, o.kind, o.deleted, d);
    var empty := Server(map[], map[], [], {}, map[]);
    var journal := Journal(map[doc := Document(None, None, None, Never, Some(o))], 0, [], []);
    var device := Device(platform, true, journal, map[], {}, {});
    var pre := State(map[d := device], empty);
    var post := State(map[d := device.(running := false)], Appended(empty, doc, r));
    var step := Step(pre, Crash(d, Some(Cut(SyncRound(d), [Commit(doc, o)]))), [Commit(doc, o)], post);
    forall x ensures Head(empty, x).None? {}
    assert ParentIsHead(empty, doc, r.parent);
    assert Appendable(empty, doc, r);
    assert Commit(doc, o) in step.effects;
    assert CommitLandedAs(step, d, doc, o);
  }

  // ---------------------------------------------------------------------
  // The feed, the histories and the journals agree (#1050, settling #1031)
  // ---------------------------------------------------------------------

  // CoreReachable is satisfiable: the initial state has it.
  lemma InitialCoreReachable(platforms: map<DeviceId, Platform>)
    ensures CoreReachable(Initial(platforms))
  {
    var s := Initial(platforms);
    InitialSatisfiesInvariants(platforms);
    InitialCoreInv(platforms);
    InitialServerInv(platforms);
    InitialMirror(platforms);
    forall d: DeviceId, cut: Server | d in s.devices && !Diverged(s, d)
      && s.devices[d].journal.cursor <= |s.server.feed|
      && |cut.feed| == s.devices[d].journal.cursor && EarlierServer(s.server, cut)
      && FinishedSyncing(s.(server := cut), d)
      ensures FilesMirrorHeads(s.(server := cut), s.devices[d]) && HeadsMirrored(s.(server := cut), s.devices[d])
    {
      assert cut.history == map[];
      forall doc ensures Head(cut, doc).None? {}
    }
    forall cut: Server | EarlierServer(s.server, cut) ensures LiveHeadsApart(cut) {
      assert cut.history == map[];
      forall doc ensures Head(cut, doc).None? {}
    }
  }

  // The new clauses are not vacuous: a device that holds the head of a
  // two-revision history, read in feed order, satisfies them.
  lemma FeedOrderedHistoryWitness(d: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                                  r1: Revision, r2: Revision, p: Path)
    requires r1.id != r2.id
    requires r1 == Revision(r1.id, x, 0, None, p, r1.content, Note, false, e)
    requires r2 == Revision(r2.id, x, 1, Some(r1.id), p, r2.content, Note, true, e)
    ensures
      var row := Document(Some(Base(r2.id, 1, p, r2.content, Note, true)), None, None, Never, None);
      var device := Device(platform, true, Journal(map[x := row], 2, [], [], Some(r2.id)), map[], {}, {});
      var revisions := map[r1.id := r1, r2.id := r2];
      var server := Server(revisions, map[x := [r1.id, r2.id]], [r1.id, r2.id], {}, revisions);
      var state := State(map[d := device], server);
      HistoryFollowsFeed(server) && RevisionsAccepted(server) && JournalsNameAccepted(state)
      && FeedPositioned(server) && ClaimsCoverCursor(state)
  {
    var row := Document(Some(Base(r2.id, 1, p, r2.content, Note, true)), None, None, Never, None);
    var device := Device(platform, true, Journal(map[x := row], 2, [], [], Some(r2.id)), map[], {}, {});
    var revisions := map[r1.id := r1, r2.id := r2];
    var server := Server(revisions, map[x := [r1.id, r2.id]], [r1.id, r2.id], {}, revisions);
    var state := State(map[d := device], server);
    assert server.feed[0] == r1.id && server.feed[1] == r2.id;
    assert server.history[x][0] == r1.id && server.history[x][1] == r2.id;
  }

  // #1031's gap A (regression): x's history lists its revisions out of
  // feed order ([r2, r1], positions 1 and 0). d read the whole of x and
  // holds its head r2, a tombstone, so its claims cover its cursor; but
  // the cut at d's cursor has the live r1 as x's head, and d, finished
  // against it, holds no file of it: MirrorAtCursor fails. The history is
  // not x's feed entries in feed order, so even without MirrorAtCursor the
  // state is not reachable (ClaimsReachable fails); every other new clause
  // holds of it.
  lemma HistoryOutOfFeedOrderExcluded(d: DeviceId, e: DeviceId, platform: Platform, x: DocId, y: DocId,
                                      r1: Revision, r2: Revision, r3: Revision, p: Path, q: Path, cut: Server)
    requires d != e && x != y && |{r1.id, r2.id, r3.id}| == 3 && !CollideK(p, q)
    requires r1 == Revision(r1.id, x, 0, None, p, r1.content, Note, false, e)
    requires r2 == Revision(r2.id, x, 1, Some(r1.id), p, r2.content, Note, true, e)
    requires r3 == Revision(r3.id, y, 2, None, q, r3.content, Note, false, e)
    requires cut == Server(map[r1.id := r1, r2.id := r2], map[x := [r2.id, r1.id]], [r1.id, r2.id], {}, map[])
    ensures
      var row := Document(Some(Base(r2.id, 1, p, r2.content, Note, true)), None, None, Never, None);
      var device := Device(platform, true, Journal(map[x := row], 2, [], [], Some(r2.id)), map[], {}, {});
      var revisions := map[r1.id := r1, r2.id := r2, r3.id := r3];
      var server := Server(revisions, map[x := [r2.id, r1.id], y := [r3.id]], [r1.id, r2.id, r3.id], {}, revisions);
      var state := State(map[d := device], server);
      !Diverged(state, d) && ClaimsCoverCursor(state) && FeedPositioned(server)
      && EarlierServer(server, cut) && FinishedSyncing(state.(server := cut), d)
      && RevisionsAccepted(server) && JournalsNameAccepted(state)
      && !MirrorAtCursor(state) && !ClaimsReachable(state) && !CoreReachable(state)
  {
    var row := Document(Some(Base(r2.id, 1, p, r2.content, Note, true)), None, None, Never, None);
    var device := Device(platform, true, Journal(map[x := row], 2, [], [], Some(r2.id)), map[], {}, {});
    var revisions := map[r1.id := r1, r2.id := r2, r3.id := r3];
    var server := Server(revisions, map[x := [r2.id, r1.id], y := [r3.id]], [r1.id, r2.id, r3.id], {}, revisions);
    var state := State(map[d := device], server);
    assert !Diverged(state, d);
    forall i | 0 <= i < 2 ensures server.revisions[server.feed[i]].doc == x && server.revisions[server.feed[i]].position <= 1 {}
    var kept := set i | 0 <= i < 2 :: cut.feed[i];
    assert kept == {r1.id, r2.id} by { assert cut.feed[0] == r1.id; assert cut.feed[1] == r2.id; }
    assert server.history[x][1..] == [r1.id];
    assert server.history[x][1..][1..] == [];
    assert Keep([], kept) == [];
    assert Keep([r1.id], kept) == [r1.id];
    assert Keep(server.history[x], kept) == [r2.id, r1.id];
    assert server.history[y][1..] == [];
    assert Keep(server.history[y], kept) == [];
    assert cut.history == (map doc | doc in server.history && |Keep(server.history[doc], kept)| > 0 :: Keep(server.history[doc], kept));
    assert EarlierServer(server, cut);
    assert Head(cut, x) == Some(r1);
    assert LiveHead(cut, x);
    assert !ReportedCannotHold(state.(server := cut), device, p);
    assert !HeadsMirrored(state.(server := cut), device);
    assert FinishedSyncing(state.(server := cut), d);
    assert !MirrorAtCursor(state);
    assert server.history[x][0] == r2.id && server.history[x][1] == r1.id;
  }

  // #1031's gap B (regression): device e's journal names r, which the
  // server has not accepted, as the base of a new document x; e is
  // Diverged. d's accept of r would append it, after which e would be
  // undiverged with no claim on the feed's r0. A journal names only
  // accepted revisions, so the state before the accept is not
  // CoreReachable.
  lemma JournalNamesUnacceptedExcluded(d: DeviceId, e: DeviceId, platform: Platform, w: DocId, x: DocId,
                                       r0: Revision, r: Revision, p0: Path, p1: Path, c: Hash)
    requires d != e && w != x && r0.id != r.id && !CollideK(p0, p1)
    requires r0 == Revision(r0.id, w, 0, None, p0, r0.content, Note, false, e)
    requires r == Revision(r.id, x, 1, None, p1, c, Note, false, d)
    ensures
      var o := Outbox(r.id, None, p1, c, Note, false, true, false);
      var dev := Device(platform, true, Journal(map[w := Document(Some(Base(r0.id, 0, p0, r0.content, Note, false)), None, None, Never, None), x := Document(None, None, None, Never, Some(o))], 1, [], [], Some(r0.id)), map[], {}, {});
      var stranger := Device(platform, true, Journal(map[x := Document(Some(Base(r.id, 1, p1, c, Note, false)), None, None, Never, None)], 1, [], [], Some(r0.id)), map[], {}, {});
      var server := Server(map[r0.id := r0], map[w := [r0.id]], [r0.id], {}, map[r0.id := r0]);
      var pre := State(map[d := dev, e := stranger], server);
      var post := pre.(server := Appended(server, x, r));
      Appendable(server, x, r) && ClaimsCoverCursor(pre) && FeedPositioned(server) && Diverged(pre, e)
      && !Diverged(post, e) && !ClaimsCoverCursor(post)
      && !ClaimsReachable(pre) && !CoreReachable(pre)
  {
    var o := Outbox(r.id, None, p1, c, Note, false, true, false);
    var dev := Device(platform, true, Journal(map[w := Document(Some(Base(r0.id, 0, p0, r0.content, Note, false)), None, None, Never, None), x := Document(None, None, None, Never, Some(o))], 1, [], [], Some(r0.id)), map[], {}, {});
    var stranger := Device(platform, true, Journal(map[x := Document(Some(Base(r.id, 1, p1, c, Note, false)), None, None, Never, None)], 1, [], [], Some(r0.id)), map[], {}, {});
    var server := Server(map[r0.id := r0], map[w := [r0.id]], [r0.id], {}, map[r0.id := r0]);
    var pre := State(map[d := dev, e := stranger], server);
    var post := pre.(server := Appended(server, x, r));
    assert Head(server, x).None?;
    assert Head(server, w) == Some(r0);
    assert ParentIsHead(server, x, r.parent);
    assert Appendable(server, x, r);
    assert post.server.feed == [r0.id, r.id];
    assert !Diverged(post, e);
    assert post.server.feed[0] == r0.id && post.server.revisions[r0.id] == r0;
    assert w !in stranger.journal.documents;
    assert !ClaimsCoverCursor(post);
    assert r.id !in server.accepted;
  }

  // #950's gap 2.1 (regression): retention purged `a` (not a head), and a
  // restore to the empty feed drops it from the revisions and its purge
  // mark with it. Before #1050 RestoreRemoves counted only revisions in the
  // history, so `a` was neither purged nor lost after the restore and
  // G1_Retained failed. The restore now records `a` as lost: G1_Retained
  // and ServerRetains hold after it, and the post the old definition gave
  // (only `b` lost) is not the server's step.
  lemma RestoreAfterPurgeKeepsG1(x: DocId, a: Revision, b: Revision)
    requires a.id != b.id && a.doc == x && b.doc == x && a.position == 0 && b.position == 1
    ensures
      var accepted := map[a.id := a, b.id := b];
      var pre := State(map[], Server(accepted, map[x := [a.id, b.id]], [a.id, b.id], {a.id}, accepted));
      var restored := Server(map[], map[], [], {}, map[]);
      var post := State(map[], restored.(accepted := accepted, lost := {a.id, b.id}));
      var oldPost := State(map[], restored.(accepted := accepted, lost := {b.id}));
      ServerFollowsEvent(Step(pre, Restore(restored), [], post))
      && G1_Retained(post) && ServerRetains(post)
      && !ServerFollowsEvent(Step(pre, Restore(restored), [], oldPost))
  {
    var accepted := map[a.id := a, b.id := b];
    var pre := State(map[], Server(accepted, map[x := [a.id, b.id]], [a.id, b.id], {a.id}, accepted));
    var restored := Server(map[], map[], [], {}, map[]);
    var post := State(map[], restored.(accepted := accepted, lost := {a.id, b.id}));
    var kept: set<RevId> := set i | 0 <= i < |restored.feed| :: restored.feed[i];
    assert kept == {};
    assert Keep([b.id], kept) == [];
    assert [a.id, b.id][1..] == [b.id];
    assert Keep(pre.server.history[x], kept) == [];
    assert restored.revisions == (map id | id in pre.server.revisions && id in kept :: pre.server.revisions[id]);
    assert restored.history == (map doc | doc in pre.server.history && |Keep(pre.server.history[doc], kept)| > 0
                                  :: Keep(pre.server.history[doc], kept));
    assert EarlierServer(pre.server, restored);
    assert InHistory(pre.server, b.id) by { assert b.id in pre.server.history[x]; }
    assert RestoreRemoves(pre.server, restored) == {a.id, b.id};
  }

  // #950's gap 2.2 (regression): a diverged device d (cursor 2 past the
  // feed [r0]) has as its anchor an id the server never accepted. A
  // restore from history appends r with that id, after which d is no
  // longer Diverged but knows nothing of r0's document: ClaimsCoverCursor
  // fails. A journal's anchor names only accepted ids, so the state before
  // the restore is not reachable.
  lemma RestoreFromHistoryUndivergesExcluded(
    d: DeviceId, e: DeviceId, platform: Platform, y: DocId, r0: Revision, r: Revision)
    requires d != e && r0.id != r.id && r0.doc == y && r0.position == 0 && !r0.deleted
    requires r == Revision(r.id, y, 1, Some(r0.id), r0.path, r0.content, r0.kind, false, e)
    ensures
      var device := Device(platform, true, Journal(map[], 2, [], [], Some(r.id)), map[], {}, {});
      var pre := State(map[d := device],
        Server(map[r0.id := r0], map[y := [r0.id]], [r0.id], {}, map[r0.id := r0]));
      var step := Step(pre, RestoreFromHistory(y, r0.id, r), [], pre.(server := Appended(pre.server, y, r)));
      ServerFollowsEvent(step) && Diverged(pre, d) && !Diverged(step.post, d) && !ClaimsCoverCursor(step.post)
      && !ClaimsReachable(pre) && !CoreReachable(pre)
  {
    var device := Device(platform, true, Journal(map[], 2, [], [], Some(r.id)), map[], {}, {});
    var pre := State(map[d := device],
      Server(map[r0.id := r0], map[y := [r0.id]], [r0.id], {}, map[r0.id := r0]));
    var step := Step(pre, RestoreFromHistory(y, r0.id, r), [], pre.(server := Appended(pre.server, y, r)));
    assert Diverged(pre, d);
    assert Head(pre.server, y) == Some(r0);
    assert Appendable(pre.server, y, r);
    assert ServerFollowsEvent(step);
    var post := step.post;
    assert post.server.feed == [r0.id, r.id];
    assert !Diverged(post, d);
    assert post.server.feed[0] == r0.id && r0.id in post.server.revisions;
    assert !ClaimsCoverCursor(post);
    assert r.id !in pre.server.accepted;
  }

  // #950's gap 2.3 (regression): x's history is [a@p, b@q], y's is [c@p],
  // and the feed is [a, c, b]. Today's live heads (b at q, c at p) are
  // apart, but the cut at [a, c] has two live heads at p, so a restore to
  // it would break G7_OneFilePerName's server clause. Every cut's heads are
  // apart (CutsHeadsApart), so the state is not reachable; every other new
  // clause holds of it.
  lemma {:isolate_assertions} CollidingCutExcluded(x: DocId, y: DocId, a: Revision, b: Revision, c: Revision, p: Path, q: Path, cut: Server)
    requires x != y && |{a.id, b.id, c.id}| == 3 && !CollideK(p, q) && !CollideK(q, p)
    requires a.doc == x && a.position == 0 && a.path == p && !a.deleted
    requires c.doc == y && c.position == 1 && c.path == p && !c.deleted
    requires b.doc == x && b.position == 2 && b.path == q && !b.deleted
    requires cut == Server(map[a.id := a, c.id := c], map[x := [a.id], y := [c.id]], [a.id, c.id], {}, map[])
    ensures
      var revisions := map[a.id := a, b.id := b, c.id := c];
      var server := Server(revisions, map[x := [a.id, b.id], y := [c.id]], [a.id, c.id, b.id], {}, revisions);
      LiveHeadsApart(server) && HistoryFollowsFeed(server) && RevisionsAccepted(server) && FeedPositioned(server)
      && EarlierServer(server, cut) && !LiveHeadsApart(cut)
      && !CutsHeadsApart(server) && !ClaimsReachable(State(map[], server))
  {
    var revisions := map[a.id := a, b.id := b, c.id := c];
    var server := Server(revisions, map[x := [a.id, b.id], y := [c.id]], [a.id, c.id, b.id], {}, revisions);
    assert Head(server, x) == Some(b) && Head(server, y) == Some(c);
    forall doc | LiveHead(server, doc) ensures doc == x || doc == y {}
    assert server.feed[0] == a.id && server.feed[1] == c.id && server.feed[2] == b.id;
    assert server.history[x][0] == a.id && server.history[x][1] == b.id;
    var kept := set i | 0 <= i < 2 :: cut.feed[i];
    assert kept == {a.id, c.id} by { assert cut.feed[0] == a.id; assert cut.feed[1] == c.id; }
    assert server.history[x][1..] == [b.id];
    assert server.history[x][1..][1..] == [];
    assert Keep([], kept) == [];
    assert Keep([b.id], kept) == [];
    assert Keep(server.history[x], kept) == [a.id];
    assert server.history[y][1..] == [];
    assert Keep(server.history[y], kept) == [c.id];
    assert cut.revisions == (map id | id in server.revisions && id in kept :: server.revisions[id]);
    assert cut.history == (map doc | doc in server.history && |Keep(server.history[doc], kept)| > 0 :: Keep(server.history[doc], kept));
    assert EarlierServer(server, cut);
    assert Head(cut, x) == Some(a) && Head(cut, y) == Some(c);
    assert LiveHead(cut, x) && LiveHead(cut, y);
    assert CollideK(p, p);
    assert !LiveHeadsApart(cut);
    assert !CutsHeadsApart(server);
    assert !ClaimsReachable(State(map[], server));
  }

  // ---------------------------------------------------------------------
  // #1063: a file kept under a revision the device cannot hold, and the
  // cursor and feed clauses of the server events
  // ---------------------------------------------------------------------

  // #1031's trace (regression): d read x's r1 and r2 (cursor 2), and r2 is
  // too large to download (SPEC.md §8 "Download cap": deferred too-large,
  // nothing downloaded, the cursor moves on), so d keeps r1's file at p.
  // The state is ClaimsReachable, and d is finished against the cut at its
  // cursor. Before #1063 FilesMirrorHeads, and so MirrorAtCursor, failed at
  // that cut; d now keeps p as the older file of a document whose head it
  // cannot hold (KeepsUnheld), which is G9's exception, and mirrors the cut.
  lemma {:isolate_assertions} TooLargeAheadKeepsOldFile(d: DeviceId, e: DeviceId, platform: Platform, x: DocId, y: DocId,
                                  r1: Revision, r2: Revision, r3: Revision, p: Path, q: Path, id: FileIdentity, cut: Server)
    requires d != e && x != y && |{r1.id, r2.id, r3.id}| == 3 && r1.content != r2.content
    requires !CollideK(p, q) && !CollideK(q, p)
    requires r1 == Revision(r1.id, x, 0, None, p, r1.content, Note, false, e)
    requires r2 == Revision(r2.id, x, 1, Some(r1.id), p, r2.content, Note, false, e)
    requires r3 == Revision(r3.id, y, 2, None, q, r3.content, Note, false, e)
    requires cut == Server(map[r1.id := r1, r2.id := r2], map[x := [r1.id, r2.id]], [r1.id, r2.id], {}, map[])
    ensures
      var row := Document(Some(Base(r1.id, 0, p, r1.content, Note, false)), Some(Ahead(r2, TooLarge, false)),
                          Some(Binding(p, r1.content, false, None)), Never, None);
      var device := Device(platform, true, Journal(map[x := row], 2, [], [], Some(r2.id)), map[p := DiskFile(r1.content, Note, id)], {}, {});
      var revisions := map[r1.id := r1, r2.id := r2, r3.id := r3];
      var server := Server(revisions, map[x := [r1.id, r2.id], y := [r3.id]], [r1.id, r2.id, r3.id], {}, revisions);
      var state := State(map[d := device], server);
      !Diverged(state, d) && ClaimsCoverCursor(state) && FeedPositioned(server) && FeedAccepted(server)
      && HistoryFollowsFeed(server) && RevisionsAccepted(server) && JournalsNameAccepted(state)
      && CoreInv(state) && ServerRetains(state) && MirrorInv(state)
      && (forall x0 :: x0 in state.devices && !Diverged(state, x0) ==> OwnRevisionsAcknowledged(state, x0))
      && EarlierServer(server, cut) && FinishedSyncing(state.(server := cut), d)
      && KeepsUnheld(state.(server := cut), device, p)
      && FilesMirrorHeads(state.(server := cut), device) && HeadsMirrored(state.(server := cut), device)
  {
    var row := Document(Some(Base(r1.id, 0, p, r1.content, Note, false)), Some(Ahead(r2, TooLarge, false)),
                        Some(Binding(p, r1.content, false, None)), Never, None);
    var device := Device(platform, true, Journal(map[x := row], 2, [], [], Some(r2.id)), map[p := DiskFile(r1.content, Note, id)], {}, {});
    var revisions := map[r1.id := r1, r2.id := r2, r3.id := r3];
    var server := Server(revisions, map[x := [r1.id, r2.id], y := [r3.id]], [r1.id, r2.id, r3.id], {}, revisions);
    var state := State(map[d := device], server);
    assert server.feed[0] == r1.id && server.feed[1] == r2.id && server.feed[2] == r3.id;
    assert server.history[x][0] == r1.id && server.history[x][1] == r2.id;
    assert !Diverged(state, d);
    assert JournalsNameAccepted(state) by {
      assert state.devices.Keys == {d};
      assert device.journal.documents.Keys == {x};
      assert r1.id in server.accepted && server.accepted[r1.id] == r1;
      assert r2.id in server.accepted && server.accepted[r2.id] == r2;
      assert BaseRecords(row.base.value, x, r1);
    }
    var kept := set i | 0 <= i < 2 :: cut.feed[i];
    assert kept == {r1.id, r2.id} by { assert cut.feed[0] == r1.id; assert cut.feed[1] == r2.id; }
    assert server.history[x][1..] == [r2.id];
    assert server.history[x][1..][1..] == [];
    assert Keep([], kept) == [];
    assert Keep([r2.id], kept) == [r2.id];
    assert Keep(server.history[x], kept) == [r1.id, r2.id];
    assert server.history[y][1..] == [];
    assert Keep(server.history[y], kept) == [];
    assert cut.history == (map doc | doc in server.history && |Keep(server.history[doc], kept)| > 0 :: Keep(server.history[doc], kept));
    assert EarlierServer(server, cut);
    SameNameModuloFoldersRefl(platform, p);
    SameFIsEquivalence(platform, p, p, p);
    assert BoundTo(device, x, p);
    assert InStep(device);
    assert FinishedSyncing(state.(server := cut), d);
    assert Head(cut, x) == Some(r2);
    assert KeepsUnheld(state.(server := cut), device, p);
    assert FilesMirrorHeads(state.(server := cut), device);
    forall doc | LiveHead(cut, doc) ensures doc == x {}
    assert ReportedCannotHold(state.(server := cut), device, r2.path);
    assert HeadsMirrored(state.(server := cut), device);
  }

  // The rest of ClaimsReachable for #1031's state (its trace's second
  // lemma): StateInvariants and CutsHeadsApart.
  lemma {:isolate_assertions} TooLargeStateInvariants(d: DeviceId, e: DeviceId, platform: Platform, x: DocId, y: DocId,
                                  r1: Revision, r2: Revision, r3: Revision, p: Path, q: Path, id: FileIdentity)
    requires d != e && x != y && |{r1.id, r2.id, r3.id}| == 3 && r1.content != r2.content
    requires !CollideK(p, q) && !CollideK(q, p)
    requires r1 == Revision(r1.id, x, 0, None, p, r1.content, Note, false, e)
    requires r2 == Revision(r2.id, x, 1, Some(r1.id), p, r2.content, Note, false, e)
    requires r3 == Revision(r3.id, y, 2, None, q, r3.content, Note, false, e)
    ensures
      var row := Document(Some(Base(r1.id, 0, p, r1.content, Note, false)), Some(Ahead(r2, TooLarge, false)),
                          Some(Binding(p, r1.content, false, None)), Never, None);
      var device := Device(platform, true, Journal(map[x := row], 2, [], [], Some(r2.id)), map[p := DiskFile(r1.content, Note, id)], {}, {});
      var revisions := map[r1.id := r1, r2.id := r2, r3.id := r3];
      var server := Server(revisions, map[x := [r1.id, r2.id], y := [r3.id]], [r1.id, r2.id, r3.id], {}, revisions);
      var state := State(map[d := device], server);
      StateInvariants(state) && CutsHeadsApart(server)
  {
    var row := Document(Some(Base(r1.id, 0, p, r1.content, Note, false)), Some(Ahead(r2, TooLarge, false)),
                        Some(Binding(p, r1.content, false, None)), Never, None);
    var device := Device(platform, true, Journal(map[x := row], 2, [], [], Some(r2.id)), map[p := DiskFile(r1.content, Note, id)], {}, {});
    var revisions := map[r1.id := r1, r2.id := r2, r3.id := r3];
    var server := Server(revisions, map[x := [r1.id, r2.id], y := [r3.id]], [r1.id, r2.id, r3.id], {}, revisions);
    var state := State(map[d := device], server);
    assert server.feed[0] == r1.id && server.feed[1] == r2.id && server.feed[2] == r3.id;
    assert Head(server, x) == Some(r2) && Head(server, y) == Some(r3);
    forall doc | doc != x && doc != y ensures Head(server, doc).None? {}
    forall c0 | EarlierServer(server, c0) ensures LiveHeadsApart(c0) {
      forall doc | Head(c0, doc).Some? ensures (doc == x && Head(c0, doc).value.path == p) || (doc == y && Head(c0, doc).value.path == q) {
        var h := c0.history[doc][|c0.history[doc]| - 1];
        assert h in server.revisions && c0.revisions[h] == server.revisions[h];
        var kept := set i | 0 <= i < |c0.feed| :: c0.feed[i];
        assert doc in server.history;
        KeepIn(server.history[doc], kept, |c0.history[doc]| - 1);
      }
    }
    SameNameModuloFoldersRefl(platform, p);
    SameFIsEquivalence(platform, p, p, p);
  }

  lemma KeepIn(s: seq<RevId>, ids: set<RevId>, j: nat)
    requires j < |Keep(s, ids)|
    ensures Keep(s, ids)[j] in s
  {
    if s[0] in ids {
      if j > 0 { KeepIn(s[1..], ids, j - 1); }
    } else {
      KeepIn(s[1..], ids, j);
    }
  }

  // The product outcome #1063 decided (logged on #52): d keeps r1's file
  // at p, which it cannot update, and f downloaded r2 to p. Both are
  // finished, and G9 holds: d's file is one it keeps under a revision it
  // cannot hold, and f's file is the head d reports it cannot hold.
  lemma {:isolate_assertions} TooLargeKeptFileAgrees(d: DeviceId, f: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                                  r1: Revision, r2: Revision, p: Path, id: FileIdentity)
    requires |{d, e, f}| == 3 && r1.id != r2.id && r1.content != r2.content
    requires r1 == Revision(r1.id, x, 0, None, p, r1.content, Note, false, e)
    requires r2 == Revision(r2.id, x, 1, Some(r1.id), p, r2.content, Note, false, e)
    ensures
      var stale := Document(Some(Base(r1.id, 0, p, r1.content, Note, false)), Some(Ahead(r2, TooLarge, false)),
                            Some(Binding(p, r1.content, false, None)), Never, None);
      var current := Document(Some(Base(r2.id, 1, p, r2.content, Note, false)), None,
                            Some(Binding(p, r2.content, false, None)), Never, None);
      var one := Device(platform, true, Journal(map[x := stale], 2, [], [], Some(r2.id)), map[p := DiskFile(r1.content, Note, id)], {}, {});
      var other := Device(platform, true, Journal(map[x := current], 2, [], [], Some(r2.id)), map[p := DiskFile(r2.content, Note, id)], {}, {});
      var revisions := map[r1.id := r1, r2.id := r2];
      var state := State(map[d := one, f := other], Server(revisions, map[x := [r1.id, r2.id]], [r1.id, r2.id], {}, revisions));
      FinishedSyncing(state, d) && FinishedSyncing(state, f) && MirrorInv(state)
      && G9Agrees(state, one, other, p) && G9Agrees(state, other, one, p) && G9(state)
  {
    var stale := Document(Some(Base(r1.id, 0, p, r1.content, Note, false)), Some(Ahead(r2, TooLarge, false)),
                          Some(Binding(p, r1.content, false, None)), Never, None);
    var current := Document(Some(Base(r2.id, 1, p, r2.content, Note, false)), None,
                          Some(Binding(p, r2.content, false, None)), Never, None);
    var one := Device(platform, true, Journal(map[x := stale], 2, [], [], Some(r2.id)), map[p := DiskFile(r1.content, Note, id)], {}, {});
    var other := Device(platform, true, Journal(map[x := current], 2, [], [], Some(r2.id)), map[p := DiskFile(r2.content, Note, id)], {}, {});
    var revisions := map[r1.id := r1, r2.id := r2];
    var state := State(map[d := one, f := other], Server(revisions, map[x := [r1.id, r2.id]], [r1.id, r2.id], {}, revisions));
    assert state.server.feed[1] == r2.id;
    assert Head(state.server, x) == Some(r2);
    forall doc | LiveHead(state.server, doc) ensures doc == x {}
    SameNameModuloFoldersRefl(platform, p);
    SameFIsEquivalence(platform, p, p, p);
    assert BoundTo(one, x, p) && BoundTo(other, x, p);
    assert InStep(one) && InStep(other);
    assert FinishedSyncing(state, d) && FinishedSyncing(state, f);
    assert KeepsUnheld(state, one, p);
    assert ReportedCannotHold(state, one, p);
    assert FilesMirrorHeads(state, one) && HeadsMirrored(state, one);
    assert FilesMirrorHeads(state, other) && HeadsMirrored(state, other);
    assert MirrorInv(state);
    MirrorImpliesG9(state);
  }

  // #950's gap A (regression): a diverged device's cursor (1) is past the
  // empty feed, which CoreReachable allows (#1025). A purge changes no
  // cursor, so CursorsOnFeed fails after it as before it; the contract
  // therefore concludes KeepsCursors, which holds.
  lemma PurgeWithDivergedCursor(d: DeviceId, platform: Platform)
    ensures
      var device := Device(platform, true, Journal(map[], 1, [], []), map[], {}, {});
      var pre := State(map[d := device], Server(map[], map[], [], {}, map[]));
      var step := Step(pre, Purge({}), [], pre);
      CoreReachable(pre) && ServerFollowsEvent(step)
      && !CursorsOnFeed(step.post) && KeepsCursors(step)
  {
    var device := Device(platform, true, Journal(map[], 1, [], []), map[], {}, {});
    var pre := State(map[d := device], Server(map[], map[], [], {}, map[]));
    assert Diverged(pre, d);
    assert !FinishedSyncing(pre, d);
    forall doc ensures Head(pre.server, doc).None? {}
    assert CutsHeadsApart(pre.server) by {
      forall cut | EarlierServer(pre.server, cut) ensures LiveHeadsApart(cut) {
        assert cut.feed == [];
        var kept: set<RevId> := set i | 0 <= i < |cut.feed| :: cut.feed[i];
        assert kept == {};
        forall doc ensures Head(cut, doc).None? {}
      }
    }
    assert MirrorAtCursor(pre);
    assert CoreReachable(pre);
  }

  // #950's gap B (rejection): the feed [r.id, a.id] names r.id, which the
  // server neither holds nor accepted, and a restore from history appends
  // r under that id. The cut at d's cursor then holds r as z's head, which
  // d, finished against it, does not mirror. Every feed entry is an
  // accepted id (FeedAccepted), so the state before is not reachable.
  lemma {:isolate_assertions} RestoreFromHistoryReusesUnheldFeedId(
    d: DeviceId, e: DeviceId, platform: Platform, z: DocId, a: Revision, r: Revision, p: Path, file: DiskFile)
    requires d != e && a.id != r.id && a.doc == z && a.position == 1 && !a.deleted && a.device == e
    requires file.content == a.content && a.path == p
    requires r == Revision(r.id, z, 2, Some(a.id), r.path, a.content, a.kind, false, e)
    requires !SameNameModuloFolders(platform, p, r.path)
    ensures
      var base := Base(a.id, 1, p, a.content, a.kind, false);
      var journal := Journal(map[z := Document(Some(base), None, Some(Binding(p, a.content, false, None)), Never, None)],
                             2, [], [], Some(a.id));
      var device := Device(platform, true, journal, map[p := file], {}, {});
      var pre := State(map[d := device],
        Server(map[a.id := a], map[z := [a.id]], [r.id, a.id], {}, map[a.id := a]));
      var step := Step(pre, RestoreFromHistory(z, a.id, r), [], pre.(server := Appended(pre.server, z, r)));
      ServerFollowsEvent(step) && !MirrorAtCursor(step.post)
      && !FeedAccepted(pre.server) && !ClaimsReachable(pre) && !CoreReachable(pre)
  {
    var base := Base(a.id, 1, p, a.content, a.kind, false);
    var journal := Journal(map[z := Document(Some(base), None, Some(Binding(p, a.content, false, None)), Never, None)],
                           2, [], [], Some(a.id));
    var device := Device(platform, true, journal, map[p := file], {}, {});
    var pre := State(map[d := device],
      Server(map[a.id := a], map[z := [a.id]], [r.id, a.id], {}, map[a.id := a]));
    var step := Step(pre, RestoreFromHistory(z, a.id, r), [], pre.(server := Appended(pre.server, z, r)));
    var post := step.post;
    SameNameModuloFoldersRefl(platform, p);
    assert Head(pre.server, z) == Some(a);
    assert Appendable(pre.server, z, r);
    assert ServerFollowsEvent(step);
    assert pre.server.feed[0] == r.id && r.id !in pre.server.accepted;
    assert !FeedAccepted(pre.server);

    // after: the cut at d's cursor holds r as z's head
    assert post.server.feed == [r.id, a.id, r.id];
    assert !Diverged(post, d);
    var cut := Server(map[r.id := r, a.id := a], map[z := [a.id, r.id]], [r.id, a.id], {}, map[]);
    var kept: set<RevId> := set i | 0 <= i < |cut.feed| :: cut.feed[i];
    assert cut.feed[0] == r.id && cut.feed[1] == a.id;
    assert kept == {r.id, a.id} by {
      forall id | id in kept ensures id == r.id || id == a.id {}
      assert r.id in kept && a.id in kept;
    }
    assert post.server.history[z] == [a.id, r.id];
    assert Keep([r.id], kept) == [r.id];
    assert [a.id, r.id][1..] == [r.id];
    assert Keep([a.id, r.id], kept) == [a.id, r.id];
    assert cut.revisions == (map id | id in post.server.revisions && id in kept :: post.server.revisions[id]);
    assert cut.history == (map doc | doc in post.server.history && |Keep(post.server.history[doc], kept)| > 0
                             :: Keep(post.server.history[doc], kept));
    assert EarlierServer(post.server, cut);
    assert Head(cut, z) == Some(r);
    assert InHistory(pre.server, a.id) by { assert a.id in pre.server.history[z]; }
    assert BoundTo(device, z, p);
    assert InStep(device);
    assert FinishedSyncing(post.(server := cut), d);
    assert !ReportedCannotHold(post.(server := cut), device, r.path);
    assert !HeadsMirrored(post.(server := cut), device);
    assert !MirrorAtCursor(post);
  }
}
