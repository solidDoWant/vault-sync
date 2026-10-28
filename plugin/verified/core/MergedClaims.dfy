// The merged steps keep the claims invariants (#1031, settled by #1050 and
// #1063, docs/design/verified-core.md §4.1): a local event, the start-up
// scan, a remote revision, a push refused or not answered, and an accepted
// push each keep every clause of ClaimsReachable. With
// ClaimsImplyMirrorContract (ClaimsMirror.dfy) the post state is then
// CoreReachable; the composition is not stated here, because Dafny 4.11's
// resolver crashes on a module that refines ClaimsMirror.
//
// A remote revision is delivered only to a device that is not Diverged
// (ShellRun: a diverged device's pulled revision waits for its resync); so
// is an accepted push, pending #1031's third gap (an accept can switch a
// diverged device's divergence off).
include "../spec/Contracts.dfy"

abstract module MergedClaims refines StepContracts {

  // ---------------------------------------------------------------------
  // Vocabulary
  // ---------------------------------------------------------------------

  // The clauses of ClaimsReachable that #1025, #1050 and #1063 added.
  ghost predicate ClaimsClauses(state: State) {
    FeedPositioned(state.server) && ClaimsCoverCursor(state)
    && HistoryFollowsFeed(state.server) && RevisionsAccepted(state.server) && JournalsNameAccepted(state)
    && FeedAccepted(state.server) && RevisionsKeyed(state.server) && CutsHeadsApart(state.server)
    && ScopesClosedUnderF(state)
  }

  // JournalsNameAccepted, one row at a time.
  ghost predicate RowNamesAccepted(server: Server, doc: DocId, document: Document) {
    (document.base.Some? ==>
       document.base.value.rev in server.accepted
       && BaseRecords(document.base.value, doc, server.accepted[document.base.value.rev]))
    && (document.ahead.Some? ==>
          document.ahead.value.revision.id in server.accepted
          && document.ahead.value.revision.doc == doc
          && server.accepted[document.ahead.value.revision.id] == document.ahead.value.revision)
  }

  // A row after a step knows of its document at least what it knew before.
  ghost predicate KnowsAtLeast(before: Document, after: Document) {
    KnownPosition(before).Some? ==>
      KnownPosition(after).Some? && KnownPosition(after).value >= KnownPosition(before).value
  }

  // What a step that replaces only device d's journal must show of the new
  // journal: it keeps the cursor, the anchor and every row, names only
  // accepted revisions, forgets no claim, and leaves d diverged if it was.
  ghost predicate ClaimsStep(pre: State, d: DeviceId, journal': Journal) {
    d in pre.devices
    && var journal := pre.devices[d].journal;
    journal' == journal.(documents := journal'.documents)
    && journal.documents.Keys <= journal'.documents.Keys
    && (forall doc :: doc in journal'.documents ==> RowNamesAccepted(pre.server, doc, journal'.documents[doc]))
    && (forall doc :: doc in journal.documents ==> KnowsAtLeast(journal.documents[doc], journal'.documents[doc]))
    && (Diverged(pre, d) ==> Diverged(After(pre, d, journal'), d))
  }

  // ---------------------------------------------------------------------
  // Steps that replace one journal
  // ---------------------------------------------------------------------

  lemma {:isolate_assertions} JournalStepKeepsClaims(pre: State, d: DeviceId, journal': Journal)
    requires ClaimsClauses(pre) && ClaimsStep(pre, d, journal')
    ensures ClaimsClauses(After(pre, d, journal'))
  {
    var post := After(pre, d, journal');
    var journal := pre.devices[d].journal;
    assert post.server == pre.server;
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}
    forall x | x in post.devices ensures Diverged(post, x) ==> Diverged(pre, x) || x == d {}
    assert JournalsNameAccepted(post) by {
      forall x | x in post.devices
        ensures var j := post.devices[x].journal;
          (j.anchor.Some? ==> j.anchor.value in post.server.accepted)
          && forall doc :: doc in j.documents ==> RowNamesAccepted(post.server, doc, j.documents[doc])
      {
        if x != d {
          assert post.devices[x] == pre.devices[x];
          forall doc | doc in pre.devices[x].journal.documents
            ensures RowNamesAccepted(pre.server, doc, pre.devices[x].journal.documents[doc])
          {}
        }
      }
    }
    assert ClaimsCoverCursor(post) by {
      forall x, i | x in post.devices && !Diverged(post, x) && 0 <= i < post.devices[x].journal.cursor
        && i < |post.server.feed| && post.server.feed[i] in post.server.revisions
        ensures var r := post.server.revisions[post.server.feed[i]];
          r.doc in post.devices[x].journal.documents
          && KnownPosition(post.devices[x].journal.documents[r.doc]).Some?
          && KnownPosition(post.devices[x].journal.documents[r.doc]).value >= r.position
      {
        var r := pre.server.revisions[pre.server.feed[i]];
        if x == d {
          assert !Diverged(pre, d);
          assert r.doc in journal.documents && KnownPosition(journal.documents[r.doc]).Some?;
          assert KnowsAtLeast(journal.documents[r.doc], journal'.documents[r.doc]);
        } else {
          assert post.devices[x] == pre.devices[x];
          assert !Diverged(pre, x);
        }
      }
    }
    assert ScopesClosedUnderF(post);
  }

  // A step that keeps every row's base and ahead, and every outbox's id,
  // keeps each device's divergence, and OwnRevisionsAcknowledged.
  ghost predicate RowNamesKept(before: Document, after: Document) {
    after.base == before.base && after.ahead == before.ahead
    && (before.outbox.Some? ==> after.outbox.Some? && after.outbox.value.rev == before.outbox.value.rev)
  }

  ghost predicate KeepsRowNames(journal: Journal, journal': Journal) {
    journal' == journal.(documents := journal'.documents)
    && journal'.documents.Keys == journal.documents.Keys
    && forall doc :: doc in journal.documents ==> RowNamesKept(journal.documents[doc], journal'.documents[doc])
  }

  lemma LocalDocKeepsNames(platform: Platform, document: Document, local: LocalEvent, input: map<Path, Read>, rev: RevId)
    ensures RowNamesKept(document, LocalDoc(platform, document, local, input, rev))
  {
  }

  lemma {:isolate_assertions} LocalKeepsNames(platform: Platform, journal: Journal, local: LocalEvent, input: map<Path, Read>, revs: FreshRevs)
    requires journal.documents.Keys <= revs.Keys
    ensures KeepsRowNames(journal, LocalJournal(platform, journal, local, input, revs))
  {
    var journal' := LocalJournal(platform, journal, local, input, revs);
    forall doc | doc in journal.documents ensures RowNamesKept(journal.documents[doc], journal'.documents[doc]) {
      LocalDocKeepsNames(platform, journal.documents[doc], local, input, revs[doc]);
    }
  }

  lemma ScanDocKeepsNames(platform: Platform, docs: map<DocId, Document>, listing: Listing, doc: DocId, rev: RevId)
    requires doc in docs && ListingDistinct(platform, listing)
    ensures RowNamesKept(docs[doc], ScanDoc(platform, docs, listing, doc, rev))
  {
  }

  lemma {:isolate_assertions} ScanKeepsNames(platform: Platform, journal: Journal, listing: Listing, revs: FreshRevs)
    requires journal.documents.Keys <= revs.Keys && ListingDistinct(platform, listing)
    ensures KeepsRowNames(journal, ScanJournal(platform, journal, listing, revs))
  {
    var journal' := ScanJournal(platform, journal, listing, revs);
    forall doc | doc in journal.documents ensures RowNamesKept(journal.documents[doc], journal'.documents[doc]) {
      ScanDocKeepsNames(platform, journal.documents, listing, doc, revs[doc]);
    }
  }

  lemma PushedKeepsNames(journal: Journal, result: PushResult, nextRev: RevId)
    requires !result.Accepted?
    ensures KeepsRowNames(journal, PushedJournal(journal, result, nextRev))
  {
  }

  lemma {:isolate_assertions} NamesKeptStep(pre: State, d: DeviceId, journal': Journal)
    requires ClaimsReachable(pre) && d in pre.devices && KeepsRowNames(pre.devices[d].journal, journal')
    ensures ClaimsClauses(After(pre, d, journal'))
    ensures forall x :: x in pre.devices ==> Diverged(After(pre, d, journal'), x) == Diverged(pre, x)
    ensures forall x :: x in pre.devices && !Diverged(After(pre, d, journal'), x) ==>
      OwnRevisionsAcknowledged(After(pre, d, journal'), x)
  {
    var post := After(pre, d, journal');
    var journal := pre.devices[d].journal;
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}
    assert JournalOnServer(pre.server, journal') == JournalOnServer(pre.server, journal);
    assert Diverged(post, d) == Diverged(pre, d);
    forall doc | doc in journal'.documents ensures RowNamesAccepted(pre.server, doc, journal'.documents[doc]) {
      assert RowNamesAccepted(pre.server, doc, journal.documents[doc]);
    }
    assert ClaimsStep(pre, d, journal');
    JournalStepKeepsClaims(pre, d, journal');
    forall x | x in post.devices && !Diverged(post, x) ensures OwnRevisionsAcknowledged(post, x) {
      assert !Diverged(pre, x) && OwnRevisionsAcknowledged(pre, x);
      forall doc, id | Unacknowledged(post, x, doc, id)
        ensures post.devices[x].journal.documents[doc].outbox.Some?
             && post.devices[x].journal.documents[doc].outbox.value.rev == id
      {
        assert Unacknowledged(pre, x, doc, id);
      }
    }
  }

  // ---------------------------------------------------------------------
  // The theorems
  // ---------------------------------------------------------------------

  // A push refused, or not answered (#949), with the server unchanged.
  lemma {:isolate_assertions} RefusedKeepsClaims(pre: State, d: DeviceId, result: PushResult, nextRev: RevId)
    requires d in pre.devices && !result.Accepted? && ClaimsReachable(pre)
    ensures var step := RefusedStep(pre, d, result, nextRev);
      ClaimsReachable(step.post) && StepGuarantees(step)
  {
    var step := RefusedStep(pre, d, result, nextRev);
    var journal := pre.devices[d].journal;
    var journal' := PushedJournal(journal, result, nextRev);
    assert step.post == After(pre, d, journal');
    RefusedSafe(pre, d, result, nextRev);
    KeepsFinishedKeepsMirror(step);
    PushedKeepsNames(journal, result, nextRev);
    NamesKeptStep(pre, d, journal');
  }

  // A local event (#948).
  lemma {:isolate_assertions} LocalKeepsClaims(pre: State, d: DeviceId, local: LocalEvent, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys && ClaimsReachable(pre)
    ensures var step := LocalStep(pre, d, local, revs);
      ClaimsReachable(step.post) && StepGuarantees(step)
  {
    var step := LocalStep(pre, d, local, revs);
    var device := pre.devices[d];
    var input := map p | p in LocalEventPaths(local) :: ReadAt(device, p);
    var journal' := LocalJournal(device.platform, device.journal, local, input, revs);
    assert step.post == After(pre, d, journal');
    LocalEventSafe(pre, d, local, revs);
    LocalKeepsServerRetains(pre, d, journal');
    KeepsFinishedKeepsMirror(step);
    LocalKeepsNames(device.platform, device.journal, local, input, revs);
    NamesKeptStep(pre, d, journal');
  }

  // The start-up scan (#948).
  lemma {:isolate_assertions} ScanKeepsClaims(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys && ClaimsReachable(pre)
    ensures ListingDistinct(pre.devices[d].platform, ListingOf(pre.devices[d]))
    ensures var step := ScanStep(pre, d, revs);
      ClaimsReachable(step.post) && StepGuarantees(step)
  {
    var device := pre.devices[d];
    ScanSafe(pre, d, revs);
    var step := ScanStep(pre, d, revs);
    var journal' := ScanJournal(device.platform, device.journal, ListingOf(device), revs);
    assert step.post == After(pre, d, journal');
    LocalKeepsServerRetains(pre, d, journal');
    KeepsFinishedKeepsMirror(step);
    ScanKeepsNames(device.platform, device.journal, ListingOf(device), revs);
    NamesKeptStep(pre, d, journal');
  }

  // A step that changes only a journal's documents keeps ServerRetains
  // (JournalOnlyKeepsServerInv without the cursor clause).
  lemma LocalKeepsServerRetains(pre: State, d: DeviceId, journal': Journal)
    requires d in pre.devices && ServerRetains(pre)
    requires journal' == pre.devices[d].journal.(documents := journal'.documents)
    ensures ServerRetains(After(pre, d, journal'))
  {
    var post := After(pre, d, journal');
    forall rev | rev in post.server.accepted && exists x :: x in pre.devices && OnDisk(pre.devices[x], pre.server.accepted[rev].content)
      ensures exists x :: x in post.devices && OnDisk(post.devices[x], post.server.accepted[rev].content)
    {
      var x := var x0 :| x0 in pre.devices && OnDisk(pre.devices[x0], pre.server.accepted[rev].content); x0;
      assert OnDisk(post.devices[x], post.server.accepted[rev].content);
    }
  }

  // Every document a revision of d's own belongs to has a row in d's
  // journal. Not a clause of ClaimsReachable (#1031, gap 4): a remote
  // revision that creates a row for such a document past d's cursor would
  // leave the own revision unacknowledged with no outbox.
  ghost predicate OwnDocsKnown(state: State, d: DeviceId) {
    d in state.devices
    && forall doc, id :: doc in state.server.history && id in state.server.history[doc]
         && id in state.server.revisions && state.server.revisions[id].device == d
         ==> doc in state.devices[d].journal.documents
  }

  // A remote revision delivered outside a sync round (#949) to a device
  // that is not Diverged (ShellRun).
  lemma {:isolate_assertions} RemoteKeepsClaims(pre: State, d: DeviceId, revision: Revision)
    requires d in pre.devices && ClaimsReachable(pre) && !Diverged(pre, d) && OwnDocsKnown(pre, d)
    requires revision.id in pre.server.revisions && pre.server.revisions[revision.id] == revision
    requires revision.id in pre.server.feed
    ensures var step := RemoteStep(pre, d, revision);
      ClaimsReachable(step.post) && StepGuarantees(step)
  {
    var step := RemoteStep(pre, d, revision);
    var journal := pre.devices[d].journal;
    var journal' := RemoteJournal(journal, revision);
    var post := step.post;
    assert post == After(pre, d, journal');
    RemoteRevisionSafe(pre, d, revision);
    KeepsFinishedKeepsMirror(step);
    var doc := revision.doc;
    forall x | x in journal'.documents ensures RowNamesAccepted(pre.server, x, journal'.documents[x]) {
      if x in journal.documents {
        assert RowNamesAccepted(pre.server, x, journal.documents[x]);
      }
    }
    forall x | x in journal.documents ensures KnowsAtLeast(journal.documents[x], journal'.documents[x]) {}
    assert ClaimsStep(pre, d, journal');
    JournalStepKeepsClaims(pre, d, journal');
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}
    forall x | x in post.devices && !Diverged(post, x) ensures OwnRevisionsAcknowledged(post, x) {
      assert OwnRevisionsAcknowledged(pre, x) by {
        if x != d { assert !Diverged(pre, x); }
      }
      forall y, id | Unacknowledged(post, x, y, id)
        ensures post.devices[x].journal.documents[y].outbox.Some?
             && post.devices[x].journal.documents[y].outbox.value.rev == id
      {
        if x == d {
          assert y in journal.documents;
          assert journal'.documents[y].base == journal.documents[y].base;
          assert journal'.documents[y].outbox == journal.documents[y].outbox;
        }
        assert Unacknowledged(pre, x, y, id);
      }
    }
  }

  // ---------------------------------------------------------------------
  // An accepted push: the server appends the device's commit
  // ---------------------------------------------------------------------

  // Sequence and cut helpers, as in ServerEvents.dfy (no module can
  // refine both).
  ghost function FeedIds(feed: seq<RevId>): set<RevId> {
    set i | 0 <= i < |feed| :: feed[i]
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


  // The server clauses of ClaimsReachable survive an Appendable append
  // whose new heads collide with no other (G7's server clause after it).
  lemma {:isolate_assertions} AppendKeepsServerClauses(pre: Server, doc: DocId, r: Revision)
    requires FeedPositioned(pre) && HistoryFollowsFeed(pre) && RevisionsAccepted(pre)
    requires FeedAccepted(pre) && RevisionsKeyed(pre) && CutsHeadsApart(pre)
    requires forall x, e :: x in pre.history && e in pre.history[x] ==> e in pre.revisions
    requires Appendable(pre, doc, r)
    requires LiveHeadsApart(Appended(pre, doc, r))
    ensures var post := Appended(pre, doc, r);
      FeedPositioned(post) && HistoryFollowsFeed(post) && RevisionsAccepted(post)
      && FeedAccepted(post) && RevisionsKeyed(post) && CutsHeadsApart(post)
  {
    var post := Appended(pre, doc, r);
    assert r.id !in pre.feed by {
      if r.id in pre.feed {
        var i :| 0 <= i < |pre.feed| && pre.feed[i] == r.id;
        assert r.id in pre.accepted;
      }
    }
    assert post.feed[|pre.feed|] == r.id;
    assert FeedPositioned(post) by {
      forall i | 0 <= i < |post.feed| && post.feed[i] in post.revisions
        ensures post.revisions[post.feed[i]].position == i
      {
        if i < |pre.feed| { assert post.feed[i] == pre.feed[i] && pre.feed[i] != r.id; }
      }
    }
    assert HistoryFollowsFeed(post) by {
      forall x, j | x in post.history && 0 <= j < |post.history[x]| && post.history[x][j] in post.revisions
        ensures post.revisions[post.history[x][j]].doc == x && post.history[x][j] in post.feed
      {
        if x == doc && j == |post.history[x]| - 1 {
        } else {
          assert x in pre.history && post.history[x][j] == pre.history[x][j];
          var e := pre.history[x][j];
          assert e in pre.feed;
          var i :| 0 <= i < |pre.feed| && pre.feed[i] == e;
          assert post.feed[i] == e;
          assert e != r.id;
        }
      }
      forall i | 0 <= i < |post.feed| && post.feed[i] in post.revisions
        ensures var x := post.revisions[post.feed[i]].doc;
                x in post.history && post.feed[i] in post.history[x]
      {
        if i < |pre.feed| {
          var e := pre.feed[i];
          assert post.feed[i] == e && e != r.id;
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
          assert e in pre.feed;
          var i :| 0 <= i < |pre.feed| && pre.feed[i] == e;
          assert pre.revisions[e].position == i;
          assert e != r.id;
        } else {
          assert x in pre.history;
          assert post.history[x][j] == pre.history[x][j];
          assert post.history[x][k] == pre.history[x][k];
          assert post.history[x][j] != r.id && post.history[x][k] != r.id by {
            var a := post.history[x][j];
            var b := post.history[x][k];
            assert a in pre.revisions && b in pre.revisions;
          }
        }
      }
    }
    assert FeedAccepted(post) by {
      forall i | 0 <= i < |post.feed| ensures post.feed[i] in post.accepted {
        if i < |pre.feed| { assert post.feed[i] == pre.feed[i]; }
      }
    }
    assert forall x, e :: x in pre.history && e in pre.history[x] ==> e in FeedIds(pre.feed) by {
      forall x, e | x in pre.history && e in pre.history[x] ensures e in FeedIds(pre.feed) {
        var j :| 0 <= j < |pre.history[x]| && pre.history[x][j] == e;
        assert e in pre.feed;
        var i :| 0 <= i < |pre.feed| && pre.feed[i] == e;
      }
    }
    AppendedHistoryOnFeed(pre, doc, r);
    assert CutsHeadsApart(post) by {
      forall cut | EarlierServer(post, cut) ensures LiveHeadsApart(cut) {
        if |cut.feed| <= |pre.feed| {
          AppendShortCut(pre, doc, r, cut);
        } else {
          WholeFeedCutHeads(post, cut);
        }
      }
    }
  }

  // The row an accept leaves names only accepted revisions, and knows at
  // least what the row before it knew.
  lemma AcceptRowClaims(server: Server, doc: DocId, document: Document, r: Revision, nextRev: RevId)
    requires RowNamesAccepted(server, doc, document) && r.doc == doc && r.id !in server.accepted
    ensures RowNamesAccepted(server.(accepted := server.accepted[r.id := r]), doc, Accept(document, r, nextRev))
    ensures KnowsAtLeast(document, Accept(document, r, nextRev))
    ensures Accept(document, r, nextRev).base.Some?
      && Accept(document, r, nextRev).base.value.position >= r.position
  {
  }

  // An accepted push (#949) to a device that is not Diverged (#1031's
  // third gap). Its appended id is named by no journal (JournalsNameAccepted,
  // Appendable), so no other device's divergence changes.
  lemma {:isolate_assertions} AcceptKeepsClaims(pre: State, d: DeviceId, doc: DocId, r: Revision, nextRev: RevId)
    requires AcceptHappens(pre, d, doc, r) && ClaimsReachable(pre) && !Diverged(pre, d)
    ensures var step := AcceptStep(pre, d, doc, r, nextRev);
      ClaimsReachable(step.post) && StepGuarantees(step)
  {
    var step := AcceptStep(pre, d, doc, r, nextRev);
    var journal := pre.devices[d].journal;
    var journal' := PushedJournal(journal, Accepted(doc, r), nextRev);
    var server := pre.server;
    var server' := Appended(server, doc, r);
    var post := step.post;
    assert post == After(pre, d, journal').(server := server');
    assert r.id !in server.accepted && r.id !in server.revisions;
    forall x | x in pre.devices && pre.devices[x].journal.cursor == |server.feed| + 1
      ensures pre.devices[x].journal.anchor != Some(r.id)
    {}
    AcceptSafe(pre, d, doc, r, nextRev);
    KeepsFinishedKeepsMirror(step);
    assert G7_OneFilePerName(post);
    assert LiveHeadsApart(server');
    AppendKeepsServerClauses(server, doc, r);
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}

    // Rows: only doc changes, by Accept.
    forall x | x in journal.documents && x != doc ensures journal'.documents[x] == journal.documents[x] {}
    assert journal'.documents[doc] == Accept(journal.documents[doc], r, nextRev);
    assert RowNamesAccepted(server, doc, journal.documents[doc]);
    AcceptRowClaims(server, doc, journal.documents[doc], r, nextRev);

    // Journals: every id they name was accepted before, so is not r's.
    assert JournalsNameAccepted(post) by {
      forall x | x in post.devices
        ensures var j := post.devices[x].journal;
          (j.anchor.Some? ==> j.anchor.value in server'.accepted)
          && forall y :: y in j.documents ==> RowNamesAccepted(server', y, j.documents[y])
      {
        var j0 := pre.devices[x].journal;
        forall y | y in j0.documents ensures RowNamesAccepted(server, y, j0.documents[y]) {}
        forall y | y in j0.documents && (x != d || y != doc)
          ensures RowNamesAccepted(server', y, post.devices[x].journal.documents[y])
        {
          assert post.devices[x].journal.documents[y] == j0.documents[y];
        }
      }
    }

    // Divergence: no journal names r.id, and an undiverged cursor is on the
    // feed before the append.
    forall x | x in pre.devices ensures Diverged(post, x) == Diverged(pre, x) || (x == d && !Diverged(post, x)) {
      var j0 := pre.devices[x].journal;
      if x != d {
        assert JournalOnServer(server', j0) == JournalOnServer(server, j0) by {
          forall y | y in j0.documents
            ensures (j0.documents[y].base.Some? ==> j0.documents[y].base.value.rev in server'.revisions)
                 == (j0.documents[y].base.Some? ==> j0.documents[y].base.value.rev in server.revisions)
            ensures (j0.documents[y].ahead.Some? ==> j0.documents[y].ahead.value.revision.id in server'.revisions)
                 == (j0.documents[y].ahead.Some? ==> j0.documents[y].ahead.value.revision.id in server.revisions)
          {
            assert RowNamesAccepted(server, y, j0.documents[y]);
          }
        }
        if j0.cursor == |server'.feed| {
          assert server'.feed[j0.cursor - 1] == r.id;
        } else if 0 < j0.cursor <= |server.feed| {
          assert server'.feed[j0.cursor - 1] == server.feed[j0.cursor - 1];
        }
      }
    }

    assert ClaimsCoverCursor(post) by {
      forall x, i | x in post.devices && !Diverged(post, x) && 0 <= i < post.devices[x].journal.cursor
        && i < |server'.feed| && server'.feed[i] in server'.revisions
        ensures var rv := server'.revisions[server'.feed[i]];
          rv.doc in post.devices[x].journal.documents
          && KnownPosition(post.devices[x].journal.documents[rv.doc]).Some?
          && KnownPosition(post.devices[x].journal.documents[rv.doc]).value >= rv.position
      {
        assert !Diverged(pre, x);
        assert i < |server.feed|;
        assert server'.feed[i] == server.feed[i];
        assert server.feed[i] != r.id by { assert server.feed[i] in server.accepted; }
        var rv := server.revisions[server.feed[i]];
        assert rv.doc in pre.devices[x].journal.documents;
        if x == d && rv.doc == doc {
          assert KnowsAtLeast(journal.documents[doc], journal'.documents[doc]);
        }
      }
    }

    forall x | x in post.devices && !Diverged(post, x) ensures OwnRevisionsAcknowledged(post, x) {
      if x != d { assert !Diverged(pre, x); }
      assert OwnRevisionsAcknowledged(pre, x);
      forall y, id | Unacknowledged(post, x, y, id)
        ensures post.devices[x].journal.documents[y].outbox.Some?
             && post.devices[x].journal.documents[y].outbox.value.rev == id
      {
        if id == r.id {
          assert x == d && y == doc by {
            assert server'.revisions[r.id] == r;
            assert r.id in server'.history[y];
            if y != doc { assert y in server.history && r.id in server.history[y]; }
          }
          assert false;
        } else {
          assert id in server.history[y] by {
            if y == doc && doc in server.history {
              assert server'.history[doc] == server.history[doc] + [r.id];
            } else if y == doc {
              assert server'.history[doc] == [r.id];
            }
          }
          if x == d && y == doc {
            assert journal.documents[doc].base.None?
              || journal.documents[doc].base.value.position <= journal'.documents[doc].base.value.position;
            assert Unacknowledged(pre, x, y, id);
            assert false;
          }
          assert Unacknowledged(pre, x, y, id);
        }
      }
    }
    assert ScopesClosedUnderF(post);
  }
}
