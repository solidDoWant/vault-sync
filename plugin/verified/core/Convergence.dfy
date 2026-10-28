// Two finished devices on one feed converge (#963, ConvergenceContract,
// docs/design/verified-core.md §4).
//
// A finished device's base of a document it holds and does not hold back
// is the server's head of that document: the base's revision is a feed
// entry (RevisionsOnFeed, #1078), so it is in its document's history
// (HistoryFollowsFeed); the device read the head (ClaimsCoverCursor), and
// positions grow along a history, so the base is the head. A device with
// no base has no head to read. Two such devices hold one base. No round
// body is needed: the contract is about finished states only.
include "../spec/Contracts.dfy"

abstract module Convergence refines StepContracts {

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
  // server's head of it.
  lemma {:isolate_assertions} FinishedBaseIsHead(state: State, d: DeviceId, doc: DocId)
    requires ClaimsReachable(state) && FinishedSyncing(state, d)
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
    assert id in S.feed;
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
    requires ClaimsReachable(state)
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

  // #963's contract, proved.
  lemma Converges(state: State, d1: DeviceId, d2: DeviceId)
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
}
