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

  // ---------------------------------------------------------------------
  // A restore from backup
  // ---------------------------------------------------------------------

  ghost function FeedIds(feed: seq<RevId>): set<RevId> {
    set i | 0 <= i < |feed| :: feed[i]
  }

  lemma KeepMember(s: seq<RevId>, ids: set<RevId>, x: RevId)
    ensures x in Keep(s, ids) <==> x in s && x in ids
  {
    if |s| > 0 {
      KeepMember(s[1..], ids, x);
      assert s == [s[0]] + s[1..];
    }
  }

  lemma KeepKeep(s: seq<RevId>, a: set<RevId>, b: set<RevId>)
    requires b <= a
    ensures Keep(Keep(s, a), b) == Keep(s, b)
  {
    if |s| > 0 {
      KeepKeep(s[1..], a, b);
      var rest := Keep(s[1..], a);
      if s[0] in a {
        var kept := [s[0]] + rest;
        assert Keep(s, a) == kept;
        assert kept[0] == s[0] && kept[1..] == rest;
        assert Keep(kept, b) == (if s[0] in b then [s[0]] else []) + Keep(rest, b);
      } else {
        assert s[0] !in b;
        assert Keep(s, a) == [] + rest == rest;
        assert Keep(s, b) == [] + Keep(s[1..], b);
      }
    }
  }

  lemma KeepOrder(s: seq<RevId>, ids: set<RevId>, j: int, k: int) returns (j': int, k': int)
    requires 0 <= j < k < |Keep(s, ids)|
    ensures 0 <= j' < k' < |s| && s[j'] == Keep(s, ids)[j] && s[k'] == Keep(s, ids)[k]
  {
    var rest := Keep(s[1..], ids);
    if s[0] in ids {
      assert Keep(s, ids) == [s[0]] + rest;
      if j == 0 {
        assert Keep(s, ids)[k] == rest[k - 1];
        KeepMember(s[1..], ids, rest[k - 1]);
        assert rest[k - 1] in s[1..];
        var m :| 0 <= m < |s[1..]| && s[1..][m] == rest[k - 1];
        j', k' := 0, m + 1;
      } else {
        var a, b := KeepOrder(s[1..], ids, j - 1, k - 1);
        j', k' := a + 1, b + 1;
      }
    } else {
      assert Keep(s, ids) == rest;
      var a, b := KeepOrder(s[1..], ids, j, k);
      j', k' := a + 1, b + 1;
    }
  }

  // A cut of an earlier server is a cut of the server it was cut from.
  lemma CutOfCut(server: Server, restored: Server, cut: Server)
    requires EarlierServer(server, restored) && EarlierServer(restored, cut)
    ensures EarlierServer(server, cut)
  {
    var outer := FeedIds(restored.feed);
    var inner := FeedIds(cut.feed);
    assert cut.feed == server.feed[..|cut.feed|];
    assert inner <= outer;
    forall doc | doc in server.history
      ensures Keep(Keep(server.history[doc], outer), inner) == Keep(server.history[doc], inner)
    {
      KeepKeep(server.history[doc], outer, inner);
    }
    assert cut.revisions == (map id | id in server.revisions && id in inner :: server.revisions[id]);
    forall doc ensures (doc in cut.history) == (doc in server.history && |Keep(server.history[doc], inner)| > 0) {
      if doc in server.history && doc !in restored.history {
        assert Keep(server.history[doc], outer) == [];
        assert Keep([], inner) == [];
      }
    }
    assert cut.history == (map doc | doc in server.history && |Keep(server.history[doc], inner)| > 0
                             :: Keep(server.history[doc], inner));
  }

  // The restored server, its ghost records apart, is an earlier server.
  lemma RestoredIsCut(step: Step)
    requires ServerEventStep(step) && step.event.Restore?
    ensures EarlierServer(step.pre.server, step.post.server)
    ensures forall cut :: EarlierServer(step.post.server, cut) ==> EarlierServer(step.pre.server, cut)
    ensures forall doc :: Head(step.post.server, doc) == Head(step.event.restored, doc)
  {
    var restored := step.event.restored;
    forall cut | EarlierServer(step.post.server, cut) ensures EarlierServer(step.pre.server, cut) {
      assert EarlierServer(restored, cut);
      CutOfCut(step.pre.server, restored, cut);
    }
  }

  // A device the restore leaves undiverged was undiverged before it: its
  // cursor is on the restored feed (a prefix), every revision its journal
  // names is one the restored server holds (a subset), and its anchor is
  // the restored feed's entry, which is the one before.
  lemma RestoreUndiverged(step: Step, d: DeviceId)
    requires ServerEventStep(step) && step.event.Restore?
    requires d in step.post.devices && !Diverged(step.post, d)
    ensures !Diverged(step.pre, d)
  {
    RestoredIsCut(step);
    var journal := step.pre.devices[d].journal;
    assert JournalOnServer(step.pre.server, journal) by {
      forall doc | doc in journal.documents
        ensures (journal.documents[doc].base.Some? ==> journal.documents[doc].base.value.rev in step.pre.server.revisions)
          && (journal.documents[doc].ahead.Some? ==> journal.documents[doc].ahead.value.revision.id in step.pre.server.revisions)
      {
        assert JournalOnServer(step.post.server, journal);
      }
    }
    if journal.cursor > 0 {
      assert step.post.server.feed[journal.cursor - 1] == step.pre.server.feed[journal.cursor - 1];
    }
  }

  // A restore keeps what the server retains: a revision it removes from
  // the history or the revisions is `lost` (RestoreRemoves), and one it
  // keeps but no longer marks purged is back in its document's history
  // (HistoryFollowsFeed).
  // Every revision is stored under its own id (Appended does so). Not a
  // clause of CoreReachable: reported as a design gap on #950; until it is
  // settled the restore's proof takes it as an explicit hypothesis.
  ghost predicate RevisionsKeyed(server: Server) {
    forall id :: id in server.revisions ==> server.revisions[id].id == id
  }

  lemma {:isolate_assertions} RestoreRetains(step: Step)
    requires ServerEventStep(step) && step.event.Restore?
    requires CoreReachable(step.pre) && RevisionsKeyed(step.pre.server)
    ensures ServerRetains(step.post)
  {
    var pre := step.pre.server;
    var post := step.post.server;
    var restored := step.event.restored;
    RestoredIsCut(step);
    var kept := FeedIds(post.feed);
    assert post.purged <= post.revisions.Keys;
    forall doc, rev | doc in post.history && rev in post.history[doc] ensures rev in post.revisions {
      KeepMember(pre.history[doc], kept, rev);
    }
    forall rev | rev in post.accepted
      ensures InHistory(post, rev)
          || (!post.accepted[rev].deleted
              && exists d :: d in step.post.devices && OnDisk(step.post.devices[d], post.accepted[rev].content))
          || (rev in post.purged && !IsHead(post, rev))
          || rev in post.lost
    {
      if rev in pre.lost || rev in RestoreRemoves(pre, restored) {
      } else if InHistory(pre, rev) {
        assert InHistory(post, rev);
      } else if rev in pre.purged && !IsHead(pre, rev) {
        assert rev in pre.revisions;
        assert rev in post.revisions;
        assert rev in kept;
        var i :| 0 <= i < |post.feed| && post.feed[i] == rev;
        assert pre.feed[i] == rev;
        var doc := pre.revisions[rev].doc;
        assert doc in pre.history && rev in pre.history[doc];
        KeepMember(pre.history[doc], kept, rev);
        assert doc in post.history && rev in post.history[doc];
        if rev !in post.purged {
          assert InHistory(post, rev);
        } else {
          if IsHead(post, rev) {
            var x :| Head(post, x).Some? && Head(post, x).value.id == rev;
            var last := post.history[x][|post.history[x]| - 1];
            assert post.revisions[last].id == rev && last in post.revisions;
            assert last == rev;
            assert false;
          }
        }
      }
    }
  }

  // A restore keeps each history in feed order: Keep keeps the order.
  lemma {:isolate_assertions} RestoreHistoryFollowsFeed(step: Step)
    requires ServerEventStep(step) && step.event.Restore?
    requires CoreReachable(step.pre)
    ensures HistoryFollowsFeed(step.post.server) && FeedPositioned(step.post.server) && RevisionsAccepted(step.post.server)
  {
    var pre := step.pre.server;
    var post := step.post.server;
    RestoredIsCut(step);
    var kept := FeedIds(post.feed);
    forall doc, j | doc in post.history && 0 <= j < |post.history[doc]| && post.history[doc][j] in post.revisions
      ensures post.revisions[post.history[doc][j]].doc == doc && post.history[doc][j] in post.feed
    {
      var rev := post.history[doc][j];
      KeepMember(pre.history[doc], kept, rev);
      var m :| 0 <= m < |pre.history[doc]| && pre.history[doc][m] == rev;
    }
    forall i | 0 <= i < |post.feed| && post.feed[i] in post.revisions
      ensures var doc := post.revisions[post.feed[i]].doc;
              doc in post.history && post.feed[i] in post.history[doc]
    {
      var rev := post.feed[i];
      assert pre.feed[i] == rev;
      var doc := pre.revisions[rev].doc;
      KeepMember(pre.history[doc], kept, rev);
    }
    forall doc, j, k | doc in post.history && 0 <= j < k < |post.history[doc]|
      && post.history[doc][j] in post.revisions && post.history[doc][k] in post.revisions
      ensures post.revisions[post.history[doc][j]].position < post.revisions[post.history[doc][k]].position
    {
      var j', k' := KeepOrder(pre.history[doc], kept, j, k);
    }
    forall i | 0 <= i < |post.feed| && post.feed[i] in post.revisions
      ensures post.revisions[post.feed[i]].position == i
    {
      assert pre.feed[i] == post.feed[i];
    }
  }

  lemma {:isolate_assertions} RestoreKeepsAll(step: Step)
    requires ServerEventStep(step) && step.event.Restore?
    requires CoreReachable(step.pre) && RevisionsKeyed(step.pre.server)
    ensures CoreReachable(step.post) && StepGuarantees(step)
  {
    var pre := step.pre;
    var post := step.post;
    RestoredIsCut(step);
    RestoreRetains(step);
    RestoreHistoryFollowsFeed(step);
    ServerEventDevicePredicates(step);
    assert pre.(server := post.server) == post;

    // MirrorInv: a device finished after the restore is undiverged, with its
    // cursor at the restored feed's length, which is a cut of the server.
    forall d | d in post.devices && FinishedSyncing(post, d)
      ensures FilesMirrorHeads(post, post.devices[d]) && HeadsMirrored(post, post.devices[d])
    {
      RestoreUndiverged(step, d);
      assert pre.devices[d].journal.cursor == |post.server.feed| <= |pre.server.feed|;
    }
    assert MirrorInv(post);
    MirrorImpliesG9(post);
    assert LiveHeadsApart(post.server);
    assert G7_OneFilePerName(post);
    forall rev | rev in post.server.accepted
      ensures Retrievable(post, rev) || (rev in post.server.purged && !IsHead(post.server, rev)) || rev in post.server.lost
    {
    }
    assert G1_Retained(post);
    assert G1_LatestNeverPurged(post);
    assert StateInvariants(post);
    assert CoreInv(post);
    assert JournalsNameAccepted(post);
    assert CutsHeadsApart(post.server);
    forall d, i | d in post.devices && !Diverged(post, d) && 0 <= i < post.devices[d].journal.cursor
      && i < |post.server.feed| && post.server.feed[i] in post.server.revisions
      ensures var r := post.server.revisions[post.server.feed[i]];
          r.doc in post.devices[d].journal.documents
          && KnownPosition(post.devices[d].journal.documents[r.doc]).Some?
          && KnownPosition(post.devices[d].journal.documents[r.doc]).value >= r.position
    {
      RestoreUndiverged(step, d);
      assert pre.server.feed[i] == post.server.feed[i];
    }
    assert ClaimsCoverCursor(post);
    forall d | d in post.devices && !Diverged(post, d) ensures OwnRevisionsAcknowledged(post, d) {
      RestoreUndiverged(step, d);
      forall doc, id | Unacknowledged(post, d, doc, id)
        ensures post.devices[d].journal.documents[doc].outbox.Some?
             && post.devices[d].journal.documents[doc].outbox.value.rev == id
      {
        KeepMember(pre.server.history[doc], FeedIds(post.server.feed), id);
        assert Unacknowledged(pre, d, doc, id);
      }
    }
    assert ClaimsReachable(post);
    forall d: DeviceId, cut: Server | d in post.devices && !Diverged(post, d)
      && post.devices[d].journal.cursor <= |post.server.feed|
      && |cut.feed| == post.devices[d].journal.cursor && EarlierServer(post.server, cut)
      && FinishedSyncing(post.(server := cut), d)
      ensures FilesMirrorHeads(post.(server := cut), post.devices[d])
           && HeadsMirrored(post.(server := cut), post.devices[d])
    {
      RestoreUndiverged(step, d);
      assert pre.(server := cut) == post.(server := cut);
    }
    assert MirrorAtCursor(post);
    assert G1_OnlyRetentionRemoves(step);
  }

  // ---------------------------------------------------------------------
  // A restore from history
  // ---------------------------------------------------------------------

  // Every feed entry is an accepted id (Appended adds to both, a restore
  // cuts the feed and keeps `accepted`). Not a clause of CoreReachable:
  // reported as a design gap on #950; until it is settled the proof takes it
  // as an explicit hypothesis.
  ghost predicate FeedAccepted(server: Server) {
    forall i :: 0 <= i < |server.feed| ==> server.feed[i] in server.accepted
  }

  lemma KeepAppendOut(s: seq<RevId>, x: RevId, ids: set<RevId>)
    requires x !in ids
    ensures Keep(s + [x], ids) == Keep(s, ids)
  {
    if |s| == 0 {
      assert [x][1..] == [];
    } else {
      assert (s + [x])[1..] == s[1..] + [x];
      KeepAppendOut(s[1..], x, ids);
    }
  }

  lemma KeepAll(s: seq<RevId>, ids: set<RevId>)
    requires forall e :: e in s ==> e in ids
    ensures Keep(s, ids) == s
  {
    if |s| > 0 {
      KeepAll(s[1..], ids);
      assert s == [s[0]] + s[1..];
    }
  }

  // The appended id is named by no journal, so no device's divergence
  // changes.
  lemma AppendSameDivergence(step: Step, d: DeviceId)
    requires ServerEventStep(step) && step.event.RestoreFromHistory?
    requires CoreReachable(step.pre) && d in step.pre.devices
    ensures Diverged(step.post, d) == Diverged(step.pre, d)
  {
    var r := step.event.revision;
    var journal := step.pre.devices[d].journal;
    var pre := step.pre.server;
    var post := step.post.server;
    assert r.id !in pre.accepted;
    assert JournalOnServer(post, journal) == JournalOnServer(pre, journal) by {
      forall doc | doc in journal.documents
        ensures (journal.documents[doc].base.Some? ==> journal.documents[doc].base.value.rev in post.revisions)
             == (journal.documents[doc].base.Some? ==> journal.documents[doc].base.value.rev in pre.revisions)
        ensures (journal.documents[doc].ahead.Some? ==> journal.documents[doc].ahead.value.revision.id in post.revisions)
             == (journal.documents[doc].ahead.Some? ==> journal.documents[doc].ahead.value.revision.id in pre.revisions)
      {
      }
    }
    if journal.cursor == |post.feed| {
      assert post.feed[journal.cursor - 1] == r.id;
    } else if 0 < journal.cursor <= |pre.feed| {
      assert post.feed[journal.cursor - 1] == pre.feed[journal.cursor - 1];
    }
  }

  // A cut of the appended server short of the new entry is a cut of the
  // server before; the cut at the whole feed has the appended server's heads.
  lemma AppendCuts(step: Step, cut: Server)
    requires ServerEventStep(step) && step.event.RestoreFromHistory?
    requires CoreReachable(step.pre) && FeedAccepted(step.pre.server)
    requires EarlierServer(step.post.server, cut)
    ensures |cut.feed| <= |step.pre.server.feed| ==> EarlierServer(step.pre.server, cut)
    ensures |cut.feed| > |step.pre.server.feed| ==> forall x :: Head(cut, x) == Head(step.post.server, x)
  {
    var pre := step.pre.server;
    var post := step.post.server;
    var r := step.event.revision;
    var doc := step.event.doc;
    var kept := FeedIds(cut.feed);
    if |cut.feed| <= |pre.feed| {
      assert cut.feed == pre.feed[..|cut.feed|];
      assert r.id !in kept;
      assert cut.revisions == (map id | id in pre.revisions && id in kept :: pre.revisions[id]);
      var h := if doc in pre.history then pre.history[doc] else [];
      KeepAppendOut(h, r.id, kept);
      assert Keep([], kept) == [];
      assert cut.history == (map x | x in pre.history && |Keep(pre.history[x], kept)| > 0 :: Keep(pre.history[x], kept));
    } else {
      assert cut.feed == post.feed;
      forall x | x in post.history ensures Keep(post.history[x], kept) == post.history[x] {
        forall e | e in post.history[x] ensures e in kept {
          if e != r.id {
            assert e in pre.revisions;
            var dx := pre.revisions[e].doc;
            assert x in pre.history && e in pre.history[x];
            var j :| 0 <= j < |pre.history[x]| && pre.history[x][j] == e;
            assert e in pre.feed;
            var i :| 0 <= i < |pre.feed| && pre.feed[i] == e;
            assert post.feed[i] == e;
          } else {
            assert post.feed[|pre.feed|] == r.id;
          }
        }
        KeepAll(post.history[x], kept);
      }
      forall x ensures Head(cut, x) == Head(post, x) {
        if x in post.history && |post.history[x]| > 0 {
          var last := post.history[x][|post.history[x]| - 1];
          assert x in cut.history && cut.history[x] == post.history[x];
          assert last in post.revisions ==> last in kept;
        }
      }
    }
  }
}
