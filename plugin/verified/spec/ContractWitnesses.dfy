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
      ApplySettlesContract(before, after, r, Some((h, Note)), false)
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
      !ApplySettlesContract(before, held, r, Some((h, Note)), false)
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
      && ApplySettlesContract(beforeRow, afterRow, r, Some((x, Binary)), false)
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
}

