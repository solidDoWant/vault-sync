// The sync round's moves and removes: G7_MoveKeepsContents (a move that
// took effect leaves its content at its new name, or a later effect acts
// on it there conditional on exactly that content) and G2_NoUntrackedDelete
// (where each binding's file came from, PassNUD).
include "RoundGuarantees.dfy"

abstract module RoundMovesAndRemoves refines RoundGuarantees {

  // ---------------------------------------------------------------------
  // G7_MoveKeepsContents: a move that took effect leaves its
  // content at its new name, unless a later effect of the round acts on it
  // there conditional on exactly that content (RoundMovesKeepContents)
  // ---------------------------------------------------------------------

  // A move that took effect on `mid` puts its content at `to`; the effects
  // after it keep it there unless one of them matched it there. It holds of
  // any effect sequence, so of any prefix of a round's effects too (a crash
  // that cut the round short).
  lemma MoveArrivesOrMovesOn(platform: Platform, effects: seq<Effect>, disk': map<Path, DiskFile>, i: int,
                             mid: map<Path, DiskFile>, q: Path)
    requires 0 <= i < |effects| && effects[i].Move?
    requires EffectsTake(platform, mid, effects[i..], disk')
    requires MovableTo(platform, mid, q, effects[i].from, effects[i].to, effects[i].expected)
    ensures var moved := effects[i];
      (moved.to in disk' && disk'[moved.to].content == moved.expected)
      || exists j :: i < j < |effects| && MatchedBy(platform, effects[j], moved.to, moved.expected)
  {
    var moved := effects[i];
    var m1: map<Path, DiskFile> := var m1: map<Path, DiskFile> :|
      EffectTakes(platform, mid, effects[i..][0], m1) && EffectsTake(platform, m1, effects[i..][1..], disk'); m1;
    assert effects[i..][0] == moved;
    assert effects[i..][1..] == effects[i + 1..];
    var q' := var q' :| MovableTo(platform, mid, q', moved.from, moved.to, moved.expected)
      && m1 == (mid - {q'})[moved.to := mid[q']]; q';
    assert moved.to in m1 && m1[moved.to].content == moved.expected;
    if moved.to !in disk' || disk'[moved.to] != m1[moved.to] {
      EffectsChangeOnlyMatched(platform, m1, effects[i + 1..], disk', moved.to);
      var effect: Effect := var effect: Effect :| effect in effects[i + 1..]
        && MatchedBy(platform, effect, moved.to, m1[moved.to].content); effect;
      var k := var k :| 0 <= k < |effects[i + 1..]| && effects[i + 1..][k] == effect; k;
      assert effects[i + 1 + k] == effect;
    }
  }

  lemma RoundG7MoveKeepsContents(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures G7_MoveKeepsContents(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    var platform := pre.devices[d].platform;
    RoundOnlyTouchesDevice(pre, d, input, revs);
    forall i, mid, q | 0 <= i < |step.effects| && step.effects[i].Move?
        && EffectsTake(platform, step.pre.devices[d].disk, step.effects[..i], mid)
        && EffectsTake(platform, mid, step.effects[i..], step.post.devices[d].disk)
        && MovableTo(platform, mid, q, step.effects[i].from, step.effects[i].to, step.effects[i].expected)
      ensures (exists k :: k in step.post.devices[d].disk && SameF(platform, k, step.effects[i].to)
                 && step.post.devices[d].disk[k].content == step.effects[i].expected)
              || RoundMovesOn(step, i)
    {
      var moved := step.effects[i];
      MoveArrivesOrMovesOn(platform, step.effects, step.post.devices[d].disk, i, mid, q);
      if moved.to in step.post.devices[d].disk && step.post.devices[d].disk[moved.to].content == moved.expected {
        assert SameF(platform, moved.to, moved.to);
      } else {
        var j := var j :| i < j < |step.effects| && MatchedBy(platform, step.effects[j], moved.to, moved.expected); j;
        assert RoundMovesOn(step, i);
      }
    }
    assert RoundMovesKeepContents(step);
  }

  // ---------------------------------------------------------------------
  // G2_NoUntrackedDelete: where each binding's file came from
  // ---------------------------------------------------------------------

  // The effect writes, removes or moves a file at `s` (either end).
  ghost predicate Touches(platform: Platform, effect: Effect, s: Path) {
    (effect.Write? && SameF(platform, effect.path, s))
    || (effect.Remove? && SameF(platform, effect.path, s))
    || (effect.Move? && (SameF(platform, effect.from, s) || SameF(platform, effect.to, s)))
  }

  // How the apply leaves its row's binding: at a name an effect of its
  // own puts a tracked file at; at the name it had, untouched, having seen
  // what it saw or what the listing reads there; or adopting the listed
  // file at its name that holds exactly the live revision, untouched.
  ghost predicate AppliedOrigin(platform: Platform, listing: Listing, e: DocId, document: Document, r: Revision, after: Document, effects: seq<Effect>, adopt: bool)
    requires ListingDistinct(platform, listing)
  {
    after.binding.Some? ==>
      var s := after.binding.value.spelling;
      var seen := after.binding.value.seen;
      (exists effect :: effect in effects && PutsFor(platform, effect, e, s))
      || (document.binding.Some? && s == document.binding.value.spelling
          && (seen == document.binding.value.seen
              || (ListedRead(platform, listing, s).Some? && seen == ListedRead(platform, listing, s).value.0))
          && forall effect :: effect in effects ==> !Touches(platform, effect, s))
      || (adopt && !r.deleted && seen == r.content && ListedRead(platform, listing, s) == Some((r.content, r.kind))
          && forall effect :: effect in effects ==> !Touches(platform, effect, s))
  }

  // The effect writes or moves document `e`'s file to `p` (G5 (b)).
  ghost predicate PutsFor(platform: Platform, effect: Effect, e: DocId, p: Path) {
    (effect.Write? && effect.target == Some(e) && SameF(platform, effect.path, p))
    || (effect.Move? && effect.mover == Some(e) && SameF(platform, effect.to, p))
  }

  // A listed name is its own listed spelling.
  lemma ListedAtSelf(platform: Platform, listing: Listing, p: Path)
    requires ListingDistinct(platform, listing) && p in listing
    ensures Listed(platform, listing, p) && ListedAt(platform, listing, p) == p
  {
    assert SameF(platform, p, p);
  }

  // Create binds only at the head's name: written there, adopted there, or
  // not at all (the row keeps its binding and nothing is written).
  lemma {:isolate_assertions} CreateOrigin(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing) && !r.deleted
    ensures var applied := Create(platform, doc, document, r, input, bound, claims, rev);
      applied.document.binding.Some? ==>
        var s := applied.document.binding.value.spelling;
        (exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, s))
        || (applied.document.binding == document.binding
            && forall effect :: effect in applied.effects ==> !Touches(platform, effect, s))
        || (!r.deleted && applied.document.binding.value.seen == r.content
            && ListedRead(platform, input.listing, s) == Some((r.content, r.kind))
            && forall effect :: effect in applied.effects ==> !Touches(platform, effect, s))
  {
    var applied := Create(platform, doc, document, r, input, bound, claims, rev);
    assert SameF(platform, r.path, r.path);
    if UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path) {
    } else if FreeIn(platform, input.listing, r.path) {
      assert applied.effects[0] in applied.effects;
    } else if Adoptable(platform, document, input, r) {
      ListedAtSelf(platform, input.listing, r.path);
      assert applied.effects == [];
      assert applied.document.binding == Some(Binding(r.path, r.content, false, None));
      assert ListedRead(platform, input.listing, r.path) == Some(input.listing[r.path]);
      assert input.listing[r.path] == (r.content, r.kind);
    } else {
      var held := Colliders(platform, input.listing, r.path);
      if |held| == 1 && !BoundName(platform, bound, LeastPath(held))
         && !UnsavedCollides(platform, input.unsaved, LeastPath(held)) {
        var q := LeastPath(held);
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, q, r.path);
        if copy.Some? {
          var write := Write(Some(doc), r.path, r.content, r.kind, None);
          assert applied.effects == [Move(None, q, copy.value, input.listing[q].0), write];
          assert applied.document.binding.value.spelling == r.path;
          assert write in applied.effects && PutsFor(platform, write, doc, r.path);
        }
      }
    }
  }

  // The settlement of a concurrent edit binds where it was bound: written
  // there, or taking what the listing reads there.
  lemma {:isolate_assertions} SettleOrigin(platform: Platform, doc: DocId, document: Document, read: (Hash, Kind), r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    requires document.binding.Some? && document.base.Some?
    requires ListedRead(platform, input.listing, document.binding.value.spelling) == Some(read)
    ensures var applied := Settle(platform, doc, document, read, r, input, bound, claims, rev);
      AppliedOrigin(platform, input.listing, doc, document, r, applied.document, applied.effects, true)
  {
    var applied := Settle(platform, doc, document, read, r, input, bound, claims, rev);
    var spelling := document.binding.value.spelling;
    var b := document.base.value.content;
    var l := read.0;
    assert SameF(platform, spelling, spelling);
    if l == b && l == document.binding.value.seen {
      assert applied.effects[0] in applied.effects;
    } else if r.content == b {
    } else if l != b && read.1 == Note && r.kind == Note && Merge(b, l, r.content).Some? {
      assert applied.effects[0] in applied.effects;
    } else {
      var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, spelling, spelling);
      if copy.Some? {
        assert applied.effects[1] in applied.effects;
      }
    }
  }

  lemma {:isolate_assertions} ApplyOrigin(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      AppliedOrigin(platform, input.listing, doc, document, r, applied.document, applied.effects, true)
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    if !Newer(document, r) {
    } else if SettlesIdentical(platform, document, r, input) {
    } else if Acknowledges(document, r) {
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreateOrigin(platform, doc, Revived(document), r, input, bound, claims, rev);
      }
    } else if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      assert SameF(platform, spelling, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
      } else if r.deleted && read.None? {
      } else if Concurrent(document, read, r) {
        SettleOrigin(platform, doc, document, read.value, r, input, bound, claims, rev);
      } else if MovedAgainstChange(document, read, r) {
      } else if EditedAgainstDelete(document, read, r) {
      } else if !Clean(platform, document, read) && !r.deleted && read.Some?
              && document.base.Some? && document.base.value.rev == r.id {
      } else if !Clean(platform, document, read) {
      } else if r.deleted {
      } else if r.path == spelling {
        assert applied.effects[0] in applied.effects;
      }
    } else if r.deleted {
    } else {
      CreateOrigin(platform, doc, document, r, input, bound, claims, rev);
    }
  }

  // The apply touches no name another row is bound at: it writes and
  // removes only at its own binding, creates only where nothing is bound,
  // moves only an untracked file, and names copies away from every bound
  // name.
  lemma {:isolate_assertions} CreateLeavesOthers(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, s: Path)
    requires ListingDistinct(platform, input.listing) && s in bound
    ensures forall effect :: effect in Create(platform, doc, document, r, input, bound, claims, rev).effects ==> !Touches(platform, effect, s)
  {
    if !(UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path)) {
      assert !SameF(platform, s, r.path);
      if !FreeIn(platform, input.listing, r.path) && !Adoptable(platform, document, input, r) {
        var held := Colliders(platform, input.listing, r.path);
        if |held| == 1 && !BoundName(platform, bound, LeastPath(held)) {
          assert !SameF(platform, s, LeastPath(held));
        }
      }
    }
  }

  lemma {:isolate_assertions} SettleLeavesOthers(platform: Platform, doc: DocId, document: Document, read: (Hash, Kind), r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, s: Path)
    requires ListingDistinct(platform, input.listing) && s in bound
    requires document.binding.Some? && document.base.Some? && !SameF(platform, document.binding.value.spelling, s)
    ensures forall effect :: effect in Settle(platform, doc, document, read, r, input, bound, claims, rev).effects ==> !Touches(platform, effect, s)
  {}

  lemma {:isolate_assertions} ApplyLeavesOthers(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, s: Path)
    requires ListingDistinct(platform, input.listing) && s in bound
    requires document.binding.Some? ==> !SameF(platform, document.binding.value.spelling, s)
    ensures forall effect :: effect in ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects ==> !Touches(platform, effect, s)
  {
    if !Newer(document, r) {
    } else if SettlesIdentical(platform, document, r, input) {
    } else if Acknowledges(document, r) {
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreateLeavesOthers(platform, doc, Revived(document), r, input, bound, claims, rev, s);
      }
    } else if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
      } else if r.deleted && read.None? {
      } else if Concurrent(document, read, r) {
        SettleLeavesOthers(platform, doc, document, read.value, r, input, bound, claims, rev, s);
      }
    } else if !r.deleted {
      CreateLeavesOthers(platform, doc, document, r, input, bound, claims, rev, s);
    }
  }

  // The arrival puts the head's file at its name for the document.
  lemma ArrivePutsHead(platform: Platform, doc: DocId, document: Document, a: Revision, own: Option<Path>)
    ensures exists effect :: effect in Arrive(platform, doc, document, a, own) && PutsFor(platform, effect, doc, a.path)
  {
    var effects := Arrive(platform, doc, document, a, own);
    assert SameF(platform, a.path, a.path);
    assert effects[|effects| - 1] in effects;
  }

  // ...and touches only the document's own file and the head's name.
  lemma ArriveTouchesOnly(platform: Platform, doc: DocId, document: Document, a: Revision, own: Option<Path>, s: Path)
    requires own.Some? ==> !SameF(platform, own.value, s)
    requires !SameF(platform, a.path, s)
    ensures forall effect :: effect in Arrive(platform, doc, document, a, own) ==> !Touches(platform, effect, s)
  {}

  lemma {:isolate_assertions} ClearWayOrigin(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e in ClearWay(platform, documents, doc, r, input, revs).documents
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      AppliedOrigin(platform, input.listing, e, documents[e], r, ruled.documents[e], ruled.effects, e == doc)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      assert ruled.documents[e].binding == documents[e].binding;
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    var rows := ruled.documents;
    assert rows == ClearRows(platform, documents, doc, r, input, moves, revs);
    if rows[e].binding.None? { return; }
    var s := rows[e].binding.value.spelling;
    if e == doc {
      assert s == r.path;
      var a := Arriving(platform, document, r, input);
      ArrivePutsHead(platform, doc, ArrivingRow(platform, document, r, input), a, keep);
      var effect := var effect :| effect in arrive && PutsFor(platform, effect, doc, a.path); effect;
      assert effect in ruled.effects;
      return;
    }
    ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e);
    if exists i | 0 <= i < |moves| :: s == moves[i].1 && FileOf(platform, documents, moves[i].0, e) {
      var i := var i :| 0 <= i < |moves| && s == moves[i].1 && FileOf(platform, documents, moves[i].0, e); i;
      MoveRowsRow(platform, documents, doc, moves, revs, input.listing, e);
      var moved := MoveRows(platform, documents, doc, moves, revs);
      assert moved[e] == MovedAside(documents[e], moves[i].1, revs[e]);
      var recorded := RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs);
      assert rows[e] == recorded[e];
      assert recorded[e] == moved[e] || recorded[e].binding.None?;
      assert LocallyPlaced(documents[e]);
      MoveEffectsMover(platform, documents, doc, moves, i, e);
      assert SameF(platform, front[i].to, s);
      assert front[i] in ruled.effects && PutsFor(platform, front[i], e, s);
    } else {
      assert rows[e].binding == documents[e].binding;
      var t := documents[e].binding.value.spelling;
      assert t == s && t in avoid;
      forall effect | effect in ruled.effects
        ensures !Touches(platform, effect, s)
      {
        if effect in front {
          var i := var i :| 0 <= i < |front| && front[i] == effect; i;
          assert !FileOf(platform, documents, moves[i].0, e);
          assert !SameF(platform, t, moves[i].1);
        } else {
          assert effect in arrive;
          var own := keep;
          if own.Some? {
            var b := document.binding.value.spelling;
            assert SameF(platform, own.value, b);
            assert !SameF(platform, b, t);
          }
          ArriveTouchesOnly(platform, doc, ArrivingRow(platform, document, r, input), Arriving(platform, document, r, input), keep, s);
        }
      }
    }
  }

  lemma {:isolate_assertions} RuleOrigin(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents && AppliedOrigin(platform, input.listing, e, documents[e], r, ruled.documents[e], ruled.effects, e == doc)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    RuleRowsListed(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      if e == doc {
        ApplyOrigin(platform, doc, document, r, input, bound, claims, revs[doc]);
      } else if documents[e].binding.Some? {
        var t := documents[e].binding.value.spelling;
        assert t in bound;
        ApplyLeavesOthers(platform, doc, document, r, input, bound, claims, revs[doc], t);
      }
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      HeldKeepsBinding(platform, doc, document, r, input, bound, claims, revs[doc]);
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
    } else {
      ClearWayOrigin(platform, documents, doc, r, input, revs, e);
    }
  }

  // The listing at a name no effect touches stays as it was.
  lemma ListingEffectUntouched(platform: Platform, listing: Listing, effect: Effect, s: Path)
    requires Distinct(platform, listing) && !Touches(platform, effect, s)
    ensures var after := ListingAfterEffect(platform, listing, effect);
      Distinct(platform, after) ==>
        (Listed(platform, after, s) <==> Listed(platform, listing, s))
        && (Listed(platform, listing, s) ==> ListedRead(platform, after, s) == ListedRead(platform, listing, s))
  {
    var after := ListingAfterEffect(platform, listing, effect);
    if Distinct(platform, after) {
      if Listed(platform, listing, s) {
        var k := ListedAt(platform, listing, s);
        match effect
        case Write(_, path, _, _, precondition) =>
          if Listed(platform, listing, path) {
            var q := ListedAt(platform, listing, path);
            SameFIsEquivalence(platform, q, path, s);
            SameFIsEquivalence(platform, k, s, q);
          }
        case Remove(_, path, _) =>
          if Listed(platform, listing, path) {
            var q := ListedAt(platform, listing, path);
            SameFIsEquivalence(platform, q, path, s);
            SameFIsEquivalence(platform, k, s, q);
          }
        case Move(_, from, to, _) =>
          if Listed(platform, listing, from) {
            var q := ListedAt(platform, listing, from);
            SameFIsEquivalence(platform, q, from, s);
            SameFIsEquivalence(platform, k, s, q);
          }
        case _ =>
        assert k in after && SameF(platform, k, s);
        assert ListedAt(platform, after, s) == k;
      } else {
        match effect
        case Write(_, path, _, _, _) =>
          SameFIsEquivalence(platform, path, s, path);
        case Move(_, from, to, _) =>
          SameFIsEquivalence(platform, to, s, to);
        case _ =>
      }
    }
  }

  lemma ListingAfterUntouched(platform: Platform, listing: Listing, effects: seq<Effect>, s: Path)
    requires Distinct(platform, listing) && forall effect :: effect in effects ==> !Touches(platform, effect, s)
    ensures var after := ListingAfter(platform, listing, effects);
      Distinct(platform, after) ==>
        (Listed(platform, after, s) <==> Listed(platform, listing, s))
        && (Listed(platform, listing, s) ==> ListedRead(platform, after, s) == ListedRead(platform, listing, s))
    decreases |effects|
  {
    if |effects| > 0 {
      var mid := ListingAfterEffect(platform, listing, effects[0]);
      assert effects[0] in effects;
      ListingEffectUntouched(platform, listing, effects[0], s);
      if Distinct(platform, mid) {
        ListingAfterUntouched(platform, mid, effects[1..], s);
      } else {
        ListingAfterFrozen(platform, mid, effects[1..]);
      }
    }
  }

  // The rule removes only its document's own bound file, expecting what it
  // last saw there or what the listing reads there.
  ghost predicate RemovesOwn(platform: Platform, listing: Listing, document: Document, effect: Effect)
    requires ListingDistinct(platform, listing)
  {
    effect.Remove? ==>
      document.binding.Some? && SameF(platform, document.binding.value.spelling, effect.path)
      && (effect.expected == document.binding.value.seen
          || (ListedRead(platform, listing, document.binding.value.spelling).Some?
              && effect.expected == ListedRead(platform, listing, document.binding.value.spelling).value.0))
  }

  lemma {:isolate_assertions} RuleRemovesOwn(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures forall effect :: effect in PathRule(platform, documents, doc, r, input, revs, first).effects ==>
      (effect.Remove? ==> effect.doc == doc) && RemovesOwn(platform, input.listing, documents[doc], effect)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if document.binding.Some? {
      assert SameF(platform, document.binding.value.spelling, document.binding.value.spelling);
    }
    if !HeldForName(document, applied, r) {
      assert ruled.effects == applied.effects;
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
    } else {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        MoveEffectsShape(platform, documents, doc, aside.value);
        var front := MoveEffects(platform, documents, doc, aside.value);
        var arrive := ArriveOf(platform, doc, document, r, input);
        reveal ArrivingRow();
        forall effect | effect in ruled.effects && effect.Remove?
          ensures effect.doc == doc && RemovesOwn(platform, input.listing, document, effect)
        {
          if effect in front {
            var i := var i :| 0 <= i < |front| && front[i] == effect; i;
          }
          assert effect in arrive;
          assert keep.Some?;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // G2_NoUntrackedDelete over the round: the pass invariant
  // ---------------------------------------------------------------------

  // Some live revision of `e` the server accepted has content `c`.
  ghost predicate AcceptedContent(accepted: map<RevId, Revision>, e: DocId, c: Hash) {
    exists rev :: rev in accepted && accepted[rev].doc == e && !accepted[rev].deleted && accepted[rev].content == c
  }

  // Where a row's bound file came from: a name tracked before the round, a
  // name an earlier effect of the round put a tracked file at, or a file
  // holding what the binding saw, a live revision of the document the
  // server accepted (adopted, or synced).
  ghost predicate RowOrigin(platform: Platform, device0: Device, accepted: map<RevId, Revision>, effects: seq<Effect>,
                            listing: Listing, e: DocId, row: Document) {
    row.binding.Some? ==>
      var s := row.binding.value.spelling;
      var seen := row.binding.value.seen;
      Tracked(device0, s)
      || (exists j :: 0 <= j < |effects| && PutsTracked(platform, effects[j], s))
      || (AcceptedContent(accepted, e, seen)
          && (Distinct(platform, listing) && Listed(platform, listing, s) ==> ListedRead(platform, listing, s).value.0 == seen))
  }

  // A remove so far is of a name tracked before the round, of a live
  // accepted revision's content, or of a name an earlier effect put a
  // tracked file at.
  ghost predicate RemoveOK(platform: Platform, device0: Device, accepted: map<RevId, Revision>, effects: seq<Effect>, i: int)
    requires 0 <= i < |effects|
  {
    effects[i].Remove? ==>
      Tracked(device0, effects[i].path) || AcceptedContent(accepted, effects[i].doc, effects[i].expected)
      || exists j :: 0 <= j < i && PutsTracked(platform, effects[j], effects[i].path)
  }

  ghost predicate PassNUD(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass) {
    var rows := pass.journal.documents;
    NeverJoinedRows(platform, rows) && RowsNameAccepted(accepted, rows)
    && (forall e | e in rows :: RowOrigin(platform, device0, accepted, pass.effects, pass.listing, e, rows[e]))
    && (forall i | 0 <= i < |pass.effects| :: RemoveOK(platform, device0, accepted, pass.effects, i))
  }

  lemma {:isolate_assertions} SettleKeepsNUD(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                                             doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass) && AcceptedAs(accepted, r) && r.doc == doc
    ensures PassNUD(platform, device0, accepted, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    SettleNamesAccepted(platform, accepted, pass, doc, r, input, revs, first);
    if !Distinct(platform, pass.listing) { return; }
    if r.path in input.outOfScope {
      if Newer(row, r) {
        var rows' := settled.journal.documents;
        assert rows' == documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))];
        assert forall e | e in rows' :: (e in documents && rows'[e].binding == documents[e].binding)
                                        || rows'[e].binding.None?;
        assert settled.listing == pass.listing && settled.effects == pass.effects;
        assert NeverJoinedRows(platform, rows');
      }
      return;
    }
    var rows := documents[doc := row];
    assert NeverJoinedRows(platform, rows);
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    var intents := IntentsFor(doc, r, ruled.effects, pass.n);
    var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
    var effects' := pass.effects + guard + ruled.effects;
    var listing' := ListingAfter(platform, pass.listing, ruled.effects);
    assert settled.journal.documents == ruled.documents && settled.effects == effects' && settled.listing == listing';
    RuleKeepsNeverJoined(platform, rows, doc, r, inner, revs', first);
    RuleRowsListed(platform, rows, doc, r, inner, revs', first);
    var base := |pass.effects| + |guard|;
    assert forall m | 0 <= m < |ruled.effects| :: effects'[base + m] == ruled.effects[m];
    assert forall j | 0 <= j < |pass.effects| :: effects'[j] == pass.effects[j];
    // Every row keeps an origin.
    forall e | e in ruled.documents
      ensures RowOrigin(platform, device0, accepted, effects', listing', e, ruled.documents[e])
    {
      RuleOrigin(platform, rows, doc, r, inner, revs', first, e);
      var after := ruled.documents[e];
      if after.binding.Some? {
        var s := after.binding.value.spelling;
        if exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, s) {
          var effect := var effect :| effect in ruled.effects && PutsFor(platform, effect, e, s); effect;
          assert PutsTracked(platform, effect, s);
          var m := var m :| 0 <= m < |ruled.effects| && ruled.effects[m] == effect; m;
          assert effects'[base + m] == effect;
        } else {
          ListingAfterUntouched(platform, pass.listing, ruled.effects, s);
          if rows[e].binding.Some? && s == rows[e].binding.value.spelling
             && forall effect :: effect in ruled.effects ==> !Touches(platform, effect, s) {
            assert e in documents;
            assert RowOrigin(platform, device0, accepted, pass.effects, pass.listing, e, rows[e]);
            if exists j :: 0 <= j < |pass.effects| && PutsTracked(platform, pass.effects[j], s) {
              var j := var j :| 0 <= j < |pass.effects| && PutsTracked(platform, pass.effects[j], s); j;
              assert PutsTracked(platform, effects'[j], s);
            }
          } else {
            assert e == doc;
            assert AcceptedContent(accepted, doc, r.content) by { assert accepted[r.id] == r; }
          }
        }
      }
    }
    // Every remove keeps its justification.
    forall i | 0 <= i < |effects'|
      ensures RemoveOK(platform, device0, accepted, effects', i)
    {
      if i < |pass.effects| {
        assert RemoveOK(platform, device0, accepted, pass.effects, i);
      } else if i >= base && effects'[i].Remove? {
        var effect := effects'[i];
        assert effect == ruled.effects[i - base];
        assert effect in ruled.effects;
        RuleRemovesOwn(platform, rows, doc, r, inner, revs', first);
        assert effect.doc == doc && RemovesOwn(platform, pass.listing, rows[doc], effect);
        var s := rows[doc].binding.value.spelling;
        assert doc in documents;
        assert RowOrigin(platform, device0, accepted, pass.effects, pass.listing, doc, rows[doc]);
        if Tracked(device0, s) {
          var x := var x :| BoundTo(device0, x, s); x;
          SameFIsEquivalence(platform, device0.journal.documents[x].binding.value.spelling, s, effect.path);
          assert BoundTo(device0, x, effect.path);
        } else if exists j :: 0 <= j < |pass.effects| && PutsTracked(platform, pass.effects[j], s) {
          var j := var j :| 0 <= j < |pass.effects| && PutsTracked(platform, pass.effects[j], s); j;
          var t := if pass.effects[j].Write? then pass.effects[j].path else pass.effects[j].to;
          SameFIsEquivalence(platform, t, s, effect.path);
          assert PutsTracked(platform, effects'[j], effect.path);
        } else {
          assert AcceptedContent(accepted, doc, rows[doc].binding.value.seen);
        }
      }
    }
  }

  lemma SettlePulledKeepsNUD(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                             revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    ensures PassNUD(platform, device0, accepted, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsNUD(platform, device0, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledKeepsNUD(platform, device0, accepted, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsNUD(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                      docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass)
    ensures PassNUD(platform, device0, accepted, RetryWaiting(platform, pass, docs, input, revs, first))
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert NeverJoinedRows(platform, cleared.journal.documents);
        assert PassNUD(platform, device0, accepted, cleared);
        SettleKeepsNUD(platform, device0, accepted, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryKeepsNUD(platform, device0, accepted, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsNUD(platform, device0, accepted, pass, docs[1..], input, revs, first);
      }
    }
  }

  // G2_NoUntrackedDelete of the round: it removes a file only at a name
  // tracked before the round, at a name an earlier effect of the round put
  // a tracked file at, or where the file holds exactly a live revision of
  // the removed document the server accepted.
  lemma {:isolate_assertions} RoundG2NoUntrackedDelete(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && G5_NeverJoined(pre) && JournalsNameAccepted(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    ensures G2_NoUntrackedDelete(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    var device := pre.devices[d];
    var platform := device.platform;
    var journal := device.journal;
    var accepted := pre.server.accepted;
    assert step.event == SyncRound(d) && step.pre == pre;
    RoundOnlyTouchesDevice(pre, d, input, revs);
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
    var push := OnPush(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
    assert step.effects == settled.effects + push.1;
    // The pass invariant from the start, through the retry and the pull.
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
    RetryKeepsNUD(platform, device, accepted, start, WaitingRows(journal.documents), input, revs, first);
    if behind {
      var ids := feed[journal.cursor..];
      RevisionsHeld(pre.server, ids);
      forall i | 0 <= i < |pulled| ensures AcceptedAs(accepted, pulled[i]) {
        assert pulled[i] in pulled;
      }
    }
    SettlePulledKeepsNUD(platform, device, accepted, retried, pulled, input, revs, first);
    PushTouchesNoFile(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
    forall effect | effect in step.effects && effect.Remove?
      ensures Tracked(device, effect.path)
              || exists i :: 0 <= i < |step.effects| && step.effects[i] == effect
                   && RoundTracked(step, i, effect.doc, effect.path, effect.expected)
    {
      var i := var i :| 0 <= i < |step.effects| && step.effects[i] == effect; i;
      if i >= |settled.effects| {
        assert step.effects[i] in push.1;
        assert false;
      }
      assert settled.effects[i] == effect;
      assert RemoveOK(platform, device, accepted, settled.effects, i);
      if !Tracked(device, effect.path) {
        if AcceptedContent(accepted, effect.doc, effect.expected) {
          assert DocVersion(step, effect.doc, effect.expected);
        } else {
          var j := var j :| 0 <= j < i && PutsTracked(platform, settled.effects[j], effect.path); j;
          assert step.effects[j] == settled.effects[j];
        }
        assert RoundTracked(step, i, effect.doc, effect.path, effect.expected);
      }
    }
  }
}
