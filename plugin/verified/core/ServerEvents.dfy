// The server's history events (#950, docs/design/verified-core.md §3.11):
// a restore from backup, a retention purge and a restore from history.
// None of them is the core's: the server performs them, they change no
// device and request no effect. This module proves that each keeps every
// invariant of a reachable state and satisfies every step predicate
// (ServerEventContract).
include "../spec/Contracts.dfy"

abstract module ServerEvents refines StepContracts {

  // A server event: the step's event is a restore, a purge or a restore from
  // history, which follows the server's semantics and touches no device.
  ghost predicate ServerEventStep(step: Step) {
    (step.event.Restore? || step.event.Purge? || step.event.RestoreFromHistory?)
    && ServerFollowsEvent(step)
    && step.post.devices == step.pre.devices && step.effects == []
  }

  // The step predicates other than G1's are about devices, their disks and
  // the core's own events: a server event satisfies each of them because it
  // changes no device and requests no effect.
  lemma ServerEventDevicePredicates(step: Step)
    requires ServerEventStep(step)
    ensures G2_OnlyWhatItSaw(step) && G2_Conditional(step) && G2_NoUntrackedDelete(step) && G2_UnsavedSafe(step)
    ensures G3_DeleteSeen(step)
    ensures G5_RenameKeepsDocument(step) && G5_NeverMixedUp(step)
    ensures forall d, doc, remote :: SettlesConcurrent(step, d, doc, remote) ==> G6_Settle(step, d, doc, remote)
    ensures G7_MoveKeepsContents(step)
    ensures G8_Recovers(step) && G8_PicksUpOfflineChanges(step)
    ensures G10_SettledOrReported(step)
    ensures DisksFollowEffects(step)
  {
  }

  // ---------------------------------------------------------------------
  // Servers that differ only in their purge marks
  // ---------------------------------------------------------------------

  // Two servers with one feed, one set of revisions and one history: every
  // notion of a device's state against the server reads only these.
  ghost predicate SameButPurges(a: Server, b: Server) {
    a.revisions == b.revisions && a.history == b.history && a.feed == b.feed
  }

  lemma SameButPurgesSameHeads(a: Server, b: Server)
    requires SameButPurges(a, b)
    ensures forall doc :: Head(a, doc) == Head(b, doc)
    ensures forall rev :: IsHead(a, rev) == IsHead(b, rev)
  {
  }

  lemma SameButPurgesSameDevices(state: State, server: Server)
    requires SameButPurges(state.server, server)
    ensures forall d :: FinishedSyncing(state, d) == FinishedSyncing(state.(server := server), d)
    ensures forall d :: Diverged(state, d) == Diverged(state.(server := server), d)
    ensures forall d :: d in state.devices ==>
      (FilesMirrorHeads(state, state.devices[d]) == FilesMirrorHeads(state.(server := server), state.devices[d]))
      && (HeadsMirrored(state, state.devices[d]) == HeadsMirrored(state.(server := server), state.devices[d]))
  {
    SameButPurgesSameHeads(state.server, server);
    var post := state.(server := server);
    forall d, p | d in state.devices
      ensures ReportedCannotHold(state, state.devices[d], p) == ReportedCannotHold(post, state.devices[d], p)
    {
    }
  }

  // ---------------------------------------------------------------------
  // A retention purge
  // ---------------------------------------------------------------------

  lemma {:isolate_assertions} PurgeKeepsAll(step: Step)
    requires ServerEventStep(step) && step.event.Purge?
    requires CoreReachable(step.pre)
    ensures CoreReachable(step.post) && StepGuarantees(step)
  {
    var pre := step.pre;
    var post := step.post;
    var revisions := step.event.revisions;
    assert post.server == pre.server.(purged := pre.server.purged + revisions);
    assert post == pre.(server := post.server);
    assert SameButPurges(pre.server, post.server);
    SameButPurgesSameHeads(pre.server, post.server);
    SameButPurgesSameDevices(pre, post.server);
    ServerEventDevicePredicates(step);

    // G1: a version leaves the history only by this purge, which names no head.
    forall rev | rev in post.server.accepted
      ensures Retrievable(post, rev) || (rev in post.server.purged && !IsHead(post.server, rev)) || rev in post.server.lost
    {
      if rev in revisions {
      } else if Retrievable(pre, rev) {
        if InHistory(pre.server, rev) {
          assert InHistory(post.server, rev);
        } else {
          var version := pre.server.accepted[rev];
          if exists doc :: Head(pre.server, doc).Some? && !Head(pre.server, doc).value.deleted
                           && Head(pre.server, doc).value.content == version.content {
            var doc :| Head(pre.server, doc).Some? && !Head(pre.server, doc).value.deleted
                       && Head(pre.server, doc).value.content == version.content;
            assert Head(post.server, doc) == Head(pre.server, doc);
          }
        }
      }
    }
    assert G1_Retained(post);
    assert G1_LatestNeverPurged(post);
    assert G7_OneFilePerName(post);
    assert G9(post);
    assert StateInvariants(post);
    assert CoreInv(post);
    assert ServerRetains(post) by {
      forall rev | rev in post.server.accepted
        ensures InHistory(post.server, rev)
          || (!post.server.accepted[rev].deleted
              && exists d :: d in post.devices && OnDisk(post.devices[d], post.server.accepted[rev].content))
          || (rev in post.server.purged && !IsHead(post.server, rev))
          || rev in post.server.lost
      {
        if InHistory(pre.server, rev) && rev !in revisions {
          assert InHistory(post.server, rev);
        }
      }
    }
    assert MirrorInv(post);
    assert ClaimsCoverCursor(post);
    assert JournalsNameAccepted(post);
    assert CutsHeadsApart(post.server) by {
      forall cut | EarlierServer(post.server, cut) ensures LiveHeadsApart(cut) {
        var cut' := cut.(purged := cut.purged * pre.server.purged);
        assert EarlierServer(pre.server, cut');
        assert SameButPurges(cut, cut');
        SameButPurgesSameHeads(cut, cut');
        assert LiveHeadsApart(cut');
      }
    }
    forall d | d in post.devices && !Diverged(post, d) ensures OwnRevisionsAcknowledged(post, d) {
      assert !Diverged(pre, d) && OwnRevisionsAcknowledged(pre, d);
      forall doc, id | Unacknowledged(post, d, doc, id)
        ensures post.devices[d].journal.documents[doc].outbox.Some?
             && post.devices[d].journal.documents[doc].outbox.value.rev == id
      {
        assert Unacknowledged(pre, d, doc, id);
      }
    }
    assert ClaimsReachable(post);
    assert MirrorAtCursor(post) by {
      forall d: DeviceId, cut: Server | d in post.devices && !Diverged(post, d)
        && post.devices[d].journal.cursor <= |post.server.feed|
        && |cut.feed| == post.devices[d].journal.cursor && EarlierServer(post.server, cut)
        && FinishedSyncing(post.(server := cut), d)
        ensures FilesMirrorHeads(post.(server := cut), post.devices[d])
             && HeadsMirrored(post.(server := cut), post.devices[d])
      {
        var cut' := cut.(purged := cut.purged * pre.server.purged);
        assert EarlierServer(pre.server, cut');
        assert SameButPurges(cut, cut');
        assert pre.(server := cut') == post.(server := cut').(server := cut');
        SameButPurgesSameDevices(post.(server := cut'), cut);
        assert post.(server := cut').(server := cut) == post.(server := cut);
        assert pre.(server := cut') == post.(server := cut');
      }
    }
    assert G1_OnlyRetentionRemoves(step);
  }
}
