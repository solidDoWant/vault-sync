// The cursor's claims imply the mirror at every cursor (#1031, settled by
// #1063, docs/design/verified-core.md §4.1): ClaimsImplyMirrorContract.
// A device finished against a cut at its cursor holds, as the newest claim
// of each document it knows, exactly the cut's head of that document; so
// its files mirror the cut's live heads, apart from a file it keeps under
// a head it cannot hold (KeepsUnheld), and every live head is on it, out
// of its scope, or reported.
include "../spec/Contracts.dfy"

abstract module ClaimsMirror refines StepContracts {

  lemma KeepMember(s: seq<RevId>, ids: set<RevId>, x: RevId)
    ensures x in Keep(s, ids) <==> x in s && x in ids
  {
    if |s| > 0 {
      KeepMember(s[1..], ids, x);
      assert s == [s[0]] + s[1..];
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

  // A kept entry other than the last kept one comes before it in the
  // sequence. Sequence-level only, so it is checked without server facts.
  lemma KeptBeforeLast(s: seq<RevId>, ids: set<RevId>, x: RevId) returns (a: int, b: int)
    requires x in Keep(s, ids) && x != Keep(s, ids)[|Keep(s, ids)| - 1]
    ensures 0 <= a < b < |s| && s[a] == x && s[b] == Keep(s, ids)[|Keep(s, ids)| - 1]
  {
    var ks := Keep(s, ids);
    var m :| 0 <= m < |ks| && ks[m] == x;
    assert m < |ks| - 1;
    a, b := KeepOrder(s, ids, m, |ks| - 1);
  }

  // The hypotheses of MirrorAtCursor for one device and one cut.
  ghost predicate FinishedAtCut(state: State, d: DeviceId, cut: Server) {
    d in state.devices && !Diverged(state, d)
    && state.devices[d].journal.cursor <= |state.server.feed|
    && |cut.feed| == state.devices[d].journal.cursor && EarlierServer(state.server, cut)
    && FinishedSyncing(state.(server := cut), d)
  }

  // The cut's head of a document whose history holds a kept id is the
  // last kept entry of that history, an entry of the cut's feed; positions
  // growing along a history (HistoryFollowsFeed), the kept id is that head
  // or older than it. Server-level only, so the order argument is proved
  // without the reachable state's clauses in scope.
  lemma {:isolate_assertions} CutHeadIsNewestKept(S: Server, cut: Server, doc: DocId, id: RevId) returns (h: RevId)
    requires EarlierServer(S, cut) && HistoryFollowsFeed(S) && FeedPositioned(S)
    requires doc in S.history && id in S.history[doc] && id in S.revisions
    requires forall e :: e in S.history[doc] ==> e in S.revisions
    requires exists i :: 0 <= i < |cut.feed| && cut.feed[i] == id
    ensures doc in cut.history && |cut.history[doc]| > 0 && h == cut.history[doc][|cut.history[doc]| - 1]
    ensures h in S.revisions && Head(cut, doc) == Some(S.revisions[h])
    ensures S.revisions[h].doc == doc && S.revisions[h].position < |cut.feed|
    ensures S.feed[S.revisions[h].position] == h && S.feed[S.revisions[h].position] in S.revisions
    ensures id == h || S.revisions[id].position < S.revisions[h].position
  {
    var kept := set i | 0 <= i < |cut.feed| :: cut.feed[i];
    var hist := S.history[doc];
    assert id in kept;
    KeepMember(hist, kept, id);
    var ks := Keep(hist, kept);
    assert |ks| > 0;
    assert doc in cut.history && cut.history[doc] == ks;
    h := ks[|ks| - 1];
    KeepMember(hist, kept, h);
    assert h in hist && h in kept && h in S.revisions;
    assert h in cut.revisions && cut.revisions[h] == S.revisions[h];
    assert Head(cut, doc) == Some(S.revisions[h]);
    var mh :| 0 <= mh < |hist| && hist[mh] == h;
    assert S.revisions[h].doc == doc;
    var jj :| 0 <= jj < |cut.feed| && cut.feed[jj] == h;
    assert S.feed[jj] == h;
    assert S.revisions[h].position == jj;
    if id != h {
      var a, b := KeptBeforeLast(hist, kept, id);
      assert 0 <= a < b < |S.history[doc]| && S.history[doc][a] in S.revisions && S.history[doc][b] in S.revisions;
      assert S.revisions[S.history[doc][a]].position < S.revisions[S.history[doc][b]].position;
    }
  }

  // The revision a finished device's newest claim of a document names is
  // on the cut's feed, in its document's history, at the claim's position.
  lemma {:isolate_assertions} ClaimOnCut(state: State, d: DeviceId, cut: Server, doc: DocId) returns (id: RevId)
    requires ClaimsCore(state) && FinishedAtCut(state, d, cut)
    requires doc in state.devices[d].journal.documents
    requires KnownPosition(state.devices[d].journal.documents[doc]).Some?
    ensures var S := state.server; var document := state.devices[d].journal.documents[doc];
      id in S.revisions && doc in S.history && id in S.history[doc]
      && (exists i :: 0 <= i < |cut.feed| && cut.feed[i] == id)
      && S.revisions[id].position == KnownPosition(document).value
      && (document.ahead.Some? ==> S.revisions[id] == document.ahead.value.revision)
      && (document.ahead.None? ==> document.base.Some? && BaseRecords(document.base.value, doc, S.revisions[id]))
  {
    var S := state.server;
    var journal := state.devices[d].journal;
    var document := journal.documents[doc];
    assert JournalOnServer(cut, journal);
    id := if document.ahead.Some? then document.ahead.value.revision.id else document.base.value.rev;
    assert id in cut.revisions;
    var kept := set i | 0 <= i < |cut.feed| :: cut.feed[i];
    assert id in kept && id in S.revisions;
    var i :| 0 <= i < |cut.feed| && cut.feed[i] == id;
    assert S.feed[i] == id;
    var R := S.revisions[id];
    assert id in S.accepted && S.accepted[id] == R;
    if document.ahead.Some? {
      assert R == document.ahead.value.revision;
    } else {
      assert BaseRecords(document.base.value, doc, R);
    }
    assert R.doc == doc;
    assert R.position == i;
    assert KnownPosition(document).value == i;
    assert doc in S.history && id in S.history[doc];
  }

  // The newest claim a finished device has of a document it knows is the
  // cut's head of it: the claim's revision is in the cut (ClaimOnCut); the
  // cut's head is the last entry of that history the cut keeps
  // (CutHeadIsNewestKept), read by the device too, so the claim is at
  // least as new (ClaimsCoverCursor) and, positions growing along a
  // history, is that head.
  lemma {:isolate_assertions} ClaimIsCutHead(state: State, d: DeviceId, cut: Server, doc: DocId)
    requires ClaimsCore(state) && FinishedAtCut(state, d, cut)
    requires doc in state.devices[d].journal.documents
    requires KnownPosition(state.devices[d].journal.documents[doc]).Some?
    ensures Head(cut, doc).Some?
    ensures var document := state.devices[d].journal.documents[doc];
      (document.ahead.Some? ==> Head(cut, doc).value == document.ahead.value.revision)
      && (document.ahead.None? ==> document.base.Some? && BaseRecords(document.base.value, doc, Head(cut, doc).value))
  {
    var S := state.server;
    var journal := state.devices[d].journal;
    var id := ClaimOnCut(state, d, cut, doc);
    forall e | e in S.history[doc] ensures e in S.revisions {}
    var h := CutHeadIsNewestKept(S, cut, doc, id);
    var H := S.revisions[h];
    assert H.position < journal.cursor;
    assert KnownPosition(journal.documents[H.doc]).value >= H.position;
    assert id == h;
  }

  lemma {:isolate_assertions} MirrorAtCut(state: State, d: DeviceId, cut: Server)
    requires ClaimsCore(state) && FinishedAtCut(state, d, cut)
    ensures FilesMirrorHeads(state.(server := cut), state.devices[d])
    ensures HeadsMirrored(state.(server := cut), state.devices[d])
  {
    var at := state.(server := cut);
    var device := state.devices[d];
    var journal := device.journal;
    assert at.devices[d] == device;
    assert InStep(device);
    forall p | p in device.disk && p !in device.outOfScope
      ensures KeepsUnheld(at, device, p)
        || (exists doc :: LiveHead(cut, doc)
              && SameNameModuloFolders(device.platform, p, Head(cut, doc).value.path)
              && Head(cut, doc).value.content == device.disk[p].content)
    {
      var doc :| BoundTo(device, doc, p)
         && journal.documents[doc].binding.value.seen == device.disk[p].content
         && journal.documents[doc].base.Some?
         && !journal.documents[doc].base.value.deleted
         && journal.documents[doc].base.value.content == device.disk[p].content
         && SameNameModuloFolders(device.platform, p, journal.documents[doc].base.value.path);
      ClaimIsCutHead(state, d, cut, doc);
      if journal.documents[doc].ahead.Some? {
        assert CannotHold(journal.documents[doc].ahead.value.blocker);
        assert KeepsUnheld(at, device, p);
      } else {
        assert LiveHead(cut, doc);
      }
    }
    forall doc | LiveHead(cut, doc)
      ensures var head := Head(cut, doc).value;
        (exists q :: q in device.disk
           && SameNameModuloFolders(device.platform, q, head.path)
           && device.disk[q].content == head.content)
        || head.path in device.outOfScope
        || ReportedCannotHold(at, device, head.path)
    {
      var S := state.server;
      var H := Head(cut, doc).value;
      var ks := cut.history[doc];
      var h := ks[|ks| - 1];
      var kept := set i | 0 <= i < |cut.feed| :: cut.feed[i];
      assert h in cut.revisions && h in kept && h in S.revisions && H == S.revisions[h];
      assert doc in S.history && ks == Keep(S.history[doc], kept);
      KeepMember(S.history[doc], kept, h);
      var mh :| 0 <= mh < |S.history[doc]| && S.history[doc][mh] == h;
      assert H.doc == doc;
      var jj :| 0 <= jj < |cut.feed| && cut.feed[jj] == h;
      assert S.feed[jj] == h;
      assert jj < journal.cursor && jj < |S.feed| && S.feed[jj] in S.revisions;
      assert doc in journal.documents && KnownPosition(journal.documents[doc]).Some?;
      ClaimIsCutHead(state, d, cut, doc);
      var document := journal.documents[doc];
      if document.ahead.Some? {
        assert CannotHold(document.ahead.value.blocker);
        assert document.ahead.value.revision == H;
        assert ReportedCannotHold(at, device, H.path);
      } else {
        var base := document.base.value;
        assert BaseRecords(base, doc, H);
        assert !base.deleted;
        assert document.binding.Some?;
        var s := document.binding.value.spelling;
        assert document.outbox.None?;
        assert !AheadOfBase(document);
        assert base.path == s && base.content == document.binding.value.seen;
        var q :| q in device.disk && SameF(device.platform, q, s);
        if q in device.outOfScope {
          assert s in device.outOfScope;
        } else {
          var other :| BoundTo(device, other, q)
            && journal.documents[other].base.Some?
            && journal.documents[other].base.value.content == device.disk[q].content
            && SameNameModuloFolders(device.platform, q, journal.documents[other].base.value.path);
          if other != doc {
            assert G5_NeverJoined(state);
            assert SameF(device.platform, journal.documents[other].binding.value.spelling, s);
            assert false;
          }
          assert device.disk[q].content == H.content;
        }
      }
    }
  }

  // The server with its empty histories dropped: what a restore to its
  // whole feed gives.
  ghost function WholeCut(S: Server): Server {
    S.(history := map doc | doc in S.history && |S.history[doc]| > 0 :: S.history[doc])
  }

  // With every revision on the feed (RevisionsOnFeed), every history entry
  // and purge held (ServerRetains) and no head purged
  // (G1_LatestNeverPurged), WholeCut is the server's cut at its whole feed.
  // Server-level only, so it is checked without the reachable state's
  // clauses in scope.
  lemma {:isolate_assertions} WholeCutIsCut(S: Server)
    requires RevisionsOnFeed(S) && RevisionsKeyed(S) && S.purged <= S.revisions.Keys
    requires forall doc, rev :: doc in S.history && rev in S.history[doc] ==> rev in S.revisions
    requires forall doc :: Head(S, doc).Some? ==> Head(S, doc).value.id !in S.purged
    ensures EarlierServer(S, WholeCut(S))
  {
    var C := WholeCut(S);
    var kept := set i | 0 <= i < |C.feed| :: C.feed[i];
    assert C.feed == S.feed && S.feed[..|C.feed|] == S.feed;
    forall id | id in S.revisions ensures id in kept {
      assert id in S.feed;
      var i :| 0 <= i < |S.feed| && S.feed[i] == id;
    }
    assert C.revisions == (map id | id in S.revisions && id in kept :: S.revisions[id]);
    forall doc | doc in S.history ensures Keep(S.history[doc], kept) == S.history[doc] {
      forall e | e in S.history[doc] ensures e in kept {
        var j :| 0 <= j < |S.history[doc]| && S.history[doc][j] == e;
        assert e in S.revisions;
        assert e in S.feed;
        var i :| 0 <= i < |S.feed| && S.feed[i] == e;
      }
      KeepAll(S.history[doc], kept);
    }
    assert C.history == (map doc | doc in S.history && |Keep(S.history[doc], kept)| > 0 :: Keep(S.history[doc], kept));
    forall id | id in C.purged ensures id in kept {
      assert id in S.revisions;
    }
    assert C.purged <= S.purged * kept;
    forall doc | doc in C.history && |C.history[doc]| > 0
      ensures C.history[doc][|C.history[doc]| - 1] !in C.purged
    {
      var h := S.history[doc][|S.history[doc]| - 1];
      assert h in S.revisions;
      assert Head(S, doc) == Some(S.revisions[h]);
      assert S.revisions[h].id == h;
    }
  }

  // Dropping empty histories changes no head.
  lemma WholeCutHeads(S: Server)
    ensures forall doc :: Head(WholeCut(S), doc) == Head(S, doc)
  {
    forall doc ensures Head(WholeCut(S), doc) == Head(S, doc) {
      if doc in S.history && |S.history[doc]| > 0 {
        assert WholeCut(S).history[doc] == S.history[doc];
      } else {
        assert doc !in WholeCut(S).history;
      }
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

  // A finished device mirrors the server: MirrorAtCut at the whole feed,
  // whose cut has the server's heads and revisions.
  lemma {:isolate_assertions} MirrorFinished(state: State, d: DeviceId)
    requires ClaimsCore(state) && d in state.devices && FinishedSyncing(state, d)
    ensures FilesMirrorHeads(state, state.devices[d]) && HeadsMirrored(state, state.devices[d])
  {
    var C := WholeCut(state.server);
    assert ServerRetains(state) && G1_LatestNeverPurged(state);
    WholeCutIsCut(state.server);
    WholeCutHeads(state.server);
    var at := state.(server := C);
    assert at.devices == state.devices;
    assert !Diverged(state, d);
    assert JournalOnServer(C, state.devices[d].journal);
    assert FinishedSyncing(at, d);
    assert FinishedAtCut(state, d, C);
    MirrorAtCut(state, d, C);
    var device := state.devices[d];
    forall p ensures KeepsUnheld(at, device, p) == KeepsUnheld(state, device, p) {}
    forall p ensures ReportedCannotHold(at, device, p) == ReportedCannotHold(state, device, p) {}
    forall doc ensures LiveHead(C, doc) == LiveHead(state.server, doc) {}
  }

  // #1031's obligation, proved, with MirrorInv from the claims without it
  // (#1078).
  lemma ClaimsImplyMirror()
    ensures ClaimsImplyMirrorContract()
  {
    forall state: State | ClaimsCore(state) ensures MirrorAtCursor(state) && MirrorInv(state) {
      forall d: DeviceId, cut: Server | d in state.devices && !Diverged(state, d)
        && state.devices[d].journal.cursor <= |state.server.feed|
        && |cut.feed| == state.devices[d].journal.cursor && EarlierServer(state.server, cut)
        && FinishedSyncing(state.(server := cut), d)
        ensures FilesMirrorHeads(state.(server := cut), state.devices[d])
          && HeadsMirrored(state.(server := cut), state.devices[d])
      {
        assert FinishedAtCut(state, d, cut);
        MirrorAtCut(state, d, cut);
      }
      forall d | d in state.devices && FinishedSyncing(state, d)
        ensures FilesMirrorHeads(state, state.devices[d]) && HeadsMirrored(state, state.devices[d])
      {
        MirrorFinished(state, d);
      }
    }
  }
}
