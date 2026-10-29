// G2_OnlyWhatItSaw of the sync round, from the pass's facts: every
// conditional effect of the pass acts on its document's own file as the
// pass left it, or expects a live accepted revision (PassHist); every
// effect of the pass is performed; so each conditional effect expects what
// the round saw (RoundSaw, CondSaw) wherever the round keeps what its
// overwrites and removes expect (RoundKept, proved in RoundKeeps.dfy).
include "RoundChains.dfy"

abstract module RoundWhatItSaw refines RoundChains {

  // ---------------------------------------------------------------------
  // G2 of the round: groundwork
  // ---------------------------------------------------------------------

  // The rule overwrites or removes only the file of the document it
  // settles: every other row's file it moves (W(a), W(b)) or leaves.
  lemma RuleOverwritesOwn(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                          revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures forall e | e in PathRule(platform, documents, doc, r, input, revs, first).effects ::
      (e.Write? && e.precondition.Some? ==> e.target == Some(doc)) && (e.Remove? ==> e.doc == doc)
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if !HeldForName(document, applied, r) {
      ApplyOverwritesOwn(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) { return; }
    var device := Device(platform, true, Journal(documents, 0, [], []), map[], {}, {});
    ClearWayOnlyWhatItSaw(device, doc, r, input, revs);
  }

  // The apply overwrites or removes only its document's file.
  lemma ApplyOverwritesOwn(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput,
                           bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures forall e | e in ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects ::
      (e.Write? && e.precondition.Some? ==> e.target == Some(doc)) && (e.Remove? ==> e.doc == doc)
  {
  }

  // What the rule's conditional overwrite or remove of `path` expects,
  // `c`: the row's file is there (under F), and `c` is what the listing
  // reads at its binding.
  ghost predicate SawOwn(platform: Platform, listing: Listing, row: Document, path: Path, c: Hash)
    requires ListingDistinct(platform, listing)
  {
    row.binding.Some? && SameF(platform, row.binding.value.spelling, path)
    && Listed(platform, listing, row.binding.value.spelling)
    && ListedRead(platform, listing, row.binding.value.spelling).value.0 == c
  }

  // Every conditional overwrite and every remove of the rule acts on the
  // settled document's own file, expecting what it last saw or read there.
  lemma RuleSaws(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                 revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures forall e | e in PathRule(platform, documents, doc, r, input, revs, first).effects ::
      (e.Write? && e.precondition.Some? ==>
         e.target == Some(doc) && SawOwn(platform, input.listing, documents[doc], e.path, e.precondition.value))
      && (e.Remove? ==> e.doc == doc && SawOwn(platform, input.listing, documents[doc], e.path, e.expected))
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if !HeldForName(document, applied, r) {
      ApplySaws(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) { return; }
    var device := Device(platform, true, Journal(documents, 0, [], []), map[], {}, {});
    ClearWayOnlyWhatItSaw(device, doc, r, input, revs);
    HeldReadsSeen(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    var cleared := ClearWay(platform, documents, doc, r, input, revs);
    if Revives(platform, document, r, input) {
      // A revived document arrives from no file of its own: only moves
      // and an unconditional write.
      reveal Keeps();
      var way := InTheWay(platform, input.listing, r.path, Keeps(platform, document, r, input));
      var avoid := BoundNames(documents) + input.unsaved;
      var moves := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      if moves.Some? && cleared.effects == MoveEffects(platform, documents, doc, moves.value) + ArriveOf(platform, doc, document, r, input) {
        MoveEffectsShape(platform, documents, doc, moves.value);
        assert ArriveOf(platform, doc, document, r, input) == [Write(Some(doc), r.path, Arriving(platform, document, r, input).content, Arriving(platform, document, r, input).kind, None)];
      }
    }
  }

  // The apply's conditional overwrites and removes expect what the row
  // saw or the listing reads at its binding.
  lemma ApplySaws(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput,
                  bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures forall e | e in ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects ::
      (e.Write? && e.precondition.Some? ==>
         e.target == Some(doc) && SawOwn(platform, input.listing, document, e.path, e.precondition.value))
      && (e.Remove? ==> e.doc == doc && SawOwn(platform, input.listing, document, e.path, e.expected))
  {
    if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      SameFIsEquivalence(platform, spelling, spelling, spelling);
    }
  }

  // ---------------------------------------------------------------------
  // G2 of the round: where each conditional effect's file came from
  // ---------------------------------------------------------------------

  // An effect the adapter performs only where the file holds what it
  // expects, acting for a document: a conditional overwrite, a remove, or
  // a move of a document's file.
  ghost predicate IsCond(effect: Effect) {
    (effect.Write? && effect.precondition.Some? && effect.target.Some?) || effect.Remove? || (effect.Move? && effect.mover.Some?)
  }

  ghost function CondDoc(effect: Effect): DocId
    requires IsCond(effect)
  {
    if effect.Write? then effect.target.value else if effect.Remove? then effect.doc else effect.mover.value
  }

  ghost function CondPath(effect: Effect): Path
    requires IsCond(effect)
  {
    if effect.Write? then effect.path else if effect.Remove? then effect.path else effect.from
  }

  ghost function CondExpect(effect: Effect): Hash
    requires IsCond(effect)
  {
    if effect.Write? then effect.precondition.value else if effect.Remove? then effect.expected else effect.expected
  }

  // A conditional effect for `e` at `p` expecting `c` acts on e's own
  // file as the effects before it left it (OwnNameIn), or expects a live
  // revision of `e` the server accepted.
  ghost predicate CondOrigin(platform: Platform, device0: Device, accepted: map<RevId, Revision>, effects: seq<Effect>,
                             e: DocId, p: Path, c: Hash) {
    OwnNameIn(platform, device0, effects, e, p) || AcceptedContent(accepted, e, c)
  }

  ghost predicate CondAt(platform: Platform, device0: Device, accepted: map<RevId, Revision>, effects: seq<Effect>, i: int)
    requires 0 <= i < |effects|
  {
    IsCond(effects[i]) ==>
      CondOrigin(platform, device0, accepted, effects[..i], CondDoc(effects[i]), CondPath(effects[i]), CondExpect(effects[i]))
  }

  ghost predicate PassHist(platform: Platform, device0: Device, accepted: map<RevId, Revision>, effects: seq<Effect>) {
    forall i | 0 <= i < |effects| :: CondAt(platform, device0, accepted, effects, i)
  }

  // Effects that touch no file at `p` keep what OwnNameIn reads at a name
  // the same as `p` under F.
  lemma OwnNameThrough(platform: Platform, device0: Device, a: seq<Effect>, b: seq<Effect>, e: DocId, t: Path, p: Path)
    requires device0.platform == platform && SameF(platform, t, p)
    requires OwnNameIn(platform, device0, a, e, t)
    requires forall effect :: effect in b ==> !Touches(platform, effect, p)
    ensures OwnNameIn(platform, device0, a + b, e, p)
  {
    RoundPutSameF(platform, a, t, p);
    UntouchedTailKeepsReadings(platform, device0, a, b, e, p);
    SameFIsEquivalence(platform, t, p, p);
    if RoundPut(platform, a, p).Untouched? {
      assert BoundTo(device0, e, t);
      SameFIsEquivalence(platform, device0.journal.documents[e].binding.value.spelling, t, p);
    }
  }

  // The rule clearing the way acts conditionally only on files whose
  // origin the pass knows: a moved-aside file is its mover's own or holds
  // a live revision of it (it adopted it), and the arriving document's
  // own file likewise.
  lemma {:isolate_assertions} ClearWayCondOrigin(platform: Platform, device0: Device, accepted: map<RevId, Revision>,
                                                 effects0: seq<Effect>, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                 input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires device0.platform == platform
    requires ListingDistinct(platform, input.listing) && Distinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires forall e | e in documents :: RowG5(platform, device0, effects0, e, documents[e])
                                          && RowContent(platform, device0, accepted, effects0, input.listing, e, documents[e])
    requires Keeps(platform, documents[doc], r, input).Some? ==>
      ListedRead(platform, input.listing, documents[doc].binding.value.spelling).value.0
        == ArrivingRow(platform, documents[doc], r, input).binding.value.seen
    ensures var effects := ClearWay(platform, documents, doc, r, input, revs).effects;
      forall i | |effects0| <= i < |effects0 + effects| :: CondAt(platform, device0, accepted, effects0 + effects, i)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    var all := effects0 + ruled.effects;
    assert all == effects0 + (front + arrive);
    forall i | |effects0| <= i < |all|
      ensures CondAt(platform, device0, accepted, all, i)
    {
      ClearWayCondOne(platform, device0, accepted, effects0, documents, doc, r, input, moves, way, avoid, i - |effects0|, all, i);
    }
  }

  // One effect of the rule clearing the way, from the moves aside or the
  // arrival.
  lemma ClearWayCondOne(platform: Platform, device0: Device, accepted: map<RevId, Revision>,
                        effects0: seq<Effect>, documents: map<DocId, Document>, doc: DocId, r: Revision,
                        input: RoundInput, moves: seq<(Path, Path, Hash)>, way: set<Path>, avoid: set<Path>, k: nat,
                        all: seq<Effect>, i: nat)
    requires doc in documents && device0.platform == platform
    requires ListingDistinct(platform, input.listing) && Distinct(platform, input.listing)
    requires forall e | e in documents :: RowG5(platform, device0, effects0, e, documents[e])
                                          && RowContent(platform, device0, accepted, effects0, input.listing, e, documents[e])
    requires Keeps(platform, documents[doc], r, input).Some? ==>
      ListedRead(platform, input.listing, documents[doc].binding.value.spelling).value.0
        == ArrivingRow(platform, documents[doc], r, input).binding.value.seen
    requires way == InTheWay(platform, input.listing, r.path, Keeps(platform, documents[doc], r, input))
    requires way <= input.listing.Keys
    requires forall i | 0 <= i < |moves| ::
      moves[i].0 in way && moves[i].2 == input.listing[moves[i].0].0 && FreeIn(platform, input.listing, moves[i].1)
    requires forall i, j | 0 <= i < j < |moves| :: moves[i].0 != moves[j].0
    requires k < |MoveEffects(platform, documents, doc, moves) + ArriveOf(platform, doc, documents[doc], r, input)|
    requires all == effects0 + (MoveEffects(platform, documents, doc, moves) + ArriveOf(platform, doc, documents[doc], r, input))
    requires i == |effects0| + k
    ensures CondAt(platform, device0, accepted, all, i)
  {
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, documents[doc], r, input);
    MoveEffectsShape(platform, documents, doc, moves);
    if k < |front| {
      FrontCondOrigin(platform, device0, accepted, effects0, documents, doc, input, moves, way, avoid, r.path, k);
    } else {
      ArriveCondOrigin(platform, device0, accepted, effects0, documents, doc, r, input, moves, way, avoid, k - |front|);
    }
    CondAtJoin(platform, device0, accepted, effects0, front, arrive, k);
  }

  // CondAt of an effect of `f + g` after `a`, from the one of `f` or `g`.
  lemma {:isolate_assertions} CondAtJoin(platform: Platform, device0: Device, accepted: map<RevId, Revision>,
                                         a: seq<Effect>, f: seq<Effect>, g: seq<Effect>, k: nat)
    requires k < |f| + |g|
    requires k < |f| ==> (IsCond(f[k]) ==> CondOrigin(platform, device0, accepted, a + f[..k], CondDoc(f[k]), CondPath(f[k]), CondExpect(f[k])))
    requires k >= |f| ==> (IsCond(g[k - |f|]) ==>
      CondOrigin(platform, device0, accepted, a + f + g[..k - |f|], CondDoc(g[k - |f|]), CondPath(g[k - |f|]), CondExpect(g[k - |f|])))
    ensures CondAt(platform, device0, accepted, a + (f + g), |a| + k)
  {
    var all := a + (f + g);
    if k < |f| {
      assert all[|a| + k] == f[k];
      assert all[..|a| + k] == a + f[..k];
    } else {
      var k' := k - |f|;
      assert all[|a| + k] == g[k'];
      assert all[..|a| + k] == a + f + g[..k'];
    }
  }

  // A row bound at a name the same as the listed file `q` reads there what
  // the listing holds at `q`.
  lemma ListedAtBound(platform: Platform, listing: Listing, t: Path, q: Path)
    requires ListingDistinct(platform, listing) && q in listing && SameF(platform, t, q)
    ensures Listed(platform, listing, t) && ListedAt(platform, listing, t) == q
    ensures ListedRead(platform, listing, t) == Some(listing[q])
  {
    SameFIsEquivalence(platform, t, q, q);
    assert SameF(platform, q, t);
    var q' := ListedAt(platform, listing, t);
    if q' != q {
      SameFIsEquivalence(platform, q', t, q);
      assert SameF(platform, q', q);
    }
  }

  // A move aside of a file in the way moves its mover's own file, or a
  // file holding a live revision of its mover.
  lemma {:isolate_assertions} FrontCondOrigin(platform: Platform, device0: Device, accepted: map<RevId, Revision>,
                                              effects0: seq<Effect>, documents: map<DocId, Document>, doc: DocId,
                                              input: RoundInput, moves: seq<(Path, Path, Hash)>, way: set<Path>,
                                              avoid: set<Path>, wanted: Path, k: nat)
    requires device0.platform == platform
    requires ListingDistinct(platform, input.listing) && Distinct(platform, input.listing)
    requires forall e | e in documents :: RowG5(platform, device0, effects0, e, documents[e])
                                          && RowContent(platform, device0, accepted, effects0, input.listing, e, documents[e])
    requires way <= input.listing.Keys && k < |moves|
    requires forall i | 0 <= i < |moves| ::
      moves[i].0 in way && moves[i].2 == input.listing[moves[i].0].0 && FreeIn(platform, input.listing, moves[i].1)
    requires forall i, j | 0 <= i < j < |moves| :: moves[i].0 != moves[j].0
    ensures var front := MoveEffects(platform, documents, doc, moves);
      k < |front| && (IsCond(front[k]) ==>
        CondOrigin(platform, device0, accepted, effects0 + front[..k], CondDoc(front[k]), CondPath(front[k]), CondExpect(front[k])))
  {
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    if !IsCond(front[k]) { return; }
    var x := front[k].mover.value;
    MoveEffectsMoverOwns(platform, documents, doc, moves, k, x);
    var q := moves[k].0;
    var t := documents[x].binding.value.spelling;
    assert q in input.listing;
    if OwnNameIn(platform, device0, effects0, x, t) {
      forall effect | effect in front[..k] ensures !Touches(platform, effect, q) {
        var j := var j :| 0 <= j < k && front[..k][j] == effect; j;
        assert effect == front[j];
        assert moves[j].0 != q && moves[j].0 in input.listing;
        assert !CollideF(platform, moves[j].1, q);
      }
      OwnNameThrough(platform, device0, effects0, front[..k], x, t, q);
    } else {
      ListedAtBound(platform, input.listing, t, q);
      assert RowContent(platform, device0, accepted, effects0, input.listing, x, documents[x]);
    }
  }

  // The arrival acts conditionally only on the arriving document's own
  // file, which the moves aside before it leave alone: its own as the pass
  // left it, or a file holding a live revision of it.
  lemma {:isolate_assertions} ArriveCondOrigin(platform: Platform, device0: Device, accepted: map<RevId, Revision>,
                                               effects0: seq<Effect>, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                               input: RoundInput, moves: seq<(Path, Path, Hash)>, way: set<Path>,
                                               avoid: set<Path>, k: nat)
    requires doc in documents
    requires device0.platform == platform
    requires ListingDistinct(platform, input.listing) && Distinct(platform, input.listing)
    requires forall e | e in documents :: RowG5(platform, device0, effects0, e, documents[e])
                                          && RowContent(platform, device0, accepted, effects0, input.listing, e, documents[e])
    requires Keeps(platform, documents[doc], r, input).Some? ==>
      ListedRead(platform, input.listing, documents[doc].binding.value.spelling).value.0
        == ArrivingRow(platform, documents[doc], r, input).binding.value.seen
    requires way == InTheWay(platform, input.listing, r.path, Keeps(platform, documents[doc], r, input))
    requires forall i | 0 <= i < |moves| :: moves[i].0 in way && FreeIn(platform, input.listing, moves[i].1)
    requires k < |ArriveOf(platform, doc, documents[doc], r, input)|
    ensures var front := MoveEffects(platform, documents, doc, moves);
      var arrive := ArriveOf(platform, doc, documents[doc], r, input);
      IsCond(arrive[k]) ==>
        CondOrigin(platform, device0, accepted, effects0 + front + arrive[..k], CondDoc(arrive[k]), CondPath(arrive[k]), CondExpect(arrive[k]))
  {
    var document := documents[doc];
    var keep := Keeps(platform, document, r, input);
    var row := ArrivingRow(platform, document, r, input);
    var a := Arriving(platform, document, r, input);
    var arrive := ArriveOf(platform, doc, document, r, input);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    assert arrive == Arrive(platform, doc, row, a, keep);
    if !IsCond(arrive[k]) { return; }
    assert keep.Some? && row.binding.Some?;
    var own := keep.value;
    var spelling := document.binding.value.spelling;
    assert own == ListedAt(platform, input.listing, spelling);
    ListedAtBound(platform, input.listing, spelling, own);
    var seen := row.binding.value.seen;
    var c := CondExpect(arrive[k]);
    if k == 1 && arrive[0].Write? {
      // The move after the overwrite in place: the file is the one it wrote.
      assert arrive[..k] == [arrive[0]];
      var before := effects0 + front + arrive[..k];
      assert before[|before| - 1] == arrive[0];
      SameFIsEquivalence(platform, own, own, own);
      RoundPutLastIs(platform, before, own);
      assert CondPath(arrive[k]) == own;
      return;
    }
    assert k == 0;
    assert CondPath(arrive[k]) == own && c == seen;
    assert arrive[..k] == [];
    assert effects0 + front + arrive[..k] == effects0 + front;
    if OwnNameIn(platform, device0, effects0, doc, spelling) {
      forall effect | effect in front ensures !Touches(platform, effect, own) {
        var j := var j :| 0 <= j < |front| && front[j] == effect; j;
        assert moves[j].0 in way && moves[j].0 != own && moves[j].0 in input.listing;
        assert !CollideF(platform, moves[j].1, own);
      }
      SameFIsEquivalence(platform, spelling, own, own);
      OwnNameThrough(platform, device0, effects0, front, doc, spelling, own);
    } else {
      assert RowContent(platform, device0, accepted, effects0, input.listing, doc, document);
    }
  }

  // The apply acts conditionally only on its document's file, as the pass
  // left it: its own, or a file holding a live revision of it (adopted).
  lemma {:isolate_assertions} ApplyCondOrigin(platform: Platform, device0: Device, accepted: map<RevId, Revision>,
                                              effects0: seq<Effect>, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                              input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires doc in documents && device0.platform == platform
    requires ListingDistinct(platform, input.listing) && Distinct(platform, input.listing)
    requires RowG5(platform, device0, effects0, doc, documents[doc])
    requires RowContent(platform, device0, accepted, effects0, input.listing, doc, documents[doc])
    ensures var effects := ApplyRevision(platform, doc, documents[doc], r, input, bound, claims, rev).effects;
      forall i | |effects0| <= i < |effects0 + effects| :: CondAt(platform, device0, accepted, effects0 + effects, i)
  {
    var document := documents[doc];
    var effects := ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects;
    ApplySaws(platform, doc, document, r, input, bound, claims, rev);
    var all := effects0 + effects;
    forall i | |effects0| <= i < |all|
      ensures CondAt(platform, device0, accepted, all, i)
    {
      var k := i - |effects0|;
      assert all[i] == effects[k];
      assert all[..i] == effects0 + effects[..k];
      if IsCond(effects[k]) {
        assert effects[k] in effects;
        var path := CondPath(effects[k]);
        var spelling := document.binding.value.spelling;
        assert !effects[k].Move?;
        assert SameF(platform, spelling, path) && Listed(platform, input.listing, spelling);
        if OwnNameIn(platform, device0, effects0, doc, spelling) {
          forall effect | effect in effects[..k] ensures !Touches(platform, effect, path) {
            ApplyEarlierTouch(platform, doc, document, r, input, bound, claims, rev, k, path);
          }
          OwnNameThrough(platform, device0, effects0, effects[..k], doc, spelling, path);
        }
      }
    }
  }

  // Before the apply's conditional effect, no effect of it touches that
  // effect's file (a conflict copy goes to a free name).
  lemma {:isolate_assertions} ApplyEarlierTouch(platform: Platform, doc: DocId, document: Document, r: Revision,
                                                input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, k: nat, path: Path)
    requires ListingDistinct(platform, input.listing)
    requires var effects := ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects;
      k < |effects| && IsCond(effects[k]) && path == CondPath(effects[k])
    ensures var effects := ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects;
      forall effect | effect in effects[..k] :: !Touches(platform, effect, path)
  {
    var effects := ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects;
    ApplySaws(platform, doc, document, r, input, bound, claims, rev);
    assert effects[k] in effects;
    var spelling := document.binding.value.spelling;
    assert SameF(platform, spelling, path);
    if k > 0 {
      // Only the conflict copy comes before the overwrite.
      assert |effects| == 2 && effects[0].Write? && effects[0].target.None? && k == 1;
      var copy := effects[0].path;
      assert !CollideF(platform, copy, spelling);
      if SameF(platform, copy, path) {
        SameFIsEquivalence(platform, copy, path, spelling);
        SameFIsEquivalence(platform, spelling, path, path);
        assert SameF(platform, path, spelling);
        assert SameF(platform, copy, spelling);
      }
      assert effects[..k] == [effects[0]];
    }
  }

  // The rule acts conditionally only on files whose origin the pass
  // knows (CondOrigin).
  lemma {:isolate_assertions} RuleCondOrigin(platform: Platform, device0: Device, accepted: map<RevId, Revision>,
                                             effects0: seq<Effect>, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                             input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys && device0.platform == platform
    requires ListingDistinct(platform, input.listing) && Distinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires forall e | e in documents :: RowG5(platform, device0, effects0, e, documents[e])
                                          && RowContent(platform, device0, accepted, effects0, input.listing, e, documents[e])
    ensures var effects := PathRule(platform, documents, doc, r, input, revs, first).effects;
      forall i | |effects0| <= i < |effects0 + effects| :: CondAt(platform, device0, accepted, effects0 + effects, i)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var effects := PathRule(platform, documents, doc, r, input, revs, first).effects;
    if !HeldForName(document, applied, r) {
      ApplyCondOrigin(platform, device0, accepted, effects0, documents, doc, r, input, bound, claims, revs[doc]);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) {
      forall i | |effects0| <= i < |effects0 + effects| ensures CondAt(platform, device0, accepted, effects0 + effects, i) {
        assert (effects0 + effects)[i] == effects[i - |effects0|];
      }
      return;
    }
    HeldReadsSeen(platform, doc, document, r, input, bound, claims, revs[doc]);
    ClearWayCondOrigin(platform, device0, accepted, effects0, documents, doc, r, input, revs);
  }

  // A journal write in the pass puts no file anywhere.
  lemma GuardKeepsPuts(platform: Platform, effects: seq<Effect>, guard: seq<Effect>, p: Path)
    requires forall effect | effect in guard :: effect.PersistJournal?
    ensures RoundPut(platform, effects + guard, p) == RoundPut(platform, effects, p)
    decreases |guard|
  {
    if |guard| > 0 {
      var front := effects + guard[..|guard| - 1];
      assert effects + guard == front + [guard[|guard| - 1]];
      assert (effects + guard)[..|effects + guard| - 1] == front;
      assert guard[|guard| - 1] in guard;
      var all := effects + guard;
      assert all[|all| - 1].PersistJournal?;
      assert RoundPut(platform, all, p) == RoundPut(platform, all[..|all| - 1], p);
      forall effect | effect in guard[..|guard| - 1] ensures effect.PersistJournal? {
        assert effect in guard;
      }
      GuardKeepsPuts(platform, effects, guard[..|guard| - 1], p);
    } else {
      assert effects + guard == effects;
    }
  }

  // Settling one revision keeps the history of conditional effects.
  lemma {:isolate_assertions} SettleKeepsHist(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                                              doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && PassContent(platform, device0, accepted, pass)
    requires PassHist(platform, device0, accepted, pass.effects)
    ensures PassHist(platform, device0, accepted, SettleRevision(platform, pass, doc, r, input, revs, first).effects)
  {
    var pass' := SettleRevision(platform, pass, doc, r, input, revs, first);
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if !Distinct(platform, pass.listing) || r.path in input.outOfScope { return; }
    var rows := documents[doc := row];
    var input' := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, input', revs', first);
    var intents := IntentsFor(doc, r, ruled.effects, pass.n);
    var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
    var e0 := pass.effects + guard;
    assert pass'.effects == e0 + ruled.effects;
    assert NeverJoinedRows(platform, rows) by {
      assert NeverJoinedRows(platform, documents);
      if doc !in documents { assert rows[doc].binding.None?; }
    }
    forall e | e in rows
      ensures RowG5(platform, device0, e0, e, rows[e]) && RowContent(platform, device0, accepted, e0, pass.listing, e, rows[e])
    {
      if rows[e].binding.Some? {
        var t := rows[e].binding.value.spelling;
        assert e in documents && rows[e] == documents[e];
        GuardKeepsPuts(platform, pass.effects, guard, t);
        assert RowG5(platform, device0, pass.effects, e, documents[e]);
        assert RowContent(platform, device0, accepted, pass.effects, pass.listing, e, documents[e]);
      }
    }
    RuleCondOrigin(platform, device0, accepted, e0, rows, doc, r, input', revs', first);
    var all := pass'.effects;
    forall i | 0 <= i < |all| ensures CondAt(platform, device0, accepted, all, i) {
      if i < |pass.effects| {
        assert all[i] == pass.effects[i] && all[..i] == pass.effects[..i];
        assert CondAt(platform, device0, accepted, pass.effects, i);
      } else if i < |e0| {
        assert all[i] in guard;
      }
    }
  }

  lemma SettlePulledKeepsHist(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                              revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && PassContent(platform, device0, accepted, pass)
    requires PassHist(platform, device0, accepted, pass.effects)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    ensures PassHist(platform, device0, accepted, SettlePulled(platform, pass, revisions, input, revs, first).effects)
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsHist(platform, device0, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsContent(platform, device0, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsG5(platform, device0, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledKeepsHist(platform, device0, accepted, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsHist(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                       docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && PassContent(platform, device0, accepted, pass)
    requires PassNUD(platform, device0, accepted, pass) && PassHist(platform, device0, accepted, pass.effects)
    ensures PassHist(platform, device0, accepted, RetryWaiting(platform, pass, docs, input, revs, first).effects)
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert NeverJoinedRows(platform, cleared.journal.documents);
        forall e | e in cleared.journal.documents
          ensures RowG5(platform, device0, cleared.effects, e, cleared.journal.documents[e])
          ensures RowContent(platform, device0, accepted, cleared.effects, cleared.listing, e, cleared.journal.documents[e])
        {
          assert RowG5(platform, device0, pass.effects, e, documents[e]);
          assert RowContent(platform, device0, accepted, pass.effects, pass.listing, e, documents[e]);
        }
        assert PassG5(platform, device0, cleared);
        assert PassNUD(platform, device0, accepted, cleared);
        var r := row.ahead.value.revision;
        assert AcceptedAs(accepted, r) && r.doc == docs[0];
        SettleKeepsHist(platform, device0, accepted, cleared, docs[0], r, input, revs, first);
        SettleKeepsContent(platform, device0, accepted, cleared, docs[0], r, input, revs, first);
        SettleKeepsG5(platform, device0, cleared, docs[0], r, input, revs, first);
        SettleKeepsNUD(platform, device0, accepted, cleared, docs[0], r, input, revs, first);
        RetryKeepsHist(platform, device0, accepted, SettleRevision(platform, cleared, docs[0], r, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsHist(platform, device0, accepted, pass, docs[1..], input, revs, first);
      }
    }
  }

  // ---------------------------------------------------------------------
  // G2 of the round: every effect of the pass is performed
  // ---------------------------------------------------------------------

  // Each effect's precondition holds on every disk the effects before it
  // can leave.
  ghost predicate Performed(platform: Platform, disk0: map<Path, DiskFile>, effects: seq<Effect>) {
    forall i, disk' | 0 <= i < |effects| && EffectsTake(platform, disk0, effects[..i], disk') :: PreconditionHolds(platform, disk', effects[i])
  }

  lemma InOrderAt(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, k: nat, disk': map<Path, DiskFile>)
    requires PreconditionsInOrder(platform, disk, effects) && k < |effects|
    requires EffectsTake(platform, disk, effects[..k], disk')
    ensures PreconditionHolds(platform, disk', effects[k])
    decreases k
  {
    if k > 0 {
      assert effects[..k][0] == effects[0];
      var mid := var mid :| EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[..k][1..], disk'); mid;
      assert effects[..k][1..] == effects[1..][..k - 1];
      InOrderAt(platform, mid, effects[1..], k - 1, disk');
    } else {
      assert disk' == disk;
    }
  }

  lemma {:isolate_assertions} SettleKeepsPerformed(platform: Platform, device0: Device, pass: RoundPass,
                                                   doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && Performed(platform, device0.disk, pass.effects)
    ensures Performed(platform, device0.disk, SettleRevision(platform, pass, doc, r, input, revs, first).effects)
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if !Distinct(platform, pass.listing) || r.path in input.outOfScope { return; }
    var rows := documents[doc := row];
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    var intents := IntentsFor(doc, r, ruled.effects, pass.n);
    var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
    var e0 := pass.effects + guard;
    var all := e0 + ruled.effects;
    assert SettleRevision(platform, pass, doc, r, input, revs, first).effects == all;
    forall i, disk' | 0 <= i < |all| && EffectsTake(platform, device0.disk, all[..i], disk')
      ensures PreconditionHolds(platform, disk', all[i])
    {
      if i < |pass.effects| {
        assert all[..i] == pass.effects[..i] && all[i] == pass.effects[i];
      } else if i < |e0| {
        assert all[i] in guard;
      } else {
        var k := i - |e0|;
        assert all[..i] == e0 + ruled.effects[..k] && all[i] == ruled.effects[k];
        EffectsTakeSplit(platform, device0.disk, e0, ruled.effects[..k], disk');
        var mid1 := var mid1 :| EffectsTake(platform, device0.disk, e0, mid1) && EffectsTake(platform, mid1, ruled.effects[..k], disk'); mid1;
        EffectsTakeSplit(platform, device0.disk, pass.effects, guard, mid1);
        var mid0 := var mid0 :| EffectsTake(platform, device0.disk, pass.effects, mid0) && EffectsTake(platform, mid0, guard, mid1); mid0;
        assert DiskMap(mid0) == pass.listing && OneFilePerName(platform, mid0);
        if |guard| > 0 {
          var m := var m :| EffectTakes(platform, mid0, guard[0], m) && EffectsTake(platform, m, guard[1..], mid1); m;
          assert guard[0].PersistJournal?;
          assert m == mid0 && mid1 == mid0;
        }
        assert mid1 == mid0;
        var device := Device(platform, true, Journal(map[], 0, [], []), mid1, {}, {});
        assert ListingOf(device) == pass.listing;
        RulePreconditionsHold(device, rows, doc, r, inner, revs', first);
        InOrderAt(platform, mid1, ruled.effects, k, disk');
      }
    }
  }

  lemma SettlePulledKeepsPerformed(platform: Platform, device0: Device, pass: RoundPass,
                                   revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && Performed(platform, device0.disk, pass.effects)
    ensures Performed(platform, device0.disk, SettlePulled(platform, pass, revisions, input, revs, first).effects)
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsPerformed(platform, device0, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsG5(platform, device0, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettlePulledKeepsPerformed(platform, device0, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsPerformed(platform: Platform, device0: Device, pass: RoundPass,
                            docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && Performed(platform, device0.disk, pass.effects)
    ensures Performed(platform, device0.disk, RetryWaiting(platform, pass, docs, input, revs, first).effects)
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert NeverJoinedRows(platform, cleared.journal.documents);
        forall e | e in cleared.journal.documents
          ensures RowG5(platform, device0, cleared.effects, e, cleared.journal.documents[e])
        {
          assert RowG5(platform, device0, pass.effects, e, documents[e]);
        }
        assert PassG5(platform, device0, cleared);
        var r := row.ahead.value.revision;
        SettleKeepsPerformed(platform, device0, cleared, docs[0], r, input, revs, first);
        SettleKeepsG5(platform, device0, cleared, docs[0], r, input, revs, first);
        RetryKeepsPerformed(platform, device0, SettleRevision(platform, cleared, docs[0], r, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsPerformed(platform, device0, pass, docs[1..], input, revs, first);
      }
    }
  }

  // The content a put leaves at its name: a write's, or, for a move, the
  // content it expects of the file it moves.
  ghost function PutContent(effect: Effect): Hash
    requires effect.Write? || effect.Move?
  {
    if effect.Write? then effect.content else effect.expected
  }

  // Where every effect is performed, the disk the effects leave holds, at
  // a name, what the last put there left (RoundPut): the file it wrote or
  // moved there, no file where the last touch freed the name, and the
  // file as it was where nothing touched it.
  ghost predicate PutOnDisk(platform: Platform, disk0: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>, p: Path) {
    match RoundPut(platform, effects, p)
    case Untouched => forall x | SameF(platform, x, p) :: (x in disk0 <==> x in disk') && (x in disk0 ==> disk'[x] == disk0[x])
    case Freed => forall x | x in disk' :: !SameF(platform, x, p)
    case By(j) =>
      (effects[j].Write? || effects[j].Move?)
      && exists x :: x in disk' && SameF(platform, x, p) && disk'[x].content == PutContent(effects[j])
  }

  lemma {:isolate_assertions} PutHolds(platform: Platform, disk0: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>, p: Path)
    requires OneFilePerName(platform, disk0) && EffectsTake(platform, disk0, effects, disk')
    requires Performed(platform, disk0, effects)
    ensures PutOnDisk(platform, disk0, effects, disk', p)
    decreases |effects|
  {
    if |effects| == 0 { return; }
    var n := |effects| - 1;
    var front := effects[..n];
    var last := effects[n];
    assert effects == front + [last];
    EffectsTakeSplit(platform, disk0, front, [last], disk');
    var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :| EffectsTake(platform, disk0, front, mid) && EffectsTake(platform, mid, [last], disk'); mid;
    assert EffectTakes(platform, mid, last, disk') by {
      var m: map<Path, DiskFile> := var m: map<Path, DiskFile> :| EffectTakes(platform, mid, last, m) && EffectsTake(platform, m, [last][1..], disk'); m;
      assert [last][1..] == [];
    }
    assert PreconditionHolds(platform, mid, last) by { assert effects[..n] == front; }
    forall i, d | 0 <= i < |front| && EffectsTake(platform, disk0, front[..i], d) ensures PreconditionHolds(platform, d, front[i]) {
      assert effects[..i] == front[..i] && effects[i] == front[i];
    }
    EffectsKeepOneFilePerName(platform, disk0, front, mid);
    if (last.Write? && SameF(platform, last.path, p)) || (last.Move? && SameF(platform, last.to, p)) {
      assert RoundPut(platform, effects, p) == By(n);
      if last.Write? {
        if last.precondition.Some? {
          var q: Path := var q: Path :| Holds(platform, mid, q, last.path, last.precondition.value)
            && disk' == mid[q := DiskFile(last.content, last.kind, mid[q].identity)]; q;
          SameFIsEquivalence(platform, q, last.path, p);
          assert disk'[q].content == last.content;
        } else {
          var identity: FileIdentity := var identity: FileIdentity :| (forall q :: q in mid ==> mid[q].identity != identity) && disk' == mid[last.path := DiskFile(last.content, last.kind, identity)]; identity;
          assert disk'[last.path].content == last.content;
        }
      } else {
        var q: Path := var q: Path :| MovableTo(platform, mid, q, last.from, last.to, last.expected) && disk' == (mid - {q})[last.to := mid[q]]; q;
        assert disk'[last.to].content == last.expected;
      }
    } else if (last.Remove? && SameF(platform, last.path, p)) || (last.Move? && SameF(platform, last.from, p)) {
      assert RoundPut(platform, effects, p) == Freed;
      var q: Path;
      if last.Remove? {
        q := var q: Path :| Holds(platform, mid, q, last.path, last.expected) && disk' == mid - {q}; q;
      } else {
        q := var q: Path :| MovableTo(platform, mid, q, last.from, last.to, last.expected) && disk' == (mid - {q})[last.to := mid[q]]; q;
      }
      forall x | x in disk' ensures !SameF(platform, x, p) {
        if SameF(platform, x, p) {
          if last.Move? && x == last.to { assert false; }
          assert x in mid && x != q;
          var w := if last.Remove? then last.path else last.from;
          SameFIsEquivalence(platform, q, w, p);
          SameFIsEquivalence(platform, x, p, q);
          assert SameF(platform, x, q);
          assert CollideF(platform, x, q);
        }
      }
    } else {
      assert !Touches(platform, last, p);
      assert RoundPut(platform, effects, p) == RoundPut(platform, front, p);
      PutHolds(platform, disk0, front, mid, p);
      forall x | SameF(platform, x, p) ensures (x in mid <==> x in disk') && (x in mid ==> disk'[x] == mid[x]) {
        EffectUntouchedKeepsFile(platform, mid, last, disk', p, x);
      }
      match RoundPut(platform, front, p)
      case Untouched =>
      case Freed =>
      case By(j) =>
        assert effects[j] == front[j];
        var x: Path := var x: Path :| x in mid && SameF(platform, x, p) && mid[x].content == PutContent(front[j]); x;
        assert x in disk';
    }
  }

  // ---------------------------------------------------------------------
  // G2 of the round: from the pass's facts to RoundSaw
  // ---------------------------------------------------------------------

  // What a conditional effect for `e` expecting `c` needs at the start of
  // its chain of puts, where that is `e`'s own file before the round and
  // the round read `c` there: the content is what `e` saw before the
  // round, is kept, or is a live revision of `e` the server accepted.
  ghost predicate KeptBase(step: Step, e: DocId, c: Hash)
    requires RoundEvent(step.event) && step.event.device in step.pre.devices
  {
    var device := step.pre.devices[step.event.device];
    (e in device.journal.documents && device.journal.documents[e].binding.Some?
     && RoundRead(step, device.journal.documents[e].binding.value.spelling).Some?
     && RoundRead(step, device.journal.documents[e].binding.value.spelling).value.0 == c)
    ==> ((c == device.journal.documents[e].binding.value.seen) || ReadKept(step, e, c) || DocVersion(step, e, c))
  }

  // A file the round wrote for `e` holding `c` is kept, or holds a live
  // revision of `e`.
  ghost predicate KeptWrites(step: Step, i: nat, e: DocId, c: Hash)
    requires RoundEvent(step.event) && i <= |step.effects|
  {
    forall j | 0 <= j < i ::
      (step.effects[j].Write? && step.effects[j].target == Some(e) && step.effects[j].content == c)
        ==> ReadKept(step, e, c) || DocVersion(step, e, c)
  }

  // The content a conditional effect finds at a name the round last put a
  // file at is that put's.
  lemma PutByContent(platform: Platform, disk0: map<Path, DiskFile>, effects: seq<Effect>, disk: map<Path, DiskFile>, p: Path, q: Path, c: Hash)
    requires PutOnDisk(platform, disk0, effects, disk, p) && RoundPut(platform, effects, p).By?
    requires OneFilePerName(platform, disk) && Holds(platform, disk, q, p, c)
    ensures c == PutContent(effects[RoundPut(platform, effects, p).index])
  {
    var j := RoundPut(platform, effects, p).index;
    var x: Path := var x: Path :| x in disk && SameF(platform, x, p) && disk[x].content == PutContent(effects[j]); x;
    OneAt(platform, disk, x, q, p);
  }

  // An untouched file the document was bound to before the round: what
  // the round read there, which it last saw or keeps.
  lemma CondSawUntouched(step: Step, e: DocId, p: Path, c: Hash, q: Path)
    requires step.event.SyncRound? && step.event.device in step.pre.devices
    requires var device0 := step.pre.devices[step.event.device];
      OneFilePerName(device0.platform, device0.disk) && BoundTo(device0, e, p)
      && q in device0.disk && SameF(device0.platform, q, p) && device0.disk[q].content == c
    requires KeptBase(step, e, c)
    ensures var device0 := step.pre.devices[step.event.device];
      (BoundTo(device0, e, p) && LastSaw(step, device0, e, p, c)) || DocVersion(step, e, c)
  {
    var device0 := step.pre.devices[step.event.device];
    var spelling := device0.journal.documents[e].binding.value.spelling;
    SameFIsEquivalence(device0.platform, q, p, spelling);
    SameFIsEquivalence(device0.platform, spelling, p, q);
    FileAtIs(device0, p, q);
    FileAtIs(device0, spelling, q);
    assert RoundRead(step, p) == Some((c, device0.disk[q].kind));
    assert RoundRead(step, spelling) == Some((c, device0.disk[q].kind));
    if !DocVersion(step, e, c) {
      var row := device0.journal.documents[e];
      if c != row.binding.value.seen {
        assert ReadKept(step, e, c);
        assert RoundRead(step, p).Some? && RoundRead(step, p).value.0 == c;
      }
      assert LastSaw(step, device0, e, p, c);
    }
  }

  // Two files on a disk with one file per name, both the same as `p`
  // under F, are one.
  lemma OneAt(platform: Platform, disk: map<Path, DiskFile>, x: Path, y: Path, p: Path)
    requires OneFilePerName(platform, disk) && x in disk && y in disk
    requires SameF(platform, x, p) && SameF(platform, y, p)
    ensures x == y
  {
    if x != y {
      SameFIsEquivalence(platform, x, p, y);
      assert SameF(platform, x, y);
      assert CollideF(platform, x, y);
    }
  }

  // Every conditional effect of a round whose effects are all performed,
  // with the pass's history (PassHist), saw what it expects (RoundSaw),
  // given its chain's start and writes are kept.
  lemma {:isolate_assertions} CondSaw(step: Step, accepted: map<RevId, Revision>, i: nat)
    requires step.event.SyncRound? && step.event.device in step.pre.devices && step.event.device in step.post.devices
    requires var device0 := step.pre.devices[step.event.device];
      OneFilePerName(device0.platform, device0.disk)
      && EffectsTake(device0.platform, device0.disk, step.effects, step.post.devices[step.event.device].disk)
      && Performed(device0.platform, device0.disk, step.effects)
      && PassHist(device0.platform, device0, accepted, step.effects)
    requires forall rev | rev in accepted :: rev in step.post.server.accepted && step.post.server.accepted[rev] == accepted[rev]
    requires i < |step.effects| && IsCond(step.effects[i])
    requires KeptBase(step, CondDoc(step.effects[i]), CondExpect(step.effects[i]))
    requires KeptWrites(step, i, CondDoc(step.effects[i]), CondExpect(step.effects[i]))
    ensures RoundSaw(step, i, CondDoc(step.effects[i]), CondPath(step.effects[i]), CondExpect(step.effects[i]))
    decreases i
  {
    var d := step.event.device;
    var device0 := step.pre.devices[d];
    var platform := device0.platform;
    var disk0 := device0.disk;
    var effects := step.effects;
    var effect := effects[i];
    var e := CondDoc(effect);
    var p := CondPath(effect);
    var c := CondExpect(effect);
    // The disk the effects before it leave, where its precondition holds.
    assert effects == effects[..i] + effects[i..];
    EffectsTakeSplit(platform, disk0, effects[..i], effects[i..], step.post.devices[d].disk);
    var disk: map<Path, DiskFile> := var disk: map<Path, DiskFile> :| EffectsTake(platform, disk0, effects[..i], disk) && EffectsTake(platform, disk, effects[i..], step.post.devices[d].disk); disk;
    assert PreconditionHolds(platform, disk, effect);
    var q: Path := var q: Path :| Holds(platform, disk, q, p, c); q;
    forall k, d' | 0 <= k < |effects[..i]| && EffectsTake(platform, disk0, effects[..i][..k], d')
      ensures PreconditionHolds(platform, d', effects[..i][k])
    {
      assert effects[..i][..k] == effects[..k] && effects[..i][k] == effects[k];
    }
    EffectsKeepOneFilePerName(platform, disk0, effects[..i], disk);
    PutHolds(platform, disk0, effects[..i], disk, p);
    assert CondAt(platform, device0, accepted, effects, i);
    var accepts := AcceptedContent(accepted, e, c);
    if accepts {
      var rev := var rev :| rev in accepted && accepted[rev].doc == e && !accepted[rev].deleted && accepted[rev].content == c; rev;
      assert DocVersion(step, e, c);
    }
    assert effects[..i] == step.effects[..i];
    match RoundPut(platform, effects[..i], p)
    case Freed =>
      assert false;
    case By(j) =>
      PutByContent(platform, disk0, effects[..i], disk, p, q, c);
      assert effects[..i][j] == effects[j];
      if !accepts {
        assert OwnNameIn(platform, device0, effects[..i], e, p);
        if effects[j].Write? {
          assert effects[j].target == Some(e) && effects[j].content == c;
        } else {
          assert effects[j].Move? && effects[j].mover == Some(e) && effects[j].expected == c;
          assert IsCond(effects[j]) && CondDoc(effects[j]) == e && CondExpect(effects[j]) == c && CondPath(effects[j]) == effects[j].from;
          CondSaw(step, accepted, j);
        }
      }
    case Untouched =>
      CondSawUntouchedAt(step, i, e, p, c, disk, q);
  }

  // CondSaw's case of a file no earlier effect of the round touched.
  lemma CondSawUntouchedAt(step: Step, i: nat, e: DocId, p: Path, c: Hash, disk: map<Path, DiskFile>, q: Path)
    requires step.event.SyncRound? && step.event.device in step.pre.devices && i <= |step.effects|
    requires var device0 := step.pre.devices[step.event.device];
      OneFilePerName(device0.platform, device0.disk)
      && RoundPut(device0.platform, step.effects[..i], p).Untouched?
      && PutOnDisk(device0.platform, device0.disk, step.effects[..i], disk, p)
      && Holds(device0.platform, disk, q, p, c)
      && (OwnNameIn(device0.platform, device0, step.effects[..i], e, p) || DocVersion(step, e, c))
    requires KeptBase(step, e, c)
    ensures RoundSaw(step, i, e, p, c)
  {
    if !DocVersion(step, e, c) {
      var device0 := step.pre.devices[step.event.device];
      assert BoundTo(device0, e, p);
      assert q in device0.disk && device0.disk[q] == disk[q];
      CondSawUntouched(step, e, p, c, q);
    }
  }

  // Every conditional write of the pass names a document.
  ghost predicate WritesTargeted(effects: seq<Effect>) {
    forall i | 0 <= i < |effects| :: effects[i].Write? && effects[i].precondition.Some? ==> effects[i].target.Some?
  }

  lemma SettleKeepsTargeted(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires WritesTargeted(pass.effects)
    ensures WritesTargeted(SettleRevision(platform, pass, doc, r, input, revs, first).effects)
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if !Distinct(platform, pass.listing) || r.path in input.outOfScope { return; }
    var rows := documents[doc := row];
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    var intents := IntentsFor(doc, r, ruled.effects, pass.n);
    var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
    var all := pass.effects + guard + ruled.effects;
    assert SettleRevision(platform, pass, doc, r, input, revs, first).effects == all;
    RuleSaws(platform, rows, doc, r, inner, revs', first);
    forall i | 0 <= i < |all| && all[i].Write? && all[i].precondition.Some? ensures all[i].target.Some? {
      if i < |pass.effects| { assert all[i] == pass.effects[i]; }
      else if i < |pass.effects + guard| { assert all[i] in guard; }
      else { assert all[i] in ruled.effects; }
    }
  }

  lemma SettlePulledKeepsTargeted(platform: Platform, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires WritesTargeted(pass.effects)
    ensures WritesTargeted(SettlePulled(platform, pass, revisions, input, revs, first).effects)
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsTargeted(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettlePulledKeepsTargeted(platform, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsTargeted(platform: Platform, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires WritesTargeted(pass.effects)
    ensures WritesTargeted(RetryWaiting(platform, pass, docs, input, revs, first).effects)
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        SettleKeepsTargeted(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryKeepsTargeted(platform, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsTargeted(platform, pass, docs[1..], input, revs, first);
      }
    }
  }

  // The round's effects: all performed, each conditional one acting on a
  // file whose origin the pass knows, every conditional write naming a
  // document.
  lemma {:isolate_assertions} RoundG2Facts(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input)
    requires G5_NeverJoined(pre) && JournalsNameAccepted(pre) && G7_OneFilePerName(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    ensures var step := RoundStepOf(pre, d, input, revs);
      var device := pre.devices[d];
      OneFilePerName(device.platform, device.disk)
      && EffectsTake(device.platform, device.disk, step.effects, step.post.devices[d].disk)
      && Performed(device.platform, device.disk, step.effects)
      && PassHist(device.platform, device, pre.server.accepted, step.effects)
      && WritesTargeted(step.effects)
  {
    var step := RoundStepOf(pre, d, input, revs);
    var device := pre.devices[d];
    var platform := device.platform;
    var journal := device.journal;
    var accepted := pre.server.accepted;
    RoundOnlyTouchesDevice(pre, d, input, revs);
    RoundDisksFollowEffects(pre, d, input, revs);
    assert OneFilePerName(platform, device.disk);
    if !(forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs) {
      assert step.effects == [];
      return;
    }
    var feed := pre.server.feed;
    var behind := journal.cursor < |feed|;
    var pulled := if behind then Revisions(pre.server, feed[journal.cursor..]) else [];
    var cursor' := if behind then |feed| else journal.cursor;
    var anchor' := if behind then Some(feed[|feed| - 1]) else journal.anchor;
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    var push := OnPush(platform, read, input', revs);
    assert step.effects == settled.effects + push.1;
    assert input.listing == ListingOf(device);
    OneFileDistinct(platform, device.disk);
    assert NeverJoinedRows(platform, journal.documents);
    assert RowsNameAccepted(accepted, journal.documents);
    forall e | e in start.journal.documents
      ensures RowOrigin(platform, device, accepted, start.effects, start.listing, e, start.journal.documents[e])
    {
      if journal.documents[e].binding.Some? {
        assert SameF(platform, journal.documents[e].binding.value.spelling, journal.documents[e].binding.value.spelling);
        assert BoundTo(device, e, journal.documents[e].binding.value.spelling);
      }
    }
    assert PassNUD(platform, device, accepted, start);
    PassG5Start(device, start, journal.cursor);
    PassContentStart(device, accepted, start, journal.cursor);
    assert PassHist(platform, device, accepted, start.effects) by {
      forall i | 0 <= i < |start.effects| ensures CondAt(platform, device, accepted, start.effects, i) {
        assert start.effects[i] == Pull(journal.cursor);
      }
    }
    assert Performed(platform, device.disk, start.effects) by {
      forall i, disk' | 0 <= i < |start.effects| && EffectsTake(platform, device.disk, start.effects[..i], disk')
        ensures PreconditionHolds(platform, disk', start.effects[i])
      {
        assert start.effects[i] == Pull(journal.cursor);
      }
    }
    assert WritesTargeted(start.effects);
    RetryKeepsHist(platform, device, accepted, start, WaitingRows(journal.documents), input, revs, first);
    RetryKeepsPerformed(platform, device, start, WaitingRows(journal.documents), input, revs, first);
    RetryKeepsTargeted(platform, start, WaitingRows(journal.documents), input, revs, first);
    RetryKeepsG5(platform, device, start, WaitingRows(journal.documents), input, revs, first);
    RetryKeepsContent(platform, device, accepted, start, WaitingRows(journal.documents), input, revs, first);
    if behind {
      var ids := feed[journal.cursor..];
      RevisionsHeld(pre.server, ids);
      forall i | 0 <= i < |pulled| ensures AcceptedAs(accepted, pulled[i]) {
        assert pulled[i] in pulled;
      }
    }
    SettlePulledKeepsHist(platform, device, accepted, retried, pulled, input, revs, first);
    SettlePulledKeepsPerformed(platform, device, retried, pulled, input, revs, first);
    SettlePulledKeepsTargeted(platform, retried, pulled, input, revs, first);
    PushTouchesNoFile(platform, read, input', revs);
    var all := step.effects;
    forall i | 0 <= i < |all| ensures CondAt(platform, device, accepted, all, i) {
      if i < |settled.effects| {
        assert all[i] == settled.effects[i] && all[..i] == settled.effects[..i];
        assert CondAt(platform, device, accepted, settled.effects, i);
      } else {
        assert all[i] in push.1;
      }
    }
    forall i, disk' | 0 <= i < |all| && EffectsTake(platform, device.disk, all[..i], disk')
      ensures PreconditionHolds(platform, disk', all[i])
    {
      if i < |settled.effects| {
        assert all[i] == settled.effects[i] && all[..i] == settled.effects[..i];
      } else {
        assert all[i] in push.1;
      }
    }
    forall i | 0 <= i < |all| && all[i].Write? && all[i].precondition.Some? ensures all[i].target.Some? {
      if i < |settled.effects| { assert all[i] == settled.effects[i]; } else { assert all[i] in push.1; }
    }
  }

  // The round keeps what each of its conditional overwrites and removes
  // expects, at the start of its chain of puts and where the round wrote
  // it (KeptBase, KeptWrites). Proved of the round in RoundKeeps.dfy.
  ghost predicate RoundKept(step: Step)
    requires RoundEvent(step.event) && step.event.device in step.pre.devices
  {
    forall i | 0 <= i < |step.effects| && IsCond(step.effects[i]) && !step.effects[i].Move? ::
      KeptBase(step, CondDoc(step.effects[i]), CondExpect(step.effects[i]))
      && KeptWrites(step, i, CondDoc(step.effects[i]), CondExpect(step.effects[i]))
  }

  // G2_OnlyWhatItSaw of the round, where it keeps what its overwrites and
  // removes expect (RoundKept).
  lemma RoundG2OnlyWhatItSawKept(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input)
    requires G5_NeverJoined(pre) && JournalsNameAccepted(pre) && G7_OneFilePerName(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    requires RoundKept(RoundStepOf(pre, d, input, revs))
    ensures G2_OnlyWhatItSaw(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    RoundOnlyTouchesDevice(pre, d, input, revs);
    RoundG2Facts(pre, d, input, revs);
    var device := pre.devices[d];
    forall effect | effect in step.effects
      ensures (effect.Write? && effect.precondition.Some? ==>
                 effect.target.Some?
                 && ((BoundTo(device, effect.target.value, effect.path)
                      && LastSaw(step, device, effect.target.value, effect.path, effect.precondition.value))
                     || RoundSawEffect(step, effect)))
      ensures (effect.Remove? ==>
                 (BoundTo(device, effect.doc, effect.path) && LastSaw(step, device, effect.doc, effect.path, effect.expected))
                 || RoundSawEffect(step, effect))
    {
      var i := var i :| 0 <= i < |step.effects| && step.effects[i] == effect; i;
      if (effect.Write? && effect.precondition.Some?) || effect.Remove? {
        assert IsCond(effect);
        CondSaw(step, pre.server.accepted, i);
      }
    }
  }
}
