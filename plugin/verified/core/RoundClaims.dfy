// The sync round keeps the journal claims (#1090, part 1 of #1034's split).
//
// The round (RoundStepOf: RetryWaiting, then SettlePulled, then OnPush)
// changes only its device's journal and disk and leaves the server as it
// was (RoundStepEffects). Each journal claim of ClaimsCore is proved here
// as a pass invariant: it holds of the rows each SettleRevision leaves,
// so of the rows RetryWaiting and SettlePulled leave (by induction over the
// revisions), and of the rows the push leaves. #1034 assembles these with
// #1091's step guarantees into RoundKeepsNoLoss. The spec is untouched:
// OwnRevisionsAcknowledged (G9's claim) is left to the oracle (#1047,
// #1048).
include "PathRule.dfy"

abstract module RoundClaimsCore refines PathRuleCore {

  // ---------------------------------------------------------------------
  // The round's passes, unfolded
  // ---------------------------------------------------------------------

  // The pass the round starts from, and the claims its rule reads.
  ghost function StartPass(journal: Journal, input: RoundInput): RoundPass {
    RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0)
  }

  // What the round's pull reads, and where it leaves the cursor and the
  // anchor (RoundStepOf).
  ghost function PulledOf(pre: State, d: DeviceId): seq<Revision>
    requires d in pre.devices
  {
    var journal := pre.devices[d].journal;
    var feed := pre.server.feed;
    if journal.cursor < |feed| then Revisions(pre.server, feed[journal.cursor..]) else []
  }

  ghost function CursorOf(pre: State, d: DeviceId): nat
    requires d in pre.devices
  {
    var journal := pre.devices[d].journal;
    if journal.cursor < |pre.server.feed| then |pre.server.feed| else journal.cursor
  }

  ghost function AnchorOf(pre: State, d: DeviceId): Option<RevId>
    requires d in pre.devices
  {
    var journal := pre.devices[d].journal;
    var feed := pre.server.feed;
    if journal.cursor < |feed| then Some(feed[|feed| - 1]) else journal.anchor
  }

  predicate FreshIn(input: RoundInput, revs: FreshRevs) {
    forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
  }

  // The round changes only its device's journal and disk: the journal is
  // OnRound's, or (with too few revision ids) the one before.
  lemma RoundStepJournal(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures var post := RoundStepOf(pre, d, input, revs).post;
      post.server == pre.server && post.devices.Keys == pre.devices.Keys
      && (forall x | x in pre.devices && x != d :: post.devices[x] == pre.devices[x])
      && post.devices[d].platform == pre.devices[d].platform
      && post.devices[d].outOfScope == pre.devices[d].outOfScope
      && post.devices[d].journal
         == (if FreshIn(input, revs)
             then OnRound(pre.devices[d].platform, pre.devices[d].journal, PulledOf(pre, d), CursorOf(pre, d), AnchorOf(pre, d), input, revs).0
             else pre.devices[d].journal)
  {}

  // The round's pre-state is reachable and its hypotheses hold
  // (RoundContract's left-hand side).
  ghost predicate RoundHypotheses(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs) {
    d in pre.devices && pre.devices[d].running && CoreReachable(pre) && !Diverged(pre, d)
    && RoundInputOf(pre, d, input) && FreshDocsSuffice(pre, d, input)
    && RevsCover(pre.devices[d].journal, input, revs)
  }

  // ---------------------------------------------------------------------
  // The server is unchanged
  // ---------------------------------------------------------------------

  // The clauses of ClaimsCore that read only the server and the devices'
  // scopes: the round keeps the server (RoundStepEffects) and no step
  // changes a scope.
  ghost predicate ServerClaims(state: State) {
    FeedPositioned(state.server) && RevisionsOnFeed(state.server)
    && HistoryFollowsFeed(state.server) && RevisionsAccepted(state.server)
    && FeedAccepted(state.server) && RevisionsKeyed(state.server) && CutsHeadsApart(state.server)
    && ScopesClosedUnderF(state)
  }

  lemma {:isolate_assertions} RoundKeepsServerClaims(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && ServerClaims(pre)
    ensures ServerClaims(RoundStepOf(pre, d, input, revs).post)
  {
    RoundStepEffects(pre, d, input, revs);
    var post := RoundStepOf(pre, d, input, revs).post;
    assert post.server == pre.server;
    assert post.devices.Keys == pre.devices.Keys;
    assert forall x | x in post.devices :: post.devices[x].outOfScope == pre.devices[x].outOfScope
                                        && post.devices[x].platform == pre.devices[x].platform;
    assert ScopesClosedUnderF(post);
  }

  // ---------------------------------------------------------------------
  // CoreInv: every row keeps RowInv
  // ---------------------------------------------------------------------

  ghost predicate RowsInv(documents: map<DocId, Document>) {
    forall e | e in documents :: RowInv(documents[e])
  }

  lemma NoRowInv()
    ensures RowInv(NoRow())
  {}

  lemma SettleKeepsRowsInv(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsInv(pass.journal.documents)
    ensures var pass' := SettleRevision(platform, pass, doc, r, input, revs, first);
      RowsInv(pass'.journal.documents) && pass.journal.documents.Keys <= pass'.journal.documents.Keys
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    NoRowInv();
    if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
      var rows := documents[doc := row];
      RuleKeepsRowInv(platform, rows, doc, r, input.(listing := pass.listing), RevsFor(rows, revs, r), first);
    }
  }

  lemma SettlePulledKeepsRowsInv(platform: Platform, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsInv(pass.journal.documents)
    ensures var pass' := SettlePulled(platform, pass, revisions, input, revs, first);
      RowsInv(pass'.journal.documents) && pass.journal.documents.Keys <= pass'.journal.documents.Keys
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsRowsInv(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettlePulledKeepsRowsInv(platform, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsRowsInv(platform: Platform, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsInv(pass.journal.documents)
    ensures var pass' := RetryWaiting(platform, pass, docs, input, revs, first);
      RowsInv(pass'.journal.documents) && pass.journal.documents.Keys <= pass'.journal.documents.Keys
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        SettleKeepsRowsInv(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryKeepsRowsInv(platform, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsRowsInv(platform, pass, docs[1..], input, revs, first);
      }
    }
  }

  // The rows the round leaves keep RowInv, and every row it started from
  // is still there.
  lemma {:isolate_assertions} OnRoundKeepsRowsInv(platform: Platform, journal: Journal, pulled: seq<Revision>, cursor': nat, anchor': Option<RevId>,
                                                  input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    requires RowsInv(journal.documents)
    ensures var journal' := OnRound(platform, journal, pulled, cursor', anchor', input, revs).0;
      RowsInv(journal'.documents) && journal.documents.Keys <= journal'.documents.Keys
  {
    var start := StartPass(journal, input);
    var first := RoundClaims(platform, journal, input);
    RetryKeepsRowsInv(platform, start, WaitingRows(journal.documents), input, revs, first);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    SettlePulledKeepsRowsInv(platform, retried, pulled, input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    PushCreatesFromFreshIds(platform, read, input', revs);
  }

  // Clause CoreInv.
  lemma {:isolate_assertions} RoundKeepsCoreInv(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && CoreInv(pre)
    ensures CoreInv(RoundStepOf(pre, d, input, revs).post)
  {
    var post := RoundStepOf(pre, d, input, revs).post;
    RoundStepJournal(pre, d, input, revs);
    CoreInvRows(pre);
    if FreshIn(input, revs) {
      OnRoundKeepsRowsInv(pre.devices[d].platform, pre.devices[d].journal, PulledOf(pre, d), CursorOf(pre, d), AnchorOf(pre, d), input, revs);
    }
    CoreInvRows(post);
  }


  // ---------------------------------------------------------------------
  // OwnDocsKnown: the round drops no row
  // ---------------------------------------------------------------------

  // Clause OwnDocsKnown: the server is unchanged and the round's device
  // keeps every row (OnRoundKeepsRowsInv), so every document holding a
  // revision of a device's own still has its row.
  lemma {:isolate_assertions} RoundKeepsOwnDocsKnown(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && CoreInv(pre) && OwnDocsKnown(pre)
    ensures OwnDocsKnown(RoundStepOf(pre, d, input, revs).post)
  {
    RoundStepJournal(pre, d, input, revs);
    CoreInvRows(pre);
    if FreshIn(input, revs) {
      OnRoundKeepsRowsInv(pre.devices[d].platform, pre.devices[d].journal, PulledOf(pre, d), CursorOf(pre, d), AnchorOf(pre, d), input, revs);
    }
  }


  // ---------------------------------------------------------------------
  // JournalsNameAccepted: every name the rule records comes from the
  // revision it settles
  // ---------------------------------------------------------------------

  // The row a revision `r` settles keeps its base or takes `r`'s, and
  // keeps its ahead, clears it, or makes `r` its ahead.
  ghost predicate NamesFrom(before: Document, after: Document, r: Revision) {
    (after.base == before.base || after.base == Some(BaseOf(r)))
    && (after.ahead.None? || after.ahead == before.ahead || after.ahead.value.revision == r)
  }

  // Every other row keeps its base and its ahead.
  ghost predicate KeepsNames(before: Document, after: Document) {
    after.base == before.base && after.ahead == before.ahead
  }

  lemma ApplyNamesFrom(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures NamesFrom(document, ApplyRevision(platform, doc, document, r, input, bound, claims, rev).document, r)
  {}

  lemma MoveRowsKeepNames(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs)
    requires documents.Keys <= revs.Keys
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      rows.Keys == documents.Keys && forall e | e in documents :: KeepsNames(documents[e], rows[e])
  {
    MoveRowsKeepAheadAboveBase(platform, documents, doc, moves, revs);
  }

  lemma {:isolate_assertions} RuleNamesFrom(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      ruled.documents.Keys == documents.Keys
      && NamesFrom(documents[doc], ruled.documents[doc], r)
      && forall e | e in documents && e != doc :: KeepsNames(documents[e], ruled.documents[e])
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    ApplyNamesFrom(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? {
        MoveRowsKeepNames(platform, documents, doc, aside.value, revs);
      }
    }
  }

  // A revision the server accepted, as it accepted it.
  ghost predicate AcceptedAs(accepted: map<RevId, Revision>, r: Revision) {
    r.id in accepted && accepted[r.id] == r
  }

  // JournalsNameAccepted's clause on a journal's rows.
  ghost predicate RowsNameAccepted(accepted: map<RevId, Revision>, documents: map<DocId, Document>) {
    forall e | e in documents ::
      var document := documents[e];
      (document.base.Some? ==>
         document.base.value.rev in accepted && BaseRecords(document.base.value, e, accepted[document.base.value.rev]))
      && (document.ahead.Some? ==>
            document.ahead.value.revision.doc == e && AcceptedAs(accepted, document.ahead.value.revision))
  }

  lemma SettleNamesAccepted(platform: Platform, accepted: map<RevId, Revision>, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsNameAccepted(accepted, pass.journal.documents)
    requires AcceptedAs(accepted, r) && r.doc == doc
    ensures RowsNameAccepted(accepted, SettleRevision(platform, pass, doc, r, input, revs, first).journal.documents)
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
      var rows := documents[doc := row];
      RuleNamesFrom(platform, rows, doc, r, input.(listing := pass.listing), RevsFor(rows, revs, r), first);
    }
  }

  lemma SettlePulledNamesAccepted(platform: Platform, accepted: map<RevId, Revision>, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsNameAccepted(accepted, pass.journal.documents)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    ensures RowsNameAccepted(accepted, SettlePulled(platform, pass, revisions, input, revs, first).journal.documents)
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleNamesAccepted(platform, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledNamesAccepted(platform, accepted, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryNamesAccepted(platform: Platform, accepted: map<RevId, Revision>, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsNameAccepted(accepted, pass.journal.documents)
    ensures RowsNameAccepted(accepted, RetryWaiting(platform, pass, docs, input, revs, first).journal.documents)
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        SettleNamesAccepted(platform, accepted, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryNamesAccepted(platform, accepted, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryNamesAccepted(platform, accepted, pass, docs[1..], input, revs, first);
      }
    }
  }

  lemma PushNamesAccepted(platform: Platform, accepted: map<RevId, Revision>, journal: Journal, input: RoundInput, revs: FreshRevs)
    requires FreshIn(input, revs)
    requires RowsNameAccepted(accepted, journal.documents)
    ensures RowsNameAccepted(accepted, OnPush(platform, journal, input, revs).0.documents)
  {
    var docs := Created(platform, journal, input, revs);
    assert forall e | e in docs && e !in journal.documents :: docs[e].base.None? && docs[e].ahead.None?;
  }

  // Every revision the pull reads is one the server holds, under its id.
  lemma RevisionsHeld(server: Server, ids: seq<RevId>)
    requires RevisionsKeyed(server)
    ensures forall r | r in Revisions(server, ids) :: r.id in server.revisions && server.revisions[r.id] == r
    decreases |ids|
  {
    if |ids| > 0 {
      RevisionsHeld(server, ids[1..]);
      assert Revisions(server, ids) == (if ids[0] in server.revisions then [server.revisions[ids[0]]] else []) + Revisions(server, ids[1..]);
    }
  }

  lemma {:isolate_assertions} OnRoundNamesAccepted(platform: Platform, accepted: map<RevId, Revision>, journal: Journal, pulled: seq<Revision>,
                                                   cursor': nat, anchor': Option<RevId>, input: RoundInput, revs: FreshRevs)
    requires FreshIn(input, revs)
    requires RowsNameAccepted(accepted, journal.documents)
    requires forall i | 0 <= i < |pulled| :: AcceptedAs(accepted, pulled[i])
    ensures RowsNameAccepted(accepted, OnRound(platform, journal, pulled, cursor', anchor', input, revs).0.documents)
  {
    var start := StartPass(journal, input);
    var first := RoundClaims(platform, journal, input);
    RetryNamesAccepted(platform, accepted, start, WaitingRows(journal.documents), input, revs, first);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    SettlePulledNamesAccepted(platform, accepted, retried, pulled, input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    PushNamesAccepted(platform, accepted, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
  }

  // Clause JournalsNameAccepted.
  lemma {:isolate_assertions} RoundKeepsNamesAccepted(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && JournalsNameAccepted(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server) && FeedAccepted(pre.server)
    ensures JournalsNameAccepted(RoundStepOf(pre, d, input, revs).post)
  {
    var post := RoundStepOf(pre, d, input, revs).post;
    var accepted := pre.server.accepted;
    RoundStepJournal(pre, d, input, revs);
    var journal := pre.devices[d].journal;
    assert RowsNameAccepted(accepted, journal.documents);
    if FreshIn(input, revs) {
      var pulled := PulledOf(pre, d);
      if journal.cursor < |pre.server.feed| {
        var ids := pre.server.feed[journal.cursor..];
        var held := Revisions(pre.server, ids);
        assert pulled == held;
        RevisionsHeld(pre.server, ids);
        forall i | 0 <= i < |held| ensures AcceptedAs(accepted, held[i]) {
          assert held[i] in held;
        }
      } else {
        assert pulled == [];
      }
      OnRoundNamesAccepted(pre.devices[d].platform, accepted, journal, pulled, CursorOf(pre, d), AnchorOf(pre, d), input, revs);
      PushKeepsReadPosition(pre.devices[d].platform, journal, input, revs);
      var journal' := post.devices[d].journal;
      assert RowsNameAccepted(accepted, journal'.documents);
      OnRoundEffects(pre.devices[d].platform, journal, pulled, CursorOf(pre, d), AnchorOf(pre, d), input, revs);
      assert journal'.anchor == AnchorOf(pre, d);
      assert journal'.anchor.Some? ==> journal'.anchor.value in accepted;
    }
    assert forall x | x in post.devices :: RowsNameAccepted(accepted, post.devices[x].journal.documents);
  }

  // ---------------------------------------------------------------------
  // OutboxParentsAccepted: an outbox keeps its parent or takes its base's
  // id, which the server accepted (RowsNameAccepted)
  // ---------------------------------------------------------------------

  ghost predicate RowsParentsAccepted(accepted: map<RevId, Revision>, documents: map<DocId, Document>) {
    forall e | e in documents && documents[e].outbox.Some? && documents[e].outbox.value.baseRev.Some? ::
      documents[e].outbox.value.baseRev.value in accepted
  }

  lemma {:isolate_assertions} SettleParentsAccepted(platform: Platform, accepted: map<RevId, Revision>, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsNameAccepted(accepted, pass.journal.documents) && RowsParentsAccepted(accepted, pass.journal.documents)
    requires AcceptedAs(accepted, r) && r.doc == doc
    ensures var documents' := SettleRevision(platform, pass, doc, r, input, revs, first).journal.documents;
      RowsNameAccepted(accepted, documents') && RowsParentsAccepted(accepted, documents')
  {
    SettleNamesAccepted(platform, accepted, pass, doc, r, input, revs, first);
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
      var rows := documents[doc := row];
      var revs' := RevsFor(rows, revs, r);
      var input' := input.(listing := pass.listing);
      RuleKeepsParent(platform, rows, doc, r, input', revs', first);
      var after := PathRule(platform, rows, doc, r, input', revs', first).documents;
      assert after == SettleRevision(platform, pass, doc, r, input, revs, first).journal.documents;
      forall e | e in after && after[e].outbox.Some? && after[e].outbox.value.baseRev.Some?
        ensures after[e].outbox.value.baseRev.value in accepted
      {
        assert ParentKeptOrBase(rows[e], after[e]);
        if !(rows[e].outbox.Some? && after[e].outbox.value.baseRev == rows[e].outbox.value.baseRev) {
          assert after[e].base.Some?;
        }
      }
    }
  }

  lemma SettlePulledParentsAccepted(platform: Platform, accepted: map<RevId, Revision>, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsNameAccepted(accepted, pass.journal.documents) && RowsParentsAccepted(accepted, pass.journal.documents)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    ensures var documents' := SettlePulled(platform, pass, revisions, input, revs, first).journal.documents;
      RowsNameAccepted(accepted, documents') && RowsParentsAccepted(accepted, documents')
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleParentsAccepted(platform, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledParentsAccepted(platform, accepted, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryParentsAccepted(platform: Platform, accepted: map<RevId, Revision>, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RowsNameAccepted(accepted, pass.journal.documents) && RowsParentsAccepted(accepted, pass.journal.documents)
    ensures var documents' := RetryWaiting(platform, pass, docs, input, revs, first).journal.documents;
      RowsNameAccepted(accepted, documents') && RowsParentsAccepted(accepted, documents')
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        SettleParentsAccepted(platform, accepted, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryParentsAccepted(platform, accepted, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryParentsAccepted(platform, accepted, pass, docs[1..], input, revs, first);
      }
    }
  }

  lemma PushParentsAccepted(platform: Platform, accepted: map<RevId, Revision>, journal: Journal, input: RoundInput, revs: FreshRevs)
    requires FreshIn(input, revs)
    requires RowsNameAccepted(accepted, journal.documents) && RowsParentsAccepted(accepted, journal.documents)
    ensures RowsParentsAccepted(accepted, OnPush(platform, journal, input, revs).0.documents)
  {
    PushKeepsParents(platform, journal, input, revs);
  }

  lemma {:isolate_assertions} OnRoundParentsAccepted(platform: Platform, accepted: map<RevId, Revision>, journal: Journal, pulled: seq<Revision>,
                                                     cursor': nat, anchor': Option<RevId>, input: RoundInput, revs: FreshRevs)
    requires FreshIn(input, revs)
    requires RowsNameAccepted(accepted, journal.documents) && RowsParentsAccepted(accepted, journal.documents)
    requires forall i | 0 <= i < |pulled| :: AcceptedAs(accepted, pulled[i])
    ensures RowsParentsAccepted(accepted, OnRound(platform, journal, pulled, cursor', anchor', input, revs).0.documents)
  {
    var start := StartPass(journal, input);
    var first := RoundClaims(platform, journal, input);
    RetryParentsAccepted(platform, accepted, start, WaitingRows(journal.documents), input, revs, first);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    SettlePulledParentsAccepted(platform, accepted, retried, pulled, input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    PushParentsAccepted(platform, accepted, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
  }

  // The revisions the round pulls are ones the server accepted.
  lemma PulledAccepted(pre: State, d: DeviceId)
    requires d in pre.devices && RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    ensures forall i | 0 <= i < |PulledOf(pre, d)| :: AcceptedAs(pre.server.accepted, PulledOf(pre, d)[i])
  {
    var journal := pre.devices[d].journal;
    var pulled := PulledOf(pre, d);
    if journal.cursor < |pre.server.feed| {
      var ids := pre.server.feed[journal.cursor..];
      var held := Revisions(pre.server, ids);
      assert pulled == held;
      RevisionsHeld(pre.server, ids);
      forall i | 0 <= i < |held| ensures AcceptedAs(pre.server.accepted, held[i]) {
        assert held[i] in held;
      }
    }
  }

  // Clause OutboxParentsAccepted.
  lemma {:isolate_assertions} RoundKeepsParentsAccepted(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && JournalsNameAccepted(pre) && OutboxParentsAccepted(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    ensures OutboxParentsAccepted(RoundStepOf(pre, d, input, revs).post)
  {
    var post := RoundStepOf(pre, d, input, revs).post;
    var accepted := pre.server.accepted;
    RoundStepJournal(pre, d, input, revs);
    var journal := pre.devices[d].journal;
    assert RowsNameAccepted(accepted, journal.documents);
    assert RowsParentsAccepted(accepted, journal.documents);
    if FreshIn(input, revs) {
      PulledAccepted(pre, d);
      OnRoundParentsAccepted(pre.devices[d].platform, accepted, journal, PulledOf(pre, d), CursorOf(pre, d), AnchorOf(pre, d), input, revs);
    }
    assert forall x | x in post.devices :: RowsParentsAccepted(accepted, post.devices[x].journal.documents);
  }

  // ---------------------------------------------------------------------
  // #1033's stand-in: no outbox on a row the round created
  // ---------------------------------------------------------------------

  // A row the round itself added (NoRow: another device's new document)
  // has no binding, no base and no outbox; RevsFor gives it the settled
  // revision's own id. The rule opens no outbox on it, so that stand-in
  // is never a commit's id.
  ghost predicate NewRow(document: Document) {
    document.binding.None? && document.base.None? && document.outbox.None?
  }

  lemma ApplyOpensNoOutbox(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing) && NewRow(document)
    ensures ApplyRevision(platform, doc, document, r, input, bound, claims, rev).document.outbox.None?
  {}

  lemma {:isolate_assertions} RuleOpensNoOutbox(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NewRow(documents[doc])
    ensures PathRule(platform, documents, doc, r, input, revs, first).documents[doc].outbox.None?
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    ApplyOpensNoOutbox(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? {
        reveal HeadRow();
      }
    }
  }

  // The round's settle of a revision of a document its journal does not
  // know opens no outbox on that document's row, so RevsFor's stand-in id
  // for it is never sent.
  lemma SettleNewRowOpensNoOutbox(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc !in pass.journal.documents
    ensures var documents' := SettleRevision(platform, pass, doc, r, input, revs, first).journal.documents;
      doc in documents' ==> documents'[doc].outbox.None?
  {
    var documents := pass.journal.documents;
    if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
      var rows := documents[doc := NoRow()];
      RuleOpensNoOutbox(platform, rows, doc, r, input.(listing := pass.listing), RevsFor(rows, revs, r), first);
    }
  }

  // ---------------------------------------------------------------------
  // The round's listing stays distinct: it is the listing of a disk with
  // one file per name that the round's effects can leave
  // ---------------------------------------------------------------------

  ghost function DiskMap(disk: map<Path, DiskFile>): Listing {
    map p | p in disk :: (disk[p].content, disk[p].kind)
  }

  // A listing read from a disk with one file per name.
  ghost predicate ListingOn(platform: Platform, listing: Listing) {
    exists disk :: OneFilePerName(platform, disk) && DiskMap(disk) == listing
  }

  lemma OneFileDistinct(platform: Platform, disk: map<Path, DiskFile>)
    requires OneFilePerName(platform, disk)
    ensures ListingDistinct(platform, DiskMap(disk))
  {}

  // Where an effect's precondition holds, the listing the round keeps
  // follows the disk the effect leaves.
  lemma {:isolate_assertions} EffectListing(platform: Platform, disk: map<Path, DiskFile>, e: Effect)
    requires OneFilePerName(platform, disk) && PreconditionHolds(platform, disk, e)
    ensures exists mid :: EffectTakes(platform, disk, e, mid) && DiskMap(mid) == ListingAfterEffect(platform, DiskMap(disk), e)
  {
    var listing := DiskMap(disk);
    OneFileDistinct(platform, disk);
    match e
    case Write(_, path, content, kind, precondition) =>
      if precondition.Some? {
        var q :| Holds(platform, disk, q, path, precondition.value);
        assert q in listing && SameF(platform, q, path);
        assert Listed(platform, listing, path);
        var at := ListedAt(platform, listing, path);
        assert at == q;
        var mid := disk[q := DiskFile(content, kind, disk[q].identity)];
        assert EffectTakes(platform, disk, e, mid);
        assert DiskMap(mid) == listing[at := (content, kind)];
      } else {
        assert FreeOn(platform, disk, path);
        assert !Listed(platform, listing, path) by {
          forall q | q in listing ensures !SameF(platform, q, path) {
            assert !CollideF(platform, q, path);
          }
        }
        FreshIdentityExists(set q | q in disk :: disk[q].identity);
        var identity: FileIdentity :| identity !in (set q | q in disk :: disk[q].identity);
        var mid := disk[path := DiskFile(content, kind, identity)];
        assert EffectTakes(platform, disk, e, mid);
        assert DiskMap(mid) == listing[path := (content, kind)];
      }
    case Remove(_, path, expected) =>
      var q :| Holds(platform, disk, q, path, expected);
      assert Listed(platform, listing, path);
      assert ListedAt(platform, listing, path) == q;
      var mid := disk - {q};
      assert EffectTakes(platform, disk, e, mid);
      assert DiskMap(mid) == listing - {q};
    case Move(_, from, to, expected) =>
      var q :| MovableTo(platform, disk, q, from, to, expected);
      assert Listed(platform, listing, from);
      assert ListedAt(platform, listing, from) == q;
      var mid := (disk - {q})[to := disk[q]];
      assert EffectTakes(platform, disk, e, mid);
      assert DiskMap(mid) == (listing - {q})[to := listing[q]];
    case _ =>
      assert EffectTakes(platform, disk, e, disk);
  }

  lemma EffectsListing(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>)
    requires OneFilePerName(platform, disk) && PreconditionsInOrder(platform, disk, effects)
    ensures ListingOn(platform, ListingAfter(platform, DiskMap(disk), effects))
    decreases |effects|
  {
    if |effects| == 0 {
      assert ListingAfter(platform, DiskMap(disk), effects) == DiskMap(disk);
    } else {
      EffectListing(platform, disk, effects[0]);
      var mid :| EffectTakes(platform, disk, effects[0], mid) && DiskMap(mid) == ListingAfterEffect(platform, DiskMap(disk), effects[0]);
      EffectKeepsOneFilePerName(platform, disk, effects[0], mid);
      EffectsListing(platform, mid, effects[1..]);
    }
  }

  // The rule's effects keep the round's listing one of a disk with one
  // file per name (so distinct: the round never skips a revision).
  lemma {:isolate_assertions} RuleKeepsListingOn(platform: Platform, listing: Listing, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires ListingOn(platform, listing)
    requires doc in documents && documents.Keys <= revs.Keys
    ensures ListingDistinct(platform, listing)
    ensures ListingDistinct(platform, input.(listing := listing).listing)
            ==> ListingOn(platform, ListingAfter(platform, listing, PathRule(platform, documents, doc, r, input.(listing := listing), revs, first).effects))
  {
    var disk :| OneFilePerName(platform, disk) && DiskMap(disk) == listing;
    OneFileDistinct(platform, disk);
    var device := Device(platform, true, Journal(map[], 0, [], []), disk, {}, {});
    assert ListingOf(device) == listing;
    RulePreconditionsHold(device, documents, doc, r, input.(listing := listing), revs, first);
    EffectsListing(platform, disk, PathRule(platform, documents, doc, r, input.(listing := listing), revs, first).effects);
  }

  // ---------------------------------------------------------------------
  // ClaimsCoverCursor: a row never forgets a revision it knew of, and a
  // settled revision is known
  // ---------------------------------------------------------------------

  ghost predicate KnowsAtLeast(document: Document, position: nat) {
    KnownPosition(document).Some? && KnownPosition(document).value >= position
  }

  ghost predicate KnownNoLess(before: Document, after: Document) {
    KnownPosition(before).Some? ==> KnowsAtLeast(after, KnownPosition(before).value)
  }

  lemma ApplyKnows(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var after := ApplyRevision(platform, doc, document, r, input, bound, claims, rev).document;
      KnownNoLess(document, after) && KnowsAtLeast(after, r.position)
  {}

  lemma {:isolate_assertions} RuleKnows(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first).documents;
      ruled.Keys == documents.Keys
      && KnowsAtLeast(ruled[doc], r.position)
      && forall e | e in documents :: KnownNoLess(documents[e], ruled[e])
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    ApplyKnows(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    RuleNamesFrom(platform, documents, doc, r, input, revs, first);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first).documents;
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      assert Newer(document, r);
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? {
        reveal HeadRow();
      }
      assert KnowsAtLeast(ruled[doc], r.position);
      assert KnownNoLess(document, ruled[doc]);
    }
    forall e | e in documents && e != doc ensures KnownNoLess(documents[e], ruled[e]) {
      assert KeepsNames(documents[e], ruled[e]);
    }
  }

  // Every row of `before` is in `after` and knows no less.
  ghost predicate RowsKnowNoLess(before: map<DocId, Document>, after: map<DocId, Document>) {
    forall e | e in before :: e in after && KnownNoLess(before[e], after[e])
  }

  // Every revision of `settled` is known by its document's row.
  ghost predicate RowsKnow(documents: map<DocId, Document>, settled: set<Revision>) {
    forall r | r in settled :: r.doc in documents && KnowsAtLeast(documents[r.doc], r.position)
  }

  lemma KnowsTrans(a: map<DocId, Document>, b: map<DocId, Document>, c: map<DocId, Document>)
    requires RowsKnowNoLess(a, b) && RowsKnowNoLess(b, c)
    ensures RowsKnowNoLess(a, c)
  {}

  lemma KnowsCarry(a: map<DocId, Document>, b: map<DocId, Document>, settled: set<Revision>)
    requires RowsKnow(a, settled) && RowsKnowNoLess(a, b)
    ensures RowsKnow(b, settled)
  {}

  lemma {:isolate_assertions} SettleKnows(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires ListingOn(platform, pass.listing)
    ensures var pass' := SettleRevision(platform, pass, doc, r, input, revs, first);
      ListingOn(platform, pass'.listing)
      && RowsKnowNoLess(pass.journal.documents, pass'.journal.documents)
      && doc in pass'.journal.documents && KnowsAtLeast(pass'.journal.documents[doc], r.position)
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var rows := documents[doc := row];
    var input' := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    RuleKeepsListingOn(platform, pass.listing, rows, doc, r, input, revs', first);
    assert Distinct(platform, pass.listing);
    var pass' := SettleRevision(platform, pass, doc, r, input, revs, first);
    if r.path in input.outOfScope {
      assert pass'.listing == pass.listing;
    } else {
      assert input'.(listing := pass.listing) == input';
      RuleKnows(platform, rows, doc, r, input', revs', first);
      assert pass'.journal.documents == PathRule(platform, rows, doc, r, input', revs', first).documents;
      forall e | e in documents ensures e in pass'.journal.documents && KnownNoLess(documents[e], pass'.journal.documents[e]) {
        assert KnownNoLess(rows[e], pass'.journal.documents[e]);
      }
    }
  }

  lemma SettlePulledKnows(platform: Platform, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires ListingOn(platform, pass.listing)
    ensures var pass' := SettlePulled(platform, pass, revisions, input, revs, first);
      ListingOn(platform, pass'.listing)
      && RowsKnowNoLess(pass.journal.documents, pass'.journal.documents)
      && RowsKnow(pass'.journal.documents, set i | 0 <= i < |revisions| :: revisions[i])
    decreases |revisions|
  {
    var pass' := SettlePulled(platform, pass, revisions, input, revs, first);
    if |revisions| > 0 {
      var next := SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKnows(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettlePulledKnows(platform, next, revisions[1..], input, revs, first);
      KnowsTrans(pass.journal.documents, next.journal.documents, pass'.journal.documents);
      KnowsCarry(next.journal.documents, pass'.journal.documents, {revisions[0]});
      forall x | x in (set i | 0 <= i < |revisions| :: revisions[i])
        ensures x.doc in pass'.journal.documents && KnowsAtLeast(pass'.journal.documents[x.doc], x.position)
      {
        var i :| 0 <= i < |revisions| && revisions[i] == x;
        if i > 0 { assert revisions[1..][i - 1] == x; }
      }
    }
  }

  lemma RetryKnows(platform: Platform, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires ListingOn(platform, pass.listing)
    ensures var pass' := RetryWaiting(platform, pass, docs, input, revs, first);
      ListingOn(platform, pass'.listing)
      && RowsKnowNoLess(pass.journal.documents, pass'.journal.documents)
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      var pass' := RetryWaiting(platform, pass, docs, input, revs, first);
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var r := row.ahead.value.revision;
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        var next := SettleRevision(platform, cleared, docs[0], r, input, revs, first);
        SettleKnows(platform, cleared, docs[0], r, input, revs, first);
        RetryKnows(platform, next, docs[1..], input, revs, first);
        assert RowsKnowNoLess(documents, next.journal.documents) by {
          forall e | e in documents ensures e in next.journal.documents && KnownNoLess(documents[e], next.journal.documents[e]) {
            if e != docs[0] { assert KnownNoLess(cleared.journal.documents[e], next.journal.documents[e]); }
          }
        }
        KnowsTrans(documents, next.journal.documents, pass'.journal.documents);
      } else {
        RetryKnows(platform, pass, docs[1..], input, revs, first);
      }
    }
  }

  lemma {:isolate_assertions} OnRoundKnows(platform: Platform, journal: Journal, pulled: seq<Revision>, cursor': nat, anchor': Option<RevId>,
                                           input: RoundInput, revs: FreshRevs)
    requires FreshIn(input, revs)
    requires ListingOn(platform, input.listing)
    ensures var journal' := OnRound(platform, journal, pulled, cursor', anchor', input, revs).0;
      RowsKnowNoLess(journal.documents, journal'.documents)
      && RowsKnow(journal'.documents, set i | 0 <= i < |pulled| :: pulled[i])
  {
    var start := StartPass(journal, input);
    var first := RoundClaims(platform, journal, input);
    RetryKnows(platform, start, WaitingRows(journal.documents), input, revs, first);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    SettlePulledKnows(platform, retried, pulled, input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    KnowsTrans(journal.documents, retried.journal.documents, settled.journal.documents);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    PushKeepsParents(platform, read, input', revs);
    PushKeepsAheads(platform, read, input', revs);
    var journal' := OnPush(platform, read, input', revs).0;
    assert RowsKnowNoLess(settled.journal.documents, journal'.documents) by {
      forall e | e in settled.journal.documents ensures e in journal'.documents && KnownNoLess(settled.journal.documents[e], journal'.documents[e]) {
        assert journal'.documents[e].base == settled.journal.documents[e].base;
        assert journal'.documents[e].ahead == settled.journal.documents[e].ahead;
      }
    }
    KnowsTrans(journal.documents, settled.journal.documents, journal'.documents);
    KnowsCarry(settled.journal.documents, journal'.documents, set i | 0 <= i < |pulled| :: pulled[i]);
  }
}
