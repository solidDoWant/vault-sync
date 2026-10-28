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

  // The hypotheses of MirrorAtCursor for one device and one cut.
  ghost predicate FinishedAtCut(state: State, d: DeviceId, cut: Server) {
    d in state.devices && !Diverged(state, d)
    && state.devices[d].journal.cursor <= |state.server.feed|
    && |cut.feed| == state.devices[d].journal.cursor && EarlierServer(state.server, cut)
    && FinishedSyncing(state.(server := cut), d)
  }

  // The newest claim a finished device has of a document it knows is the
  // cut's head of it: the claim's revision is in the cut (JournalOnServer),
  // so at a feed index below the cursor (FeedPositioned) and in its
  // document's history (HistoryFollowsFeed); the cut's head is the last
  // entry of that history the cut keeps, read by the device too, so the
  // claim is at least as new (ClaimsCoverCursor) and, positions growing
  // along a history, is that head.
  lemma {:isolate_assertions} ClaimIsCutHead(state: State, d: DeviceId, cut: Server, doc: DocId)
    requires ClaimsReachable(state) && FinishedAtCut(state, d, cut)
    requires doc in state.devices[d].journal.documents
    requires KnownPosition(state.devices[d].journal.documents[doc]).Some?
    ensures Head(cut, doc).Some?
    ensures var document := state.devices[d].journal.documents[doc];
      (document.ahead.Some? ==> Head(cut, doc).value == document.ahead.value.revision)
      && (document.ahead.None? ==> document.base.Some? && BaseRecords(document.base.value, doc, Head(cut, doc).value))
  {
    var S := state.server;
    var device := state.devices[d];
    var journal := device.journal;
    var document := journal.documents[doc];
    assert JournalOnServer(cut, journal);
    var id := if document.ahead.Some? then document.ahead.value.revision.id else document.base.value.rev;
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
    var hist := S.history[doc];
    KeepMember(hist, kept, id);
    var ks := Keep(hist, kept);
    assert |ks| > 0;
    assert doc in cut.history && cut.history[doc] == ks by {
      assert doc in S.history && |Keep(S.history[doc], kept)| > 0;
    }
    var h := ks[|ks| - 1];
    KeepMember(hist, kept, h);
    assert h in hist && h in kept;
    assert h in S.revisions;
    assert h in cut.revisions && cut.revisions[h] == S.revisions[h];
    var H := S.revisions[h];
    assert cut.history[doc][|cut.history[doc]| - 1] == h;
    assert Head(cut, doc) == Some(cut.revisions[h]);
    assert Head(cut, doc) == Some(H);
    var jj :| 0 <= jj < |cut.feed| && cut.feed[jj] == h;
    assert S.feed[jj] == h;
    assert H.position == jj;
    var mh :| 0 <= mh < |hist| && hist[mh] == h;
    assert H.doc == doc;
    assert jj < journal.cursor && jj < |S.feed| && S.feed[jj] in S.revisions;
    assert KnownPosition(journal.documents[H.doc]).value >= H.position;
    assert i >= jj;
    if id != h {
      var m :| 0 <= m < |ks| && ks[m] == id;
      assert m < |ks| - 1;
      var a, b := KeepOrder(hist, kept, m, |ks| - 1);
      assert hist[a] == id && hist[b] == h;
      assert R.position < H.position;
      assert false;
    }
    assert H == R;
  }

  lemma {:isolate_assertions} MirrorAtCut(state: State, d: DeviceId, cut: Server)
    requires ClaimsReachable(state) && FinishedAtCut(state, d, cut)
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

  // #1031's obligation, proved.
  lemma ClaimsImplyMirror()
    ensures ClaimsImplyMirrorContract()
  {
    forall state: State | ClaimsReachable(state) ensures MirrorAtCursor(state) {
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
    }
  }
}
