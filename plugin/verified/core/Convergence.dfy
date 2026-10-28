// Two finished devices on one feed converge (#963, ConvergenceContract,
// docs/design/verified-core.md §4).
//
// A finished device's base of a document it holds and does not hold back
// is the server's head of that document, when that base is a feed entry:
// the base's revision is then in its document's history (HistoryFollowsFeed),
// the device read the head (ClaimsCoverCursor), and positions grow along a
// history, so the base is the head. Two such devices hold one base.
//
// CoreReachable does not say that every revision the server holds is a
// feed entry (RevisionsOnFeed), and without it the contract fails
// (OffFeedBaseBreaksConvergence): a design gap, filed on #963. Every
// server event and the initial state keep RevisionsOnFeed (the lemmas
// below), and no device step changes the server's revisions or feed.
include "../spec/Contracts.dfy"

abstract module Convergence refines StepContracts {

  // Every revision the server holds is a feed entry: Appended adds a
  // revision to both, a purge changes neither, and a restore from backup
  // restricts the revisions to the ids its cut feed names.
  ghost predicate RevisionsOnFeed(server: Server) {
    forall id :: id in server.revisions ==> exists i :: 0 <= i < |server.feed| && server.feed[i] == id
  }

  // ---------------------------------------------------------------------
  // The server events keep RevisionsOnFeed
  // ---------------------------------------------------------------------

  lemma InitialRevisionsOnFeed(platforms: map<DeviceId, Platform>)
    ensures RevisionsOnFeed(Initial(platforms).server)
  {}

  lemma AppendedRevisionsOnFeed(server: Server, doc: DocId, r: Revision)
    requires RevisionsOnFeed(server)
    ensures RevisionsOnFeed(Appended(server, doc, r))
  {
    var post := Appended(server, doc, r);
    forall id | id in post.revisions
      ensures exists i :: 0 <= i < |post.feed| && post.feed[i] == id
    {
      if id == r.id {
        assert post.feed[|server.feed|] == id;
      } else {
        var i :| 0 <= i < |server.feed| && server.feed[i] == id;
        assert post.feed[i] == id;
      }
    }
  }

  lemma PurgeRevisionsOnFeed(server: Server, revisions: set<RevId>)
    requires RevisionsOnFeed(server)
    ensures RevisionsOnFeed(server.(purged := server.purged + revisions))
  {}

  lemma RestoreRevisionsOnFeed(server: Server, restored: Server, post: Server)
    requires EarlierServer(server, restored)
    requires post == restored.(accepted := server.accepted, lost := server.lost + RestoreRemoves(server, restored))
    ensures RevisionsOnFeed(post)
  {
    var kept := set i | 0 <= i < |restored.feed| :: restored.feed[i];
    forall id | id in post.revisions
      ensures exists i :: 0 <= i < |post.feed| && post.feed[i] == id
    {
      assert id in kept;
    }
  }

  // ---------------------------------------------------------------------
  // A finished device's base is the head
  // ---------------------------------------------------------------------

  // A revision of `doc` the device read is in `doc`'s history and on the
  // feed, so `doc`'s head is on the feed and the device read it too.
  lemma {:isolate_assertions} HeadOnFeed(state: State, doc: DocId) returns (jj: int)
    requires ClaimsReachable(state) && Head(state.server, doc).Some?
    ensures 0 <= jj < |state.server.feed| && state.server.feed[jj] in state.server.revisions
    ensures state.server.revisions[state.server.feed[jj]] == Head(state.server, doc).value
    ensures Head(state.server, doc).value.doc == doc && Head(state.server, doc).value.position == jj
  {
    var S := state.server;
    var hist := S.history[doc];
    var h := hist[|hist| - 1];
    assert h in S.revisions;
    assert S.revisions[h].doc == doc && h in S.feed;
    jj :| 0 <= jj < |S.feed| && S.feed[jj] == h;
  }

  // A finished device knows every document the server has a head of.
  lemma {:isolate_assertions} FinishedKnowsHead(state: State, d: DeviceId, doc: DocId)
    requires ClaimsReachable(state) && FinishedSyncing(state, d) && Head(state.server, doc).Some?
    ensures doc in state.devices[d].journal.documents
    ensures KnownPosition(state.devices[d].journal.documents[doc]).Some?
    ensures KnownPosition(state.devices[d].journal.documents[doc]).value >= Head(state.server, doc).value.position
  {
    var jj := HeadOnFeed(state, doc);
    assert ReadsFeed(state, d);
    assert jj < state.devices[d].journal.cursor;
  }

  // The base of a document a finished device does not hold back is the
  // server's head of it, when the base's revision is a feed entry.
  lemma {:isolate_assertions} FinishedBaseIsHead(state: State, d: DeviceId, doc: DocId)
    requires ClaimsReachable(state) && RevisionsOnFeed(state.server) && FinishedSyncing(state, d)
    requires doc in state.devices[d].journal.documents
    requires state.devices[d].journal.documents[doc].ahead.None?
    requires state.devices[d].journal.documents[doc].base.Some?
    ensures Head(state.server, doc).Some?
    ensures BaseRecords(state.devices[d].journal.documents[doc].base.value, doc, Head(state.server, doc).value)
  {
    var S := state.server;
    var base := state.devices[d].journal.documents[doc].base.value;
    var id := base.rev;
    assert JournalOnServer(S, state.devices[d].journal);
    assert id in S.revisions;
    var R := S.revisions[id];
    assert BaseRecords(base, doc, S.accepted[id]);
    assert S.accepted[id] == R;
    assert RevisionsOnFeed(S);
    var i :| 0 <= i < |S.feed| && S.feed[i] == id;
    assert R.doc == doc;
    assert S.feed[i] in S.revisions && S.revisions[S.feed[i]].doc == doc;
    assert HistoryFollowsFeed(S);
    assert doc in S.history && id in S.history[doc];
    var hist := S.history[doc];
    var m :| 0 <= m < |hist| && hist[m] == id;
    var h := hist[|hist| - 1];
    assert h in S.revisions;
    assert Head(S, doc) == Some(S.revisions[h]);
    FinishedKnowsHead(state, d, doc);
    assert R.position >= S.revisions[h].position;
    if m < |hist| - 1 {
      assert 0 <= m < |hist| - 1 < |S.history[doc]| && hist[m] in S.revisions;
      assert S.revisions[hist[m]].position < S.revisions[hist[|hist| - 1]].position;
      assert false;
    }
    assert id == h;
  }

  // Two finished devices hold one base of a document neither holds back:
  // a base is the head, and a device with no base has no head to read (it
  // would know it, FinishedKnowsHead), so neither has one.
  lemma {:isolate_assertions} FinishedBasesAgree(state: State, d1: DeviceId, d2: DeviceId, doc: DocId)
    requires ClaimsReachable(state) && RevisionsOnFeed(state.server)
    requires FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
    requires doc in state.devices[d1].journal.documents && doc in state.devices[d2].journal.documents
    requires state.devices[d1].journal.documents[doc].ahead.None?
    requires state.devices[d2].journal.documents[doc].ahead.None?
    ensures state.devices[d1].journal.documents[doc].base == state.devices[d2].journal.documents[doc].base
  {
    var b1 := state.devices[d1].journal.documents[doc].base;
    var b2 := state.devices[d2].journal.documents[doc].base;
    if b1.Some? {
      FinishedBaseIsHead(state, d1, doc);
      FinishedKnowsHead(state, d2, doc);
      FinishedBaseIsHead(state, d2, doc);
    } else if b2.Some? {
      FinishedBaseIsHead(state, d2, doc);
      FinishedKnowsHead(state, d1, doc);
    }
  }

  // ConvergenceContract, given RevisionsOnFeed.
  lemma ConvergenceOnFeed(state: State, d1: DeviceId, d2: DeviceId)
    requires RevisionsOnFeed(state.server)
    ensures ConvergenceContract(state, d1, d2)
  {
    if CoreReachable(state) && FinishedSyncing(state, d1) && FinishedSyncing(state, d2) {
      forall doc | doc in state.devices[d1].journal.documents && doc in state.devices[d2].journal.documents
        && state.devices[d1].journal.documents[doc].ahead.None?
        && state.devices[d2].journal.documents[doc].ahead.None?
        ensures state.devices[d1].journal.documents[doc].base == state.devices[d2].journal.documents[doc].base
      {
        FinishedBasesAgree(state, d1, d2, doc);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Without RevisionsOnFeed the contract fails (the design gap on #963)
  // ---------------------------------------------------------------------

  // Two devices hold document x at the same path and content, d1 with
  // base `a` (the feed's only entry and x's head) and d2 with base `b`, a
  // revision of x the server holds that is no feed entry and in no
  // history. ServerRetains excuses `b` (its content is on a disk),
  // ClaimsCoverCursor holds (b's position is a's), and no cut a restore can
  // give holds `b`, so MirrorAtCursor holds of d2 vacuously. No reachable
  // server has such a `b` (RevisionsOnFeed), but CoreReachable does not say
  // so.
  ghost function OffFeedRow(r: Revision): Document {
    Document(Some(Base(r.id, r.position, r.path, r.content, r.kind, r.deleted)), None,
             Some(Binding(r.path, r.content, false, None)), Never, None)
  }

  ghost function OffFeedDevice(platform: Platform, x: DocId, r: Revision, anchor: RevId, file: DiskFile): Device {
    Device(platform, true, Journal(map[x := OffFeedRow(r)], 1, [], [], Some(anchor)), map[r.path := file], {}, {})
  }

  ghost function OffFeedServer(x: DocId, a: Revision, b: Revision): Server {
    Server(map[a.id := a, b.id := b], map[x := [a.id]], [a.id], {}, map[a.id := a, b.id := b])
  }

  ghost function OffFeedState(d1: DeviceId, d2: DeviceId, platform: Platform, x: DocId, a: Revision, b: Revision, file: DiskFile): State {
    State(map[d1 := OffFeedDevice(platform, x, a, a.id, file), d2 := OffFeedDevice(platform, x, b, a.id, file)],
          OffFeedServer(x, a, b))
  }

  ghost predicate OffFeedHypotheses(d1: DeviceId, d2: DeviceId, e: DeviceId, x: DocId, a: Revision, b: Revision, file: DiskFile) {
    d1 != d2 && e != d1 && e != d2 && a.id != b.id
    && a == Revision(a.id, x, 0, None, a.path, a.content, Note, false, e)
    && b == Revision(b.id, x, 0, None, a.path, a.content, Note, false, e)
    && file.content == a.content && file.kind == Note
  }

  // The only cut at the devices' cursor is the server without `b`.
  lemma {:isolate_assertions} OffFeedCut(x: DocId, a: Revision, b: Revision, cut: Server)
    requires a.id != b.id && a.doc == x
    requires EarlierServer(OffFeedServer(x, a, b), cut)
    ensures |cut.feed| <= 1 && cut.history.Keys <= {x}
    ensures |cut.feed| == 1 ==> cut.feed == [a.id] && cut.revisions == map[a.id := a] && cut.history == map[x := [a.id]]
    ensures |cut.feed| == 0 ==> cut.revisions == map[] && cut.history == map[]
  {
    var S := OffFeedServer(x, a, b);
    var kept := set i | 0 <= i < |cut.feed| :: cut.feed[i];
    assert Keep([], kept) == [];
    assert [a.id][1..] == [];
    if |cut.feed| == 1 {
      assert cut.feed == [a.id];
      assert kept == {a.id};
      assert Keep(S.history[x], kept) == [a.id];
    } else {
      assert kept == {};
      assert Keep(S.history[x], kept) == [];
    }
  }

  lemma {:isolate_assertions} OffFeedServerClauses(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                                                    a: Revision, b: Revision, file: DiskFile)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    ensures FeedPositioned(OffFeedServer(x, a, b)) && HistoryFollowsFeed(OffFeedServer(x, a, b))
    ensures RevisionsAccepted(OffFeedServer(x, a, b)) && FeedAccepted(OffFeedServer(x, a, b))
    ensures RevisionsKeyed(OffFeedServer(x, a, b))
    ensures CutsHeadsApart(OffFeedServer(x, a, b))
    ensures ServerRetains(OffFeedState(d1, d2, platform, x, a, b, file))
    ensures Head(OffFeedServer(x, a, b), x) == Some(a)
    ensures forall doc :: doc != x ==> Head(OffFeedServer(x, a, b), doc).None?
    ensures !RevisionsOnFeed(OffFeedServer(x, a, b))
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    var S := state.server;
    assert S.feed[0] == a.id && S.history[x][0] == a.id;
    assert OnDisk(state.devices[d1], b.content) by { assert state.devices[d1].disk[a.path] == file; }
    assert ServerRetains(state);
    forall cut | EarlierServer(S, cut) ensures LiveHeadsApart(cut) {
      OffFeedCut(x, a, b, cut);
    }
    assert b.id in S.revisions && |S.feed| == 1 && S.feed[0] != b.id;
    assert !(exists i :: 0 <= i < |S.feed| && S.feed[i] == b.id);
  }

  lemma {:isolate_assertions} OffFeedDeviceClauses(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                                                    a: Revision, b: Revision, file: DiskFile)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    ensures var state := OffFeedState(d1, d2, platform, x, a, b, file);
      FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
      && !Diverged(state, d1) && !Diverged(state, d2)
      && ReadsFeed(state, d1) && ReadsFeed(state, d2)
      && JournalsNameAccepted(state) && ClaimsCoverCursor(state) && CoreInv(state)
      && OwnDocsKnown(state) && OwnRevisionsAcknowledged(state, d1) && OwnRevisionsAcknowledged(state, d2)
      && ScopesClosedUnderF(state) && G5_NeverJoined(state)
      && state.devices[d1].journal.documents[x].base != state.devices[d2].journal.documents[x].base
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    var S := state.server;
    OffFeedServerClauses(d1, d2, e, platform, x, a, b, file);
    SameFIsEquivalence(platform, a.path, a.path, a.path);
    SameNameModuloFoldersRefl(platform, a.path);
    assert state.devices.Keys == {d1, d2};
    forall d | d in state.devices
      ensures state.devices[d].journal.documents.Keys == {x}
      ensures state.devices[d].disk.Keys == {a.path}
      ensures BoundTo(state.devices[d], x, a.path)
    {}
    assert FinishedSyncing(state, d1);
    assert FinishedSyncing(state, d2);
    assert S.feed[0] == a.id;
    assert ClaimsCoverCursor(state);
    assert JournalsNameAccepted(state);
  }

  lemma OffFeedMirrorInv(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                          a: Revision, b: Revision, file: DiskFile)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    ensures MirrorInv(OffFeedState(d1, d2, platform, x, a, b, file))
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    OffFeedServerClauses(d1, d2, e, platform, x, a, b, file);
    SameNameModuloFoldersRefl(platform, a.path);
    assert LiveHead(state.server, x);
    forall d | d in state.devices
      ensures FilesMirrorHeads(state, state.devices[d]) && HeadsMirrored(state, state.devices[d])
    {
      assert state.devices[d].disk.Keys == {a.path};
      assert state.devices[d].disk[a.path] == file;
    }
  }

  lemma OffFeedMirrorAtCut(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                           a: Revision, b: Revision, file: DiskFile, d: DeviceId, cut: Server)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    requires d in {d1, d2} && EarlierServer(OffFeedServer(x, a, b), cut) && |cut.feed| == 1
    ensures var state := OffFeedState(d1, d2, platform, x, a, b, file);
      FilesMirrorHeads(state.(server := cut), state.devices[d]) && HeadsMirrored(state.(server := cut), state.devices[d])
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    OffFeedCut(x, a, b, cut);
    SameNameModuloFoldersRefl(platform, a.path);
    var device := state.devices[d];
    assert device.disk.Keys == {a.path} && device.disk[a.path] == file;
    assert Head(cut, x) == Some(a);
    assert LiveHead(cut, x);
  }

  lemma OffFeedMirrorAtCursor(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                              a: Revision, b: Revision, file: DiskFile)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    ensures MirrorAtCursor(OffFeedState(d1, d2, platform, x, a, b, file))
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    forall d: DeviceId, cut: Server | d in state.devices && !Diverged(state, d)
      && state.devices[d].journal.cursor <= |state.server.feed|
      && |cut.feed| == state.devices[d].journal.cursor && EarlierServer(state.server, cut)
      && FinishedSyncing(state.(server := cut), d)
      ensures FilesMirrorHeads(state.(server := cut), state.devices[d])
        && HeadsMirrored(state.(server := cut), state.devices[d])
    {
      OffFeedMirrorAtCut(d1, d2, e, platform, x, a, b, file, d, cut);
    }
  }

  lemma OffFeedG1(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                  a: Revision, b: Revision, file: DiskFile)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    ensures G1_Retained(OffFeedState(d1, d2, platform, x, a, b, file))
    ensures G1_LatestNeverPurged(OffFeedState(d1, d2, platform, x, a, b, file))
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    var S := state.server;
    assert state.devices[d1].disk[a.path] == file;
    assert OnDisk(state.devices[d1], a.content);
    forall rev | rev in S.accepted ensures Retrievable(state, rev) {
      assert S.accepted[rev].content == a.content && !S.accepted[rev].deleted;
    }
  }

  lemma OffFeedG7(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                  a: Revision, b: Revision, file: DiskFile)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    ensures G7_OneFilePerName(OffFeedState(d1, d2, platform, x, a, b, file))
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    OffFeedServerClauses(d1, d2, e, platform, x, a, b, file);
    forall d | d in state.devices ensures state.devices[d].disk.Keys == {a.path} {}
  }

  lemma OffFeedStateInvariants(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                               a: Revision, b: Revision, file: DiskFile)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    ensures StateInvariants(OffFeedState(d1, d2, platform, x, a, b, file))
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    OffFeedDeviceClauses(d1, d2, e, platform, x, a, b, file);
    OffFeedMirrorInv(d1, d2, e, platform, x, a, b, file);
    MirrorImpliesG9(state);
    OffFeedG1(d1, d2, e, platform, x, a, b, file);
    OffFeedG7(d1, d2, e, platform, x, a, b, file);
  }

  // The state is CoreReachable, both devices are finished, and they hold x
  // at different bases: ConvergenceContract fails.
  lemma {:isolate_assertions} OffFeedBaseBreaksConvergence(d1: DeviceId, d2: DeviceId, e: DeviceId, platform: Platform, x: DocId,
                                     a: Revision, b: Revision, file: DiskFile)
    requires OffFeedHypotheses(d1, d2, e, x, a, b, file)
    ensures var state := OffFeedState(d1, d2, platform, x, a, b, file);
      CoreReachable(state) && FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
      && !RevisionsOnFeed(state.server) && !ConvergenceContract(state, d1, d2)
  {
    var state := OffFeedState(d1, d2, platform, x, a, b, file);
    OffFeedServerClauses(d1, d2, e, platform, x, a, b, file);
    OffFeedDeviceClauses(d1, d2, e, platform, x, a, b, file);
    OffFeedMirrorInv(d1, d2, e, platform, x, a, b, file);
    OffFeedMirrorAtCursor(d1, d2, e, platform, x, a, b, file);
    OffFeedStateInvariants(d1, d2, e, platform, x, a, b, file);
    var S := state.server;
    assert StateInvariants(state) && CoreInv(state) && ServerRetains(state) && MirrorInv(state);
    assert FeedPositioned(S) && ClaimsCoverCursor(state);
    assert HistoryFollowsFeed(S) && RevisionsAccepted(S) && JournalsNameAccepted(state);
    assert FeedAccepted(S) && RevisionsKeyed(S) && CutsHeadsApart(S);
    assert ScopesClosedUnderF(state) && OwnDocsKnown(state);
    assert state.devices.Keys == {d1, d2};
    assert forall d :: ReadsFeed(state, d) ==> OwnRevisionsAcknowledged(state, d);
    assert ClaimsReachable(state);
    assert CoreReachable(state);
    var doc1 := state.devices[d1].journal.documents[x];
    var doc2 := state.devices[d2].journal.documents[x];
    assert doc1.binding.Some? && doc2.binding.Some? && doc1.ahead.None? && doc2.ahead.None?;
    assert doc1.base != doc2.base;
  }
}
