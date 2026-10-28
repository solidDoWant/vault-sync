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

  // A cut of the purged server, with only the purges made before this one,
  // is a cut of the server before it (#1078: split out of PurgeKeepsAll).
  lemma PurgedCut(pre: Server, revisions: set<RevId>, cut: Server)
    requires EarlierServer(pre.(purged := pre.purged + revisions), cut)
    ensures EarlierServer(pre, cut.(purged := cut.purged * pre.purged))
    ensures SameButPurges(cut, cut.(purged := cut.purged * pre.purged))
  {
  }

  lemma {:isolate_assertions} PurgeKeepsAll(step: Step)
    requires ServerEventStep(step) && step.event.Purge?
    requires CoreReachable(step.pre)
    ensures CoreReachable(step.post) && StepGuarantees(step)
  {
    ServerClausesKept(step);
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
        PurgedCut(pre.server, revisions, cut);
        SameButPurgesSameHeads(cut, cut');
        assert LiveHeadsApart(cut');
      }
    }
    assert OwnDocsKnown(post);
    forall d | ReadsFeed(post, d) ensures OwnRevisionsAcknowledged(post, d) {
      assert ReadsFeed(pre, d) && OwnRevisionsAcknowledged(pre, d);
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
        PurgedCut(pre.server, revisions, cut);
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

  // A device that reads the restored feed read it before (ReadsFeed): its
  // cursor is on the restored feed, a prefix, whose entry before the cursor
  // is the anchor.
  lemma RestoreReadsFeed(step: Step, d: DeviceId)
    requires ServerEventStep(step) && step.event.Restore?
    requires ReadsFeed(step.post, d)
    ensures ReadsFeed(step.pre, d)
  {
    RestoredIsCut(step);
    var journal := step.pre.devices[d].journal;
    if journal.cursor > 0 {
      assert step.post.server.feed[journal.cursor - 1] == step.pre.server.feed[journal.cursor - 1];
    }
  }

  // An append starts no device reading the feed: the new entry's id was
  // never accepted, and every anchor was.
  lemma AppendReadsFeed(step: Step, d: DeviceId)
    requires ServerEventStep(step) && step.event.RestoreFromHistory?
    requires CoreReachable(step.pre) && ReadsFeed(step.post, d)
    ensures ReadsFeed(step.pre, d)
  {
    var r := step.event.revision;
    var journal := step.pre.devices[d].journal;
    var pre := step.pre.server;
    var post := step.post.server;
    assert r.id !in pre.accepted;
    if journal.cursor == |post.feed| {
      assert post.feed[journal.cursor - 1] == r.id;
      assert false;
    } else if 0 < journal.cursor <= |pre.feed| {
      assert post.feed[journal.cursor - 1] == pre.feed[journal.cursor - 1];
    }
  }

  // A restore keeps what the server retains: a revision it removes from
  // the history or the revisions is `lost` (RestoreRemoves), and one it
  // keeps but no longer marks purged is back in its document's history
  // (HistoryFollowsFeed).
  lemma {:isolate_assertions} RestoreRetains(step: Step)
    requires ServerEventStep(step) && step.event.Restore?
    requires CoreReachable(step.pre)
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
    requires CoreReachable(step.pre)
    ensures CoreReachable(step.post) && StepGuarantees(step)
  {
    ServerClausesKept(step);
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
    forall d, i | ReadsFeed(post, d) && 0 <= i < post.devices[d].journal.cursor
      && i < |post.server.feed| && post.server.feed[i] in post.server.revisions
      ensures var r := post.server.revisions[post.server.feed[i]];
          r.doc in post.devices[d].journal.documents
          && KnownPosition(post.devices[d].journal.documents[r.doc]).Some?
          && KnownPosition(post.devices[d].journal.documents[r.doc]).value >= r.position
    {
      RestoreReadsFeed(step, d);
      assert pre.server.feed[i] == post.server.feed[i];
    }
    assert ClaimsCoverCursor(post);
    assert OwnDocsKnown(post) by {
      forall d, doc, id | d in post.devices && doc in post.server.history && id in post.server.history[doc]
        && id in post.server.revisions && post.server.revisions[id].device == d
        ensures doc in post.devices[d].journal.documents
      {
        KeepMember(pre.server.history[doc], FeedIds(post.server.feed), id);
        assert id in pre.server.history[doc] && pre.server.revisions[id] == post.server.revisions[id];
      }
    }
    forall d | ReadsFeed(post, d) ensures OwnRevisionsAcknowledged(post, d) {
      RestoreReadsFeed(step, d);
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
  // server before.
  lemma AppendShortCut(pre: Server, doc: DocId, r: Revision, cut: Server)
    requires r.id !in pre.feed
    requires EarlierServer(Appended(pre, doc, r), cut) && |cut.feed| <= |pre.feed|
    ensures EarlierServer(pre, cut)
  {
    var post := Appended(pre, doc, r);
    var kept := FeedIds(cut.feed);
    assert cut.feed == pre.feed[..|cut.feed|];
    assert r.id !in kept by {
      if r.id in kept {
        var i :| 0 <= i < |cut.feed| && cut.feed[i] == r.id;
        assert pre.feed[i] == r.id;
      }
    }
    assert cut.revisions == (map id | id in pre.revisions && id in kept :: pre.revisions[id]);
    var h := if doc in pre.history then pre.history[doc] else [];
    KeepAppendOut(h, r.id, kept);
    assert Keep([], kept) == [];
    forall x ensures x in pre.history && |Keep(pre.history[x], kept)| > 0 <==> x in cut.history {
      if x == doc {
        assert post.history[doc] == h + [r.id];
      } else if x in pre.history {
        assert post.history[x] == pre.history[x];
      }
    }
    forall x | x in cut.history ensures cut.history[x] == Keep(pre.history[x], kept) {
      if x == doc {
        assert post.history[doc] == h + [r.id];
      } else {
        assert post.history[x] == pre.history[x];
      }
    }
    var m := map x | x in pre.history && |Keep(pre.history[x], kept)| > 0 :: Keep(pre.history[x], kept);
    assert cut.history.Keys == m.Keys;
    assert cut.history == m;
  }

  // Every id in a reachable server's history is on its feed.
  lemma HistoryOnFeed(s: State)
    requires CoreReachable(s)
    ensures forall x, e :: x in s.server.history && e in s.server.history[x] ==> e in FeedIds(s.server.feed)
  {
    forall x, e | x in s.server.history && e in s.server.history[x]
      ensures e in FeedIds(s.server.feed)
    {
      assert e in s.server.revisions;
      assert e in s.server.feed;
      var i :| 0 <= i < |s.server.feed| && s.server.feed[i] == e;
    }
  }

  // Appending keeps every history id on the feed.
  lemma AppendedHistoryOnFeed(pre: Server, doc: DocId, r: Revision)
    requires forall x, e :: x in pre.history && e in pre.history[x] ==> e in FeedIds(pre.feed)
    ensures var post := Appended(pre, doc, r);
      forall x, e :: x in post.history && e in post.history[x] ==> e in FeedIds(post.feed)
  {
    var post := Appended(pre, doc, r);
    forall x, e | x in post.history && e in post.history[x]
      ensures e in FeedIds(post.feed)
    {
      if e == r.id {
        assert post.feed[|pre.feed|] == r.id;
      } else {
        var h := if doc in pre.history then pre.history[doc] else [];
        if x == doc {
          assert post.history[x] == h + [r.id];
          assert e in h;
          assert doc in pre.history && e in pre.history[doc];
        } else {
          assert post.history[x] == pre.history[x];
          assert x in pre.history && e in pre.history[x];
        }
        assert e in FeedIds(pre.feed);
        var i :| 0 <= i < |pre.feed| && pre.feed[i] == e;
        assert post.feed[i] == e;
      }
    }
  }

  // A cut at a server's whole feed whose history is all on the feed has
  // the server's heads.
  lemma WholeFeedCutHeads(server: Server, cut: Server)
    requires EarlierServer(server, cut) && |cut.feed| == |server.feed|
    requires forall x, e :: x in server.history && e in server.history[x] ==> e in FeedIds(server.feed)
    ensures forall x :: Head(cut, x) == Head(server, x)
  {
    var kept := FeedIds(cut.feed);
    assert cut.feed == server.feed;
    forall x | x in server.history
      ensures Keep(server.history[x], kept) == server.history[x]
    {
      KeepAll(server.history[x], kept);
    }
    forall x ensures Head(cut, x) == Head(server, x) {
      if x in server.history && |server.history[x]| > 0 {
        assert x in cut.history && cut.history[x] == server.history[x];
      }
    }
  }

  // The cut at the whole appended feed has the appended server's heads.
  lemma AppendWholeCut(step: Step, cut: Server)
    requires ServerEventStep(step) && step.event.RestoreFromHistory?
    requires CoreReachable(step.pre)
    requires EarlierServer(step.post.server, cut) && |cut.feed| > |step.pre.server.feed|
    ensures forall x :: Head(cut, x) == Head(step.post.server, x)
  {
    HistoryOnFeed(step.pre);
    assert step.post.server == Appended(step.pre.server, step.event.doc, step.event.revision);
    AppendedHistoryOnFeed(step.pre.server, step.event.doc, step.event.revision);
    WholeFeedCutHeads(step.post.server, cut);
  }

  lemma AppendCuts(step: Step, cut: Server)
    requires ServerEventStep(step) && step.event.RestoreFromHistory?
    requires CoreReachable(step.pre)
    requires EarlierServer(step.post.server, cut)
    ensures |cut.feed| <= |step.pre.server.feed| ==> EarlierServer(step.pre.server, cut)
    ensures |cut.feed| > |step.pre.server.feed| ==> forall x :: Head(cut, x) == Head(step.post.server, x)
  {
    if |cut.feed| <= |step.pre.server.feed| {
      var r := step.event.revision;
      assert r.id !in step.pre.server.feed by {
        if r.id in step.pre.server.feed {
          var i :| 0 <= i < |step.pre.server.feed| && step.pre.server.feed[i] == r.id;
          assert r.id in step.pre.server.accepted;
        }
      }
      assert step.post.server == Appended(step.pre.server, step.event.doc, r);
      AppendShortCut(step.pre.server, step.event.doc, r, cut);
    } else {
      AppendWholeCut(step, cut);
    }
  }

  // An append changes no other document's head (#1078: split out of
  // RestoreFromHistoryKeepsAll, whose context made it seed-fragile).
  // Server-level only.
  lemma AppendedOtherHeads(pre: Server, doc: DocId, r: Revision)
    requires r.id !in pre.revisions
    requires forall x, e :: x in pre.history && e in pre.history[x] ==> e in pre.revisions
    ensures forall x :: x != doc ==> Head(Appended(pre, doc, r), x) == Head(pre, x)
  {
    forall x | x != doc ensures Head(Appended(pre, doc, r), x) == Head(pre, x) {
      if x in pre.history && |pre.history[x]| > 0 {
        assert pre.history[x][|pre.history[x]| - 1] in pre.history[x];
      }
    }
  }

  // An append keeps HistoryFollowsFeed (#1078: split out of
  // RestoreFromHistoryKeepsAll, whose context made it near the time limit).
  // Server-level only.
  lemma {:isolate_assertions} AppendedHistoryFollowsFeed(pre: Server, doc: DocId, r: Revision)
    requires HistoryFollowsFeed(pre) && FeedPositioned(pre) && FeedAccepted(pre)
    requires forall x, e :: x in pre.history && e in pre.history[x] ==> e in pre.revisions
    requires Appendable(pre, doc, r)
    ensures HistoryFollowsFeed(Appended(pre, doc, r))
  {
    var post := Appended(pre, doc, r);
    assert post.feed[|pre.feed|] == r.id;
    forall x, j | x in post.history && 0 <= j < |post.history[x]| && post.history[x][j] in post.revisions
      ensures post.revisions[post.history[x][j]].doc == x && post.history[x][j] in post.feed
    {
      if x == doc && j == |post.history[x]| - 1 {
      } else {
        assert x in pre.history && post.history[x][j] == pre.history[x][j];
      }
    }
    forall i | 0 <= i < |post.feed| && post.feed[i] in post.revisions
      ensures var x := post.revisions[post.feed[i]].doc;
              x in post.history && post.feed[i] in post.history[x]
    {
      if i < |pre.feed| {
        var e := pre.feed[i];
        assert post.feed[i] == e;
        if e == r.id { assert e in pre.accepted; }
        var x := pre.revisions[e].doc;
        if x == doc { assert post.history[doc] == pre.history[doc] + [r.id]; }
      }
    }
    forall x, j, k | x in post.history && 0 <= j < k < |post.history[x]|
      && post.history[x][j] in post.revisions && post.history[x][k] in post.revisions
      ensures post.revisions[post.history[x][j]].position < post.revisions[post.history[x][k]].position
    {
      if x == doc && k == |post.history[x]| - 1 {
        var e := post.history[x][j];
        assert e == pre.history[doc][j] && e in pre.revisions;
        var i :| 0 <= i < |pre.feed| && pre.feed[i] == e;
        assert pre.revisions[e].position == i;
      } else {
        assert x in pre.history;
        assert post.history[x][j] == pre.history[x][j];
        assert post.history[x][k] == pre.history[x][k];
      }
    }
  }

  lemma {:isolate_assertions} RestoreFromHistoryKeepsAll(step: Step)
    requires ServerEventStep(step) && step.event.RestoreFromHistory?
    requires CoreReachable(step.pre)
    ensures CoreReachable(step.post) && StepGuarantees(step)
  {
    ServerClausesKept(step);
    var pre := step.pre;
    var post := step.post;
    var r := step.event.revision;
    var doc := step.event.doc;
    ServerEventDevicePredicates(step);
    assert post == pre.(server := post.server);
    assert post.server == Appended(pre.server, doc, r);
    assert r.id !in pre.server.revisions && r.id !in pre.server.accepted;
    forall d | d in pre.devices ensures Diverged(post, d) == Diverged(pre, d) {
      AppendSameDivergence(step, d);
    }
    assert ServerRetains(pre);
    AppendedOtherHeads(pre.server, doc, r);
    assert Head(post.server, doc) == Some(r);
    forall rev | rev != r.id ensures IsHead(post.server, rev) ==> IsHead(pre.server, rev) {
      if IsHead(post.server, rev) {
        var x :| Head(post.server, x).Some? && Head(post.server, x).value.id == rev;
        assert x != doc;
      }
    }

    // No device is finished after the append: an undiverged one's cursor
    // is on the feed before it.
    forall d | d in post.devices ensures !FinishedSyncing(post, d) {
      if FinishedSyncing(post, d) {
        assert !Diverged(post, d);
        assert !Diverged(pre, d);
        assert false;
      }
    }
    assert MirrorInv(post);
    MirrorImpliesG9(post);
    assert LiveHeadsApart(pre.server);
    assert LiveHeadsApart(post.server);
    assert G7_OneFilePerName(post);
    assert ServerRetains(post) by {
      forall x, rev | x in post.server.history && rev in post.server.history[x] ensures rev in post.server.revisions {
        if x != doc || rev != r.id {
          if x == doc && doc !in pre.server.history {
          } else if x == doc {
            assert post.server.history[doc] == pre.server.history[doc] + [r.id];
          }
        }
      }
      forall rev | rev in post.server.accepted
        ensures InHistory(post.server, rev)
          || (!post.server.accepted[rev].deleted
              && exists d :: d in post.devices && OnDisk(post.devices[d], post.server.accepted[rev].content))
          || (rev in post.server.purged && !IsHead(post.server, rev))
          || rev in post.server.lost
      {
        if rev == r.id {
          assert r.id in post.server.history[doc];
        } else if InHistory(pre.server, rev) {
          var x :| x in pre.server.history && rev in pre.server.history[x];
          if x == doc { assert post.server.history[doc] == pre.server.history[doc] + [r.id]; }
          assert rev in post.server.history[x];
        }
      }
    }
    forall rev | rev in post.server.accepted
      ensures Retrievable(post, rev) || (rev in post.server.purged && !IsHead(post.server, rev)) || rev in post.server.lost
    {
    }
    assert G1_Retained(post);
    assert G1_LatestNeverPurged(post);
    assert StateInvariants(post);
    assert CoreInv(post);
    assert FeedPositioned(post.server);
    assert ServerRetains(pre);
    AppendedHistoryFollowsFeed(pre.server, doc, r);
    assert HistoryFollowsFeed(post.server);
    assert RevisionsAccepted(post.server);
    assert JournalsNameAccepted(post);
    assert CutsHeadsApart(post.server) by {
      forall cut | EarlierServer(post.server, cut) ensures LiveHeadsApart(cut) {
        AppendCuts(step, cut);
      }
    }
    forall d, i | ReadsFeed(post, d) && 0 <= i < post.devices[d].journal.cursor
      && i < |post.server.feed| && post.server.feed[i] in post.server.revisions
      ensures var rv := post.server.revisions[post.server.feed[i]];
          rv.doc in post.devices[d].journal.documents
          && KnownPosition(post.devices[d].journal.documents[rv.doc]).Some?
          && KnownPosition(post.devices[d].journal.documents[rv.doc]).value >= rv.position
    {
      AppendReadsFeed(step, d);
      assert i < |pre.server.feed|;
      assert post.server.feed[i] == pre.server.feed[i];
      assert pre.server.feed[i] != r.id;
    }
    assert ClaimsCoverCursor(post);
    assert OwnDocsKnown(post) by {
      forall d, x, id | d in post.devices && x in post.server.history && id in post.server.history[x]
        && id in post.server.revisions && post.server.revisions[id].device == d
        ensures x in post.devices[d].journal.documents
      {
        assert id != r.id;
        if x == doc && doc in pre.server.history { assert post.server.history[doc] == pre.server.history[doc] + [r.id]; }
        assert x in pre.server.history && id in pre.server.history[x];
      }
    }
    forall d | ReadsFeed(post, d) ensures OwnRevisionsAcknowledged(post, d) {
      AppendReadsFeed(step, d);
      forall x, id | Unacknowledged(post, d, x, id)
        ensures post.devices[d].journal.documents[x].outbox.Some?
             && post.devices[d].journal.documents[x].outbox.value.rev == id
      {
        assert id != r.id;
        if x == doc { assert post.server.history[doc] == pre.server.history[doc] + [r.id]; }
        assert Unacknowledged(pre, d, x, id);
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
      AppendCuts(step, cut);
      assert pre.(server := cut) == post.(server := cut);
    }
    assert MirrorAtCursor(post);
    assert G1_OnlyRetentionRemoves(step);
  }

  // ---------------------------------------------------------------------
  // The contract
  // ---------------------------------------------------------------------

  // The server clauses #1063 added to ClaimsReachable: every server step
  // keeps FeedAccepted (an append adds the id to the feed and to
  // `accepted`, a restore from backup cuts the feed and keeps `accepted`, a
  // purge changes neither) and RevisionsKeyed (an append stores the
  // revision under its id, a restore restricts the revisions, a purge
  // changes none), and RevisionsOnFeed (#1078: an append adds the
  // revision to the feed, a restore keeps only revisions its cut feed
  // names). They hold initially (InitialCoreReachable).
  lemma ServerClausesKept(step: Step)
    requires ServerFollowsEvent(step)
    requires FeedAccepted(step.pre.server) && RevisionsKeyed(step.pre.server) && RevisionsOnFeed(step.pre.server)
    ensures FeedAccepted(step.post.server) && RevisionsKeyed(step.post.server) && RevisionsOnFeed(step.post.server)
  {
    var pre := step.pre.server;
    var post := step.post.server;
    if step.event.Restore? {
      forall i | 0 <= i < |post.feed| ensures post.feed[i] in post.accepted {
        assert post.feed[i] == pre.feed[i];
      }
      forall id | id in post.revisions ensures id in post.feed {
        var i :| 0 <= i < |post.feed| && post.feed[i] == id;
      }
    } else if step.event.RestoreFromHistory? {
      ServerAppendedRevisionsOnFeed(pre, step.event.doc, step.event.revision);
    }
  }

  // An append adds its revision to the feed (#1078).
  lemma ServerAppendedRevisionsOnFeed(pre: Server, doc: DocId, r: Revision)
    requires RevisionsOnFeed(pre)
    ensures RevisionsOnFeed(Appended(pre, doc, r))
  {
    var post := Appended(pre, doc, r);
    assert post.feed[|pre.feed|] == r.id;
    forall id | id in post.revisions ensures id in post.feed {
      if id != r.id {
        assert id in pre.feed;
        var i :| 0 <= i < |pre.feed| && pre.feed[i] == id;
        assert post.feed[i] == id;
      }
    }
  }

  // With FeedAccepted, an appended id is not on the feed before it
  // (Appendable takes an id never accepted).
  lemma AppendedIdOffFeed(server: Server, doc: DocId, r: Revision)
    requires FeedAccepted(server) && Appendable(server, doc, r)
    ensures r.id !in server.feed
  {
  }

  // ServerEventContract's cursor clause (#1063, #950's gap A): a purge
  // changes nothing Diverged reads, and a restore from history only extends
  // the feed and the revisions, so a device on the feed stays on it with
  // its anchor in place and its journal's revisions held.
  lemma ServerEventKeepsCursors(step: Step)
    requires step.event.Purge? || step.event.RestoreFromHistory?
    requires ServerFollowsEvent(step) && step.post.devices == step.pre.devices
    ensures KeepsCursors(step)
  {
    forall d | d in step.pre.devices && !Diverged(step.pre, d) ensures !Diverged(step.post, d) {
      var journal := step.pre.devices[d].journal;
      assert step.pre.server.feed <= step.post.server.feed;
      assert step.pre.server.revisions.Keys <= step.post.server.revisions.Keys;
      if journal.cursor > 0 {
        assert step.post.server.feed[journal.cursor - 1] == step.pre.server.feed[journal.cursor - 1];
      }
    }
  }

  // CommitsOnBase (#1080) is kept by every server event. A purge changes
  // nothing it reads. A restore from history appends a revision of no
  // syncing device, last on the feed, so after every landed commit; and it
  // only adds to `accepted`. A restore from backup keeps `accepted`, and
  // keeps a subset of the revisions and of each history; a device that
  // reads the restored feed read it before (RestoreReadsFeed).
  lemma {:isolate_assertions} ServerEventKeepsCommitsOnBase(step: Step)
    requires ServerEventStep(step) && CoreReachable(step.pre) && CommitsOnBase(step.pre)
    ensures CommitsOnBase(step.post)
  {
    var pre := step.pre.server;
    var post := step.post.server;
    forall d, doc | ReadsFeed(step.post, d) && doc in step.post.devices[d].journal.documents
      ensures OutboxParentAtBase(post, step.post.devices[d].journal.documents[doc])
      ensures OwnCommitOnBase(post, d, doc, step.post.devices[d].journal.documents[doc])
    {
      var document := step.pre.devices[d].journal.documents[doc];
      if step.event.Purge? {
        assert ReadsFeed(step.pre, d);
      } else if step.event.Restore? {
        RestoreReadsFeed(step, d);
        RestoredIsCut(step);
        if document.outbox.Some? && document.outbox.value.rev in post.revisions
           && post.revisions[document.outbox.value.rev].device == d && doc in post.history
        {
          var landed := post.revisions[document.outbox.value.rev];
          assert landed == pre.revisions[document.outbox.value.rev];
          forall id | id in post.history[doc] && id in post.revisions && id != landed.id
            && post.revisions[id].position < landed.position
            ensures document.base.Some? && post.revisions[id].position <= document.base.value.position
          {
            var kept := set i | 0 <= i < |post.feed| :: post.feed[i];
            KeepMember(pre.history[doc], kept, id);
            assert post.revisions[id] == pre.revisions[id];
          }
        }
      } else {
        var r := step.event.revision;
        AppendReadsFeed(step, d);
        assert r.device != d;
        if document.outbox.Some? && document.outbox.value.rev in post.revisions
           && post.revisions[document.outbox.value.rev].device == d && doc in post.history
        {
          var o := document.outbox.value.rev;
          assert o != r.id && o in pre.revisions;
          var landed := pre.revisions[o];
          assert o in pre.feed;
          var i :| 0 <= i < |pre.feed| && pre.feed[i] == o;
          assert landed.position == i < |pre.feed|;
          forall id | id in post.history[doc] && id in post.revisions && id != landed.id
            && post.revisions[id].position < landed.position
            ensures document.base.Some? && post.revisions[id].position <= document.base.value.position
          {
            if id == r.id {
              assert post.revisions[id].position == |pre.feed|;
              assert false;
            }
            assert id in pre.history[doc];
          }
        }
      }
    }
  }

  // ServerEventContract (#950), proved for a restore from backup, a purge
  // and a restore from history, with the clauses #1063 settled.
  lemma ServerEventsKeepAll(step: Step)
    ensures ServerEventContract(step)
  {
    if (step.event.Restore? || step.event.Purge? || step.event.RestoreFromHistory?)
      && CoreReachable(step.pre) && ServerFollowsEvent(step)
      && step.post.devices == step.pre.devices && step.effects == []
    {
      assert ServerEventStep(step);
      if step.event.Purge? {
        PurgeKeepsAll(step);
        ServerEventKeepsCursors(step);
      } else if step.event.Restore? {
        RestoreKeepsAll(step);
      } else {
        RestoreFromHistoryKeepsAll(step);
        ServerEventKeepsCursors(step);
      }
    }
  }
}
