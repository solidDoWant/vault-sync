// Crash and restart recovery (#1018, split from #950; verified-core.md §4).
//
// A crash leaves the journal the last PersistJournal of the step it cut
// short persisted (CrashLeaves), and the disk as the performed effects left
// it. The only journals a step persists with open intents are the sync
// round's guards (SettleRevision): the rows before the revision, and one
// intent per disk effect of the revision's rule. The restart settles each
// open intent from the journal alone (Recover) and persists the result
// before the device runs again (RestartStepOf):
//
// every open intent is dropped (Recover). The guards persist the rows as
// they were before the revision, with the round's cursor not yet moved
// (#1018, option B), so dropping the intents leaves the device as if the
// round had settled only the revisions before it; the next round pulls
// again from the old cursor and settles the rest. Whatever the revision's
// half-done effects left on disk is then the device's own version of the
// file: the start-up scan after the restart records it as a local change
// (G8_PicksUpOfflineChanges), and the next round merges it with the
// revision. Either outcome of a half-done revision is acceptable (engine
// design §10.3, owner's policy: nothing is lost); a crash may therefore
// leave a conflict copy a crash-free run would not (verified-core.md §4).
// Dropping needs nothing from the intents, so an intent the invariants say
// nothing about (CoreReachable does not read intents) is harmless too.
//
// CrashInv is ClaimsCore of the state every stopped device's restart would
// leave its journal in (Recovered): a stopped device has finished nothing,
// so its intents are all a restart has left to settle.
// Dafny 4.11's resolver crashes on a module refining RoundClaimsCore, so
// this one refines PathRuleCore, which has the round's body.
include "PathRule.dfy"

abstract module RecoveryCore refines PathRuleCore {

  // ---------------------------------------------------------------------
  // The restart
  // ---------------------------------------------------------------------

  // The journal the restart persists: every open intent dropped.
  function Recover(journal: Journal): Journal {
    journal.(intents := [])
  }

  // Every stopped device as its restart would leave its journal.
  ghost function Recovered(state: State): State {
    state.(devices := map x | x in state.devices ::
      if state.devices[x].running then state.devices[x]
      else state.devices[x].(journal := Recover(state.devices[x].journal)))
  }

  ghost predicate CrashInv(state: State) {
    ClaimsCore(Recovered(state))
  }

  // The restart persists the recovered journal (nothing when no intent is
  // open) and runs the app again.
  ghost function RestartStepOf(pre: State, d: DeviceId, revs: FreshRevs): Step
  {
    var device := pre.devices[d];
    var journal' := Recover(device.journal);
    var effects := if |device.journal.intents| == 0 then [] else [PersistJournal(journal')];
    Step(pre, Restart(d), effects, pre.(devices := pre.devices[d := device.(journal := journal', running := true)]))
  }

  // ---------------------------------------------------------------------
  // Recover
  // ---------------------------------------------------------------------

  // A journal with no open intent is its own recovery.
  lemma RecoverNoIntent(journal: Journal)
    requires |journal.intents| == 0
    ensures Recover(journal) == journal
  {}

  // Recovery is idempotent.
  lemma RecoverIdempotent(journal: Journal)
    ensures Recover(Recover(journal)) == Recover(journal)
  {}

  // ---------------------------------------------------------------------
  // RecoveryContract
  // ---------------------------------------------------------------------

  lemma RestartStepFacts(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices
    ensures var step := RestartStepOf(pre, d, revs);
      step.pre == pre && step.event == Restart(d)
      && d in step.post.devices && step.post.devices[d].running
      && G8_Recovers(step)
      && (forall x :: x != d && x in pre.devices ==> x in step.post.devices && step.post.devices[x] == pre.devices[x])
  {}

  lemma RestartGuarantees(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices && !pre.devices[d].running && CrashInv(pre)
    ensures StepGuarantees(RestartStepOf(pre, d, revs))
  {
    var step := RestartStepOf(pre, d, revs);
    assert G1_OnlyRetentionRemoves(step);
    assert G2_OnlyWhatItSaw(step);
    assert G2_Conditional(step);
    assert G2_NoUntrackedDelete(step);
    assert G2_UnsavedSafe(step);
    assert G3_DeleteSeen(step);
    assert G5_RenameKeepsDocument(step);
    var before := pre.devices[d];
    var after := step.post.devices[d];
    var docs := before.journal.documents;
    var docs' := after.journal.documents;
    assert Recovered(pre).devices[d].disk == before.disk;
    assert G7_OneFilePerName(Recovered(pre));
    assert after.disk == before.disk && after.platform == before.platform;
    forall doc ensures BoundIdentity(after, doc) == BoundIdentity(before, doc) {
      if doc in docs && docs[doc].binding.Some? {
        SameFileOnSameDisk(before, after, docs[doc].binding.value.spelling);
      }
      assert BoundFile(after, doc) == BoundFile(before, doc);
    }
    assert G5_NeverMixedUp(step);
    assert forall x, doc, remote :: SettlesConcurrent(step, x, doc, remote) ==> G6_Settle(step, x, doc, remote);
    assert G7_MoveKeepsContents(step);
    assert G8_PicksUpOfflineChanges(step);
    assert G10_SettledOrReported(step);
    assert DisksFollowEffects(step);
    assert ServerFollowsEvent(step);
  }

  // ---------------------------------------------------------------------
  // Starting a device keeps the claims
  // ---------------------------------------------------------------------

  // Two states that differ only in which devices run.
  ghost predicate SameButRunning(a: State, b: State) {
    a.server == b.server && a.devices.Keys == b.devices.Keys
    && forall x :: x in a.devices ==> b.devices[x] == a.devices[x].(running := b.devices[x].running)
  }

  // ClaimsCore without G9 (Resync.dfy's CoreButG9, which this module cannot
  // see: Dafny 4.11's resolver crashes on a module refining ResyncCore's
  // siblings together).
  ghost predicate ClaimsButG9(state: State) {
    G1_Retained(state) && G1_LatestNeverPurged(state) && G5_NeverJoined(state) && G7_OneFilePerName(state)
    && CoreInv(state) && ServerRetains(state)
    && FeedPositioned(state.server) && ClaimsCoverCursor(state) && RevisionsOnFeed(state.server)
    && HistoryFollowsFeed(state.server) && RevisionsAccepted(state.server) && JournalsNameAccepted(state)
    && FeedAccepted(state.server) && RevisionsKeyed(state.server) && CutsHeadsApart(state.server)
    && ScopesClosedUnderF(state) && OwnDocsKnown(state)
    && (forall x :: ReadsFeed(state, x) ==> OwnRevisionsAcknowledged(state, x))
    && CommitsOnBase(state) && OutboxParentsAccepted(state)
  }

  // No clause but G9 reads whether a device runs.
  lemma {:isolate_assertions} ClaimsButG9Running(a: State, b: State)
    requires SameButRunning(a, b) && ClaimsButG9(a)
    ensures ClaimsButG9(b)
  {
    forall rev | rev in a.server.accepted
      ensures (exists x :: x in a.devices && OnDisk(a.devices[x], a.server.accepted[rev].content))
          <==> (exists x :: x in b.devices && OnDisk(b.devices[x], a.server.accepted[rev].content))
    {
      var version := a.server.accepted[rev];
      if exists x :: x in a.devices && OnDisk(a.devices[x], version.content) {
        var x := var x0 :| x0 in a.devices && OnDisk(a.devices[x0], version.content); x0;
        assert OnDisk(b.devices[x], version.content);
      }
      if exists x :: x in b.devices && OnDisk(b.devices[x], version.content) {
        var x := var x0 :| x0 in b.devices && OnDisk(b.devices[x0], version.content); x0;
        assert OnDisk(a.devices[x], version.content);
      }
    }
    assert G1_Retained(b);
    assert ServerRetains(b);
    assert G5_NeverJoined(b);
    assert G7_OneFilePerName(b);
    assert CoreInv(b);
    forall x | ReadsFeed(b, x) ensures OwnRevisionsAcknowledged(b, x) {
      assert ReadsFeed(a, x);
      assert OwnRevisionsAcknowledged(a, x);
      forall doc, id | Unacknowledged(b, x, doc, id)
        ensures b.devices[x].journal.documents[doc].outbox.Some?
        ensures b.devices[x].journal.documents[doc].outbox.value.rev == id
      {
        assert Unacknowledged(a, x, doc, id);
      }
    }
    forall x, doc | ReadsFeed(b, x) && doc in b.devices[x].journal.documents
      ensures OutboxParentAtBase(b.server, doc, b.devices[x].journal.documents[doc])
      ensures OwnCommitOnBase(b.server, x, doc, b.devices[x].journal.documents[doc])
    {
      assert ReadsFeed(a, x);
    }
    assert CommitsOnBase(b);
    assert OutboxParentsAccepted(b);
    assert ClaimsCoverCursor(b);
    assert JournalsNameAccepted(b);
    assert ScopesClosedUnderF(b);
    assert OwnDocsKnown(b);
  }

  // The state with only d running.
  ghost function OnlyRunning(state: State, d: DeviceId): State {
    state.(devices := map x | x in state.devices :: if x == d then state.devices[x] else state.devices[x].(running := false))
  }

  // A device as it is in another state on the same server mirrors the
  // heads if it does there.
  lemma MirrorOfSame(a: State, b: State, x: DeviceId)
    requires MirrorInv(a) && b.server == a.server
    requires x in a.devices && x in b.devices && b.devices[x] == a.devices[x]
    requires FinishedSyncing(b, x)
    ensures FilesMirrorHeads(b, b.devices[x]) && HeadsMirrored(b, b.devices[x])
  {
    assert FinishedSyncing(a, x);
    assert FilesMirrorHeads(a, a.devices[x]) && HeadsMirrored(a, a.devices[x]);
  }

  // Starting a stopped device keeps ClaimsCore: every clause but G9 reads
  // no running flag, and G9 follows from the mirror (ClaimsImplyMirrorContract):
  // the started device mirrors the heads if it is finished, as the only
  // running device of OnlyRunning does, and every other finished device
  // ran and mirrored them before.
  lemma {:isolate_assertions} StartKeepsClaims(state: State, d: DeviceId)
    requires ClaimsImplyMirrorContract()
    requires d in state.devices && ClaimsCore(state)
    ensures ClaimsCore(state.(devices := state.devices[d := state.devices[d].(running := true)]))
  {
    var post := state.(devices := state.devices[d := state.devices[d].(running := true)]);
    ClaimsButG9Running(state, post);
    var S := OnlyRunning(post, d);
    ClaimsButG9Running(state, S);
    forall d1, d2, p | FinishedSyncing(S, d1) && FinishedSyncing(S, d2)
      && p in S.devices[d1].disk && p !in S.devices[d1].outOfScope && p !in S.devices[d2].outOfScope
      ensures G9Agrees(S, S.devices[d1], S.devices[d2], p)
    {
      assert d1 == d && d2 == d;
      SameNameModuloFoldersRefl(S.devices[d].platform, p);
    }
    assert ClaimsCore(S);
    assert MirrorInv(S);
    assert MirrorInv(state);
    forall x | x in post.devices && FinishedSyncing(post, x)
      ensures FilesMirrorHeads(post, post.devices[x]) && HeadsMirrored(post, post.devices[x])
    {
      if x == d {
        MirrorOfSame(S, post, d);
      } else {
        MirrorOfSame(state, post, x);
      }
    }
    assert MirrorInv(post);
    MirrorImpliesG9(post);
  }

  // ---------------------------------------------------------------------
  // The contract
  // ---------------------------------------------------------------------

  // The restart's post-state, recovered, is the pre-state recovered with
  // the device started.
  lemma RecoveredAfterRestart(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices && !pre.devices[d].running
    ensures var post := RestartStepOf(pre, d, revs).post;
      var R := Recovered(pre);
      Recovered(post) == R.(devices := R.devices[d := R.devices[d].(running := true)])
  {
    var post := RestartStepOf(pre, d, revs).post;
    var R := Recovered(pre);
    var R' := R.(devices := R.devices[d := R.devices[d].(running := true)]);
    assert Recovered(post).devices.Keys == R'.devices.Keys;
    forall x | x in R'.devices ensures Recovered(post).devices[x] == R'.devices[x] {}
    assert Recovered(post).devices == R'.devices;
  }

  lemma {:isolate_assertions} RecoveryKeepsAll(pre: State, d: DeviceId, revs: FreshRevs)
    requires ClaimsImplyMirrorContract()
    ensures RecoveryContract(pre, d, revs)
  {
    if d in pre.devices && !pre.devices[d].running && CrashInv(pre)
       && pre.devices[d].journal.documents.Keys <= revs.Keys {
      var step := RestartStepOf(pre, d, revs);
      var post := step.post;
      RestartStepFacts(pre, d, revs);
      RestartGuarantees(pre, d, revs);
      RecoveredAfterRestart(pre, d, revs);
      StartKeepsClaims(Recovered(pre), d);
      assert ClaimsCore(Recovered(post));
      assert CrashInv(post);
    }
  }

  // ---------------------------------------------------------------------
  // Stopping devices and dropping intents keeps the claims
  // ---------------------------------------------------------------------

  // b is a with some devices stopped: a stopped device of b may have lost
  // its editors and changed its open intents; a running one is as in a.
  ghost predicate StoppedFrom(a: State, b: State) {
    a.server == b.server && a.devices.Keys == b.devices.Keys
    && forall x :: x in a.devices ==>
         if b.devices[x].running then b.devices[x] == a.devices[x]
         else b.devices[x] == a.devices[x].(running := false, editors := b.devices[x].editors,
                                            journal := a.devices[x].journal.(intents := b.devices[x].journal.intents))
  }

  // No clause of ClaimsCore reads an editor or an open intent, and G9 binds
  // only running devices: stopping devices and changing their intents keeps
  // ClaimsCore.
  lemma {:isolate_assertions} StoppedKeepsClaims(a: State, b: State)
    requires StoppedFrom(a, b) && ClaimsCore(a)
    ensures ClaimsCore(b)
  {


    ClaimsButG9Intents(a, b);
    forall d1, d2, p | FinishedSyncing(b, d1) && FinishedSyncing(b, d2)
      && p in b.devices[d1].disk && p !in b.devices[d1].outOfScope && p !in b.devices[d2].outOfScope
      ensures G9Agrees(b, b.devices[d1], b.devices[d2], p)
    {
      assert b.devices[d1] == a.devices[d1] && b.devices[d2] == a.devices[d2];
      assert FinishedSyncing(a, d1) && FinishedSyncing(a, d2);
      assert G9Agrees(a, a.devices[d1], a.devices[d2], p);
      G9AgreesSameServer(a, b, a.devices[d1], a.devices[d2], p);
    }
    assert G9(b);
  }

  // G9Agrees reads only the state's server.
  lemma G9AgreesSameServer(a: State, b: State, one: Device, other: Device, p: Path)
    requires a.server == b.server && p in one.disk && G9Agrees(a, one, other, p)
    ensures G9Agrees(b, one, other, p)
  {
    assert KeepsUnheld(a, one, p) == KeepsUnheld(b, one, p);
    forall q ensures ReportedCannotHold(a, other, q) == ReportedCannotHold(b, other, q) {}
  }

  // ReadsFeed reads no open intent.
  lemma ReadsFeedStopped(a: State, b: State, x: DeviceId)
    requires StoppedFrom(a, b)
    ensures ReadsFeed(b, x) == ReadsFeed(a, x)
  {
    if x in a.devices {
      assert AnchorOnFeed(b.server, b.devices[x].journal) == AnchorOnFeed(a.server, a.devices[x].journal);
    }
  }

  // ClaimsButG9 reads no running flag, editor or open intent.
  lemma {:isolate_assertions} ClaimsButG9Intents(a: State, b: State)
    requires StoppedFrom(a, b) && ClaimsButG9(a)
    ensures ClaimsButG9(b)
  {
    forall x | x in a.devices
      ensures b.devices[x].disk == a.devices[x].disk && b.devices[x].platform == a.devices[x].platform
      ensures b.devices[x].outOfScope == a.devices[x].outOfScope
      ensures b.devices[x].journal.documents == a.devices[x].journal.documents
      ensures b.devices[x].journal.cursor == a.devices[x].journal.cursor
    {}
    forall rev | rev in a.server.accepted
      ensures (exists x :: x in a.devices && OnDisk(a.devices[x], a.server.accepted[rev].content))
          <==> (exists x :: x in b.devices && OnDisk(b.devices[x], a.server.accepted[rev].content))
    {
      var version := a.server.accepted[rev];
      if exists x :: x in a.devices && OnDisk(a.devices[x], version.content) {
        var x := var x0 :| x0 in a.devices && OnDisk(a.devices[x0], version.content); x0;
        assert OnDisk(b.devices[x], version.content);
      }
      if exists x :: x in b.devices && OnDisk(b.devices[x], version.content) {
        var x := var x0 :| x0 in b.devices && OnDisk(b.devices[x0], version.content); x0;
        assert OnDisk(a.devices[x], version.content);
      }
    }
    assert G1_Retained(b);
    assert ServerRetains(b);
    assert G5_NeverJoined(b);
    assert G7_OneFilePerName(b);
    assert CoreInv(b);
    forall x | ReadsFeed(b, x) ensures OwnRevisionsAcknowledged(b, x) {
      ReadsFeedStopped(a, b, x);
      assert OwnRevisionsAcknowledged(a, x);
      forall doc, id | Unacknowledged(b, x, doc, id)
        ensures b.devices[x].journal.documents[doc].outbox.Some?
        ensures b.devices[x].journal.documents[doc].outbox.value.rev == id
      {
        assert Unacknowledged(a, x, doc, id);
      }
    }
    forall x ensures ReadsFeed(b, x) == ReadsFeed(a, x) {
      ReadsFeedStopped(a, b, x);
    }
    forall x, doc | ReadsFeed(b, x) && doc in b.devices[x].journal.documents
      ensures OutboxParentAtBase(b.server, doc, b.devices[x].journal.documents[doc])
      ensures OwnCommitOnBase(b.server, x, doc, b.devices[x].journal.documents[doc])
    {
      assert ReadsFeed(a, x);
    }
    assert CommitsOnBase(b);
    assert OutboxParentsAccepted(b);
    forall x, i | ReadsFeed(b, x) && 0 <= i < b.devices[x].journal.cursor
      && i < |b.server.feed| && b.server.feed[i] in b.server.revisions
      ensures var r := b.server.revisions[b.server.feed[i]];
          r.doc in b.devices[x].journal.documents
          && KnownPosition(b.devices[x].journal.documents[r.doc]).Some?
          && KnownPosition(b.devices[x].journal.documents[r.doc]).value >= r.position
    {
      assert ReadsFeed(a, x);
    }
    assert ClaimsCoverCursor(b);
    assert JournalsNameAccepted(b);
    assert ScopesClosedUnderF(b);
    assert OwnDocsKnown(b);
  }

  // ---------------------------------------------------------------------
  // A crash (CrashContract), for the cuts #1018 covers
  // ---------------------------------------------------------------------

  // The merged steps keep the claims (MergedClaims.dfy: LocalKeepsClaims,
  // ScanKeepsClaims, RefusedKeepsClaims, composed in MergedKeepClaimsHolds
  // there). A sibling module's lemma, so a hypothesis here, as
  // ClaimsImplyMirrorContract is.
  ghost predicate MergedKeepClaims() {
    (forall pre: State, d: DeviceId, local: LocalEvent, revs: FreshRevs {:trigger LocalStep(pre, d, local, revs)} ::
       d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys && ClaimsReachable(pre)
       ==> ClaimsCore(LocalStep(pre, d, local, revs).post))
    && (forall pre: State, d: DeviceId, revs: FreshRevs {:trigger ScanStep(pre, d, revs)} ::
          d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
          && ListingDistinct(pre.devices[d].platform, ListingOf(pre.devices[d])) && ClaimsReachable(pre)
          ==> ClaimsCore(ScanStep(pre, d, revs).post))
    && (forall pre: State, d: DeviceId, result: PushResult, nextRev: RevId {:trigger RefusedStep(pre, d, result, nextRev)} ::
          d in pre.devices && !result.Accepted? && ClaimsReachable(pre)
          ==> ClaimsCore(RefusedStep(pre, d, result, nextRev).post))
  }

  // The resync is journal-only and keeps the claims (Resync.dfy:
  // ResyncKeepsAll, composed in ResyncJournalOnlyHolds there), for a
  // running device. A sibling module's step, so a hypothesis here.
  ghost predicate ResyncJournalOnly() {
    forall pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs {:trigger ResyncStepOf(pre, d, input, revs)} ::
      d in pre.devices && pre.devices[d].running && CoreReachable(pre)
      && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs)
      ==> var step := ResyncStepOf(pre, d, input, revs);
          ClaimsCore(step.post)
          && ((step.effects == [] && step.post == pre)
              || exists j' :: step.effects == [PersistJournal(j')] && step.post == After(pre, d, j'))
  }

  // The cuts this issue proves CrashContract for: none, a local event, the
  // scan, a push refused or not answered, a restart, and a resync of a
  // running device. A cut of a remote revision or an accepted push is
  // #1098's (#1018, 2026-10-28: CoreRequests does not carry their
  // preconditions); a sync round's cut waits on #1094's restatement.
  ghost predicate CoveredCut(step: Step) {
    step.event.Crash?
    && (step.event.cut.None?
        || step.event.cut.value.event.Local? || step.event.cut.value.event.Scan?
        || step.event.cut.value.event.Restart?
        || (step.event.cut.value.event.Resync? && step.event.device in step.pre.devices
            && step.pre.devices[step.event.device].running)
        || (step.event.cut.value.event.Pushed? && !step.event.cut.value.event.result.Accepted?))
  }

  // CrashContract's hypotheses.
  ghost predicate CrashHypotheses(step: Step) {
    step.event.Crash? && CrashCutsShort(step) && CutRequestedByCore(step)
    && CrashLeaves(step) && DisksFollowEffects(step)
    && CoreReachable(step.pre)
  }

  // The commit a landing appends: the device's sealed outbox of `doc`, at
  // the feed's end (CommitLandedAs, with every journal as it was).
  ghost predicate LandsOutbox(pre: State, d: DeviceId, doc: DocId, r: Revision) {
    d in pre.devices && doc in pre.devices[d].journal.documents
    && var o := pre.devices[d].journal.documents[doc].outbox;
    o.Some? && o.value.sealed
    && r == Revision(o.value.rev, doc, |pre.server.feed|, o.value.baseRev, o.value.path, o.value.content,
                     o.value.kind, o.value.deleted, d)
    && Appendable(pre.server, doc, r)
  }

  // A commit that lands unanswered, with every journal unchanged, keeps
  // the claims: #1100's LandedKeepsClaims, composed in MergedClaims.dfy's
  // LandingKeepsClaimsHolds (a sibling module, so a hypothesis here).
  ghost predicate LandingKeepsClaims() {
    forall pre: State, d: DeviceId, doc: DocId, r: Revision {:trigger LandsOutbox(pre, d, doc, r)} ::
      CoreReachable(pre) && LandsOutbox(pre, d, doc, r)
      ==> ClaimsCore(pre.(server := Appended(pre.server, doc, r)))
  }

  // The journal a covered cut persists, if the crash came after its one
  // effect: every covered step requests exactly [PersistJournal(j')]. The
  // step's journal is read from the device alone (but for a resync's, which
  // reads the server), so it is the same from any state `base` with the
  // same devices: the crash step's state before, or that state with a
  // commit landed.
  lemma CoveredCutEffects(step: Step, base: State) returns (j': Journal)
    requires ResyncJournalOnly()
    requires CrashHypotheses(step) && CoveredCut(step) && step.event.cut.Some?
    requires step.event.device in step.pre.devices && base.devices == step.pre.devices
    ensures |step.effects| == 0 || step.effects == [PersistJournal(j')]
    ensures var d := step.event.device;
      match step.event.cut.value.event
      case Local(_, local) => exists revs: FreshRevs :: base.devices[d].journal.documents.Keys <= revs.Keys
                                && LocalStep(base, d, local, revs).post == After(base, d, j')
      case Scan(_, _) => ListingDistinct(base.devices[d].platform, ListingOf(base.devices[d]))
                           && exists revs: FreshRevs :: base.devices[d].journal.documents.Keys <= revs.Keys
                                && ScanStep(base, d, revs).post == After(base, d, j')
      case Pushed(_, result) => exists nextRev: RevId :: RefusedStep(base, d, result, nextRev).post == After(base, d, j')
      case Restart(_) => j' == Recover(base.devices[d].journal)
      case Resync(_) => ClaimsCore(After(step.pre, d, j'))
      case _ => false
  {
    var d := step.event.device;
    var pre := step.pre;
    var cut := step.event.cut.value;
    var device := pre.devices[d];
    match cut.event
    case Local(_, local) =>
      var revs: FreshRevs :| device.journal.documents.Keys <= revs.Keys && LocalStep(pre, d, local, revs).effects == cut.requested;
      j' := LocalJournal(device.platform, device.journal, local, map p | p in LocalEventPaths(local) :: ReadAt(device, p), revs);
      assert LocalStep(base, d, local, revs).post == After(base, d, j');
    case Scan(_, _) =>
      var revs: FreshRevs :| device.journal.documents.Keys <= revs.Keys && ScanStep(pre, d, revs).effects == cut.requested;
      j' := ScanJournal(device.platform, device.journal, ListingOf(device), revs);
      assert ScanStep(base, d, revs).post == After(base, d, j');
    case Pushed(_, result) =>
      var nextRev: RevId :| RefusedStep(pre, d, result, nextRev).effects == cut.requested;
      j' := PushedJournal(device.journal, result, nextRev);
      assert RefusedStep(base, d, result, nextRev).post == After(base, d, j');
    case Restart(_) =>
      j' := Recover(device.journal);
    case Resync(_) =>
      var input: RoundInput, revs: FreshRevs :| RoundInputOf(pre, d, input)
        && RevsCover(device.journal, input, revs) && ResyncStepOf(pre, d, input, revs).effects == cut.requested;
      var rstep := ResyncStepOf(pre, d, input, revs);
      assert ClaimsCore(rstep.post);
      if rstep.effects == [] {
        j' := device.journal;
        assert After(pre, d, j') == pre;
      } else {
        j' :| rstep.effects == [PersistJournal(j')] && rstep.post == After(pre, d, j');
      }
  }

  // The state a crash starts from on the server it leaves: the state before,
  // or that state with the device's sealed outbox landed (CommitLanded: a
  // covered cut performs no Commit effect). CoreReachable either way.
  lemma {:isolate_assertions} CrashBase(step: Step) returns (base: State)
    requires ResyncJournalOnly() && ClaimsImplyMirrorContract() && LandingKeepsClaims()
    requires CrashHypotheses(step) && CoveredCut(step) && step.event.device in step.pre.devices
    ensures base == step.pre.(server := step.post.server) && CoreReachable(base)
  {
    var d := step.event.device;
    var pre := step.pre;
    base := pre.(server := step.post.server);
    if step.post.server == pre.server {
      assert base == pre;
    } else {
      CoveredEffectsJournalOnly(step);
      var doc, r := CrashLanding(step);
      assert ClaimsCore(pre.(server := Appended(pre.server, doc, r)));
      assert ClaimsCore(base);
      assert MirrorAtCursor(base) && MirrorInv(base);
    }
  }

  // A covered crash performs journal writes only.
  lemma CoveredEffectsJournalOnly(step: Step)
    requires ResyncJournalOnly()
    requires CrashHypotheses(step) && CoveredCut(step) && step.event.device in step.pre.devices
    ensures forall effect :: effect in step.effects ==> effect.PersistJournal?
  {
    if step.event.cut.Some? && |step.effects| != 0 {
      var j' := CoveredCutEffects(step, step.pre);
    }
  }

  // A covered crash that changed the server landed the device's sealed
  // outbox (a covered cut performs no Commit effect).
  lemma {:isolate_assertions} CrashLanding(step: Step) returns (doc: DocId, r: Revision)
    requires step.event.Crash? && CrashLeaves(step) && step.event.device in step.pre.devices
    requires forall effect :: effect in step.effects ==> effect.PersistJournal?
    requires step.post.server != step.pre.server
    ensures LandsOutbox(step.pre, step.event.device, doc, r)
    ensures step.post.server == Appended(step.pre.server, doc, r)
  {
    var d := step.event.device;
    var pre := step.pre;
    assert CommitLanded(step, d);
    var o: Outbox;
    doc, o :| CommitLandedAs(step, d, doc, o);
    assert Commit(doc, o) !in step.effects;
    r := Revision(o.rev, doc, |pre.server.feed|, o.baseRev, o.path, o.content, o.kind, o.deleted, d);
  }

  // The recovered crash post-state is the state the cut step leaves from
  // `base` with journal `jS` (`base` itself, if the crash came before the
  // step's journal write), with the device stopped and the stopped
  // devices' intents dropped.
  lemma {:isolate_assertions} RecoveredIsStopped(step: Step, base: State, jS: Journal)
    requires CrashHypotheses(step) && step.event.device in step.pre.devices
    requires base == step.pre.(server := step.post.server)
    requires step.post.devices[step.event.device].journal.(intents := jS.intents) == jS
    requires step.post.devices[step.event.device].disk == step.pre.devices[step.event.device].disk
    ensures StoppedFrom(After(base, step.event.device, jS), Recovered(step.post))
  {
    var S := After(base, step.event.device, jS);
    var R := Recovered(step.post);
    forall x | x in S.devices
      ensures if R.devices[x].running then R.devices[x] == S.devices[x]
         else R.devices[x] == S.devices[x].(running := false, editors := R.devices[x].editors,
                                            journal := S.devices[x].journal.(intents := R.devices[x].journal.intents))
    {}
  }

  // A device given its own journal is unchanged.
  lemma AfterOwnJournal(s: State, d: DeviceId)
    requires d in s.devices
    ensures After(s, d, s.devices[d].journal) == s
  {
    assert s.devices[d := s.devices[d].(journal := s.devices[d].journal)] == s.devices;
  }

  // A crash's post-state, recovered, is a state with ClaimsCore with some
  // devices stopped and some intents changed. A landed commit enters
  // through LandingKeepsClaims (#1100); a resync's journal reads the
  // server, so its cut is covered on an unchanged server only.
  lemma {:isolate_assertions} CrashKeepsClaims(step: Step)
    requires MergedKeepClaims() && ResyncJournalOnly()
    requires ClaimsImplyMirrorContract() && LandingKeepsClaims()
    requires CrashHypotheses(step) && CoveredCut(step)
    requires step.event.device in step.pre.devices
    requires step.event.cut.Some? && step.event.cut.value.event.Resync? ==> step.post.server == step.pre.server
    ensures CrashInv(step.post)
  {
    var d := step.event.device;
    var pre := step.pre;
    var post := step.post;
    var device := pre.devices[d];
    var base := CrashBase(step);
    assert EffectsTake(device.platform, device.disk, step.effects, post.devices[d].disk);
    var jS: Journal;
    if |step.effects| == 0 {
      assert post.devices[d].journal == device.journal;
      assert post.devices[d].disk == device.disk;
      jS := device.journal;
      AfterOwnJournal(base, d);
    } else {
      var j' := CoveredCutEffects(step, base);
      assert step.effects == [PersistJournal(j')];
      assert post.devices[d].journal == j';
      var mid :| EffectTakes(device.platform, device.disk, step.effects[0], mid) && EffectsTake(device.platform, mid, step.effects[1..], post.devices[d].disk);
      assert post.devices[d].disk == device.disk;
      jS := j';
      match step.event.cut.value.event
      case Local(_, local) =>
        var revs: FreshRevs :| device.journal.documents.Keys <= revs.Keys && LocalStep(base, d, local, revs).post == After(base, d, jS);
        assert ClaimsCore(LocalStep(base, d, local, revs).post);
      case Scan(_, _) =>
        var revs: FreshRevs :| device.journal.documents.Keys <= revs.Keys && ScanStep(base, d, revs).post == After(base, d, jS);
        assert ClaimsCore(ScanStep(base, d, revs).post);
      case Pushed(_, result) =>
        var nextRev: RevId :| RefusedStep(base, d, result, nextRev).post == After(base, d, jS);
        assert ClaimsCore(RefusedStep(base, d, result, nextRev).post);
      case Restart(_) =>
        jS := device.journal;
        AfterOwnJournal(base, d);
      case Resync(_) =>
        assert base == pre;
    }
    assert ClaimsCore(After(base, d, jS));
    RecoveredIsStopped(step, base, jS);
    StoppedKeepsClaims(After(base, d, jS), Recovered(post));
  }

  // The crash's server: the device's commit appended (CrashLanding).
  ghost predicate Lands(step: Step, doc: DocId, r: Revision) {
    step.event.Crash? && LandsOutbox(step.pre, step.event.device, doc, r)
    && step.post.server == Appended(step.pre.server, doc, r)
  }

  // G1 for a crash that leaves every disk as it was: a revision the server
  // could give back before (G1_Retained, ServerRetains) still is, unless it
  // was purged or lost and is on no disk.
  lemma {:isolate_assertions} CrashKeepsG1(step: Step)
    requires G1_Retained(step.pre) && ServerRetains(step.pre)
    requires step.pre.devices.Keys == step.post.devices.Keys
    requires forall x :: x in step.pre.devices ==> step.post.devices[x].disk == step.pre.devices[x].disk
    requires step.post.server == step.pre.server || exists doc, r :: Lands(step, doc, r)
    ensures G1_OnlyRetentionRemoves(step)
  {
    var pre := step.pre;
    var post := step.post;
    forall rev | rev in pre.server.accepted && rev in post.server.accepted && Retrievable(pre, rev) && !Retrievable(post, rev)
      ensures rev in pre.server.purged
          || (rev in pre.server.lost
              && !exists x :: x in pre.devices && OnDisk(pre.devices[x], pre.server.accepted[rev].content))
    {
      if post.server != pre.server {
        var doc, r :| Lands(step, doc, r);
        assert post.server.accepted[rev] == pre.server.accepted[rev];
        if InHistory(pre.server, rev) {
          var doc' :| doc' in pre.server.history && rev in pre.server.history[doc'];
          assert rev in post.server.history[doc'];
          assert InHistory(post.server, rev);
        }
      }
      if exists x :: x in pre.devices && OnDisk(pre.devices[x], pre.server.accepted[rev].content) {
        var x :| x in pre.devices && OnDisk(pre.devices[x], pre.server.accepted[rev].content);
        assert OnDisk(post.devices[x], pre.server.accepted[rev].content);
      }
    }
  }

  // A crash that leaves the journal's rows as they were keeps the step
  // guarantees: it performs at most a journal write (CoveredCutEffects), so
  // the disks are as they were too, and a landed commit is the device's own.
  lemma {:isolate_assertions} CrashGuarantees(step: Step)
    requires ResyncJournalOnly()
    requires CrashHypotheses(step) && CoveredCut(step)
    requires step.event.device in step.pre.devices
    requires step.post.devices[step.event.device].journal.documents == step.pre.devices[step.event.device].journal.documents
    ensures StepGuarantees(step)
  {
    var d := step.event.device;
    var pre := step.pre;
    var post := step.post;
    var device := pre.devices[d];
    assert EffectsTake(device.platform, device.disk, step.effects, post.devices[d].disk);
    if |step.effects| != 0 {
      var j' := CoveredCutEffects(step, step.pre);
      var mid :| EffectTakes(device.platform, device.disk, step.effects[0], mid) && EffectsTake(device.platform, mid, step.effects[1..], post.devices[d].disk);
    }
    assert post.devices[d].disk == device.disk;
    CoveredEffectsJournalOnly(step);
    if post.server != pre.server {
      var doc, r := CrashLanding(step);
      assert Lands(step, doc, r);
    }
    CrashKeepsG1(step);
    assert G1_OnlyRetentionRemoves(step);
    assert G2_OnlyWhatItSaw(step);
    assert G2_Conditional(step);
    assert G2_NoUntrackedDelete(step);
    assert G2_UnsavedSafe(step);
    assert G3_DeleteSeen(step);
    assert G5_RenameKeepsDocument(step);
    assert post.devices[d].platform == device.platform;
    forall doc ensures BoundIdentity(post.devices[d], doc) == BoundIdentity(device, doc) {
      var docs := device.journal.documents;
      if doc in docs && docs[doc].binding.Some? {
        SameFileOnSameDisk(device, post.devices[d], docs[doc].binding.value.spelling);
      }
      assert BoundFile(post.devices[d], doc) == BoundFile(device, doc);
    }
    assert G5_NeverMixedUp(step);
    assert forall x, doc, remote :: !SettlesConcurrent(step, x, doc, remote);
    assert G7_MoveKeepsContents(step);
    assert G8_Recovers(step);
    assert G8_PicksUpOfflineChanges(step);
    assert G10_SettledOrReported(step);
    assert ServerFollowsEvent(step);
  }

  // CrashContract (#1018), for a covered cut (CoveredCut) of a crash that
  // leaves the journal's rows as they were: no cut, a cut before its
  // journal write, or a restart's cut. The server is unchanged or has the
  // device's commit landed (LandingKeepsClaims, #1100); a resync's cut
  // needs it unchanged. The guarantees of a crash after a rename's or a
  // scan match's journal write are #1098's (G5_NeverMixedUp and
  // G3_DeleteSeen read the step's own event).
  lemma CrashKeepsAll(step: Step)
    requires MergedKeepClaims() && ResyncJournalOnly()
    requires ClaimsImplyMirrorContract() && LandingKeepsClaims()
    requires CoveredCut(step) && step.event.device in step.pre.devices && step.event.device in step.post.devices
    requires step.event.cut.Some? && step.event.cut.value.event.Resync? ==> step.post.server == step.pre.server
    requires step.post.devices[step.event.device].journal.documents == step.pre.devices[step.event.device].journal.documents
    ensures CrashContract(step)
  {
    if CrashHypotheses(step) {
      CrashKeepsClaims(step);
      CrashGuarantees(step);
    }
  }
}
