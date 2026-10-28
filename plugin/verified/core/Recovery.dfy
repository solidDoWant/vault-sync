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
}
