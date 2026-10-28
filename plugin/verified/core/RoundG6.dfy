// G6 of the sync round (#1094): the round settles every concurrent change
// as G6_Step says, as G6_Settle or as a chain of single-step settles
// (RoundChain, SettleLink). The proof follows each document's settles
// through the round's pass (RoundPass, PathRule.dfy) as a chain that grows
// by one link per settled revision; a conflict copy a link saves is named
// in `saved` while the pass runs, and is shown to be saved next to it on
// the device the round leaves at the end.
//
// A module of its own (its own verify group), refining RoundGuarantees for
// the pass facts proved there.
include "RoundGuarantees.dfy"

abstract module RoundG6 refines RoundGuarantees {

  // ---------------------------------------------------------------------
  // Chains while the pass runs
  // ---------------------------------------------------------------------

  // SettleLink, with the contents its conflict copies saved (`saved`) in
  // place of SavedInRound on the device the round leaves.
  ghost predicate LinkSaved(saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>, r: Revision,
                            x: Option<(Hash, Kind)>) {
    if r.device == d then x == l
    else if r.deleted then x == l || (l.Some? && l.value.0 == b && !bd && x.None?)
    else if l.None? then x == Some((r.content, r.kind))
    else
    x.Some? &&
    var lc := l.value.0;
    var lk := l.value.1;
    var rc := r.content;
    if lc == rc then
      x == Some((rc, r.kind)) || x == l || (lk == Note && r.kind == Note && Merge3(b, lc, rc) == Some(x.value.0) && x.value.1 == Note)
    else if lc == b then x == Some((rc, r.kind))
    else if rc == b then x == l
    else if lk == Note && r.kind == Note && Merge3(b, lc, rc).Some? then Merge3(b, lc, rc) == Some(x.value.0) && x.value.1 == Note
    else (x == Some((rc, r.kind)) && lc in saved) || (x == l && rc in saved)
  }

  lemma LinkSavedGrows(saved: set<Hash>, saved': set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>,
                       r: Revision, x: Option<(Hash, Kind)>)
    requires LinkSaved(saved, d, b, bd, l, r, x) && saved <= saved'
    ensures LinkSaved(saved', d, b, bd, l, r, x)
  {}

  lemma LinkSavedIsLink(post: State, saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>,
                        r: Revision, x: Option<(Hash, Kind)>)
    requires LinkSaved(saved, d, b, bd, l, r, x)
    requires forall h :: h in saved ==> SavedInRound(post, d, h)
    ensures SettleLink(post, d, b, bd, l, r, x)
  {}

  // The chain so far: settling `rs` in turn from base content `b` (`bd`: a
  // tombstone) and local side `l` leaves the local side `x`, and, where
  // `c` is some, it is one of the chain's contents.
  ghost predicate ChainSaved(saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>, rs: seq<Revision>,
                             x: Option<(Hash, Kind)>, c: Option<Hash>)
    decreases |rs|, if l.Some? then 1 else 0
  {
    (l.Some? && l.value.0 in saved
     && ChainSaved(saved, d, b, bd, None, rs, x, if c == LocalContent(l) then None else c))
    || if |rs| == 0 then x == l && (c.None? || c == LocalContent(l))
       else exists y :: LinkSaved(saved, d, b, bd, l, rs[0], y)
              && (ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c)
                  || (c.Some? && c == LocalContent(l) && ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None)))
  }

  // The base the next link settles against: the last revision settled, or
  // the chain's start.
  ghost function ChainBase(b: Hash, rs: seq<Revision>): Hash {
    if |rs| == 0 then b else rs[|rs| - 1].content
  }

  ghost function ChainBaseDeleted(bd: bool, rs: seq<Revision>): bool {
    if |rs| == 0 then bd else rs[|rs| - 1].deleted
  }

  // A chain grows by a link from the local side it left.
  lemma ChainSavedSnoc(saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>, rs: seq<Revision>,
                       x: Option<(Hash, Kind)>, c: Option<Hash>, r: Revision, y: Option<(Hash, Kind)>)
    requires ChainSaved(saved, d, b, bd, l, rs, x, c)
    requires LinkSaved(saved, d, ChainBase(b, rs), ChainBaseDeleted(bd, rs), x, r, y)
    ensures ChainSaved(saved, d, b, bd, l, rs + [r], y, c)
    decreases |rs|, if l.Some? then 1 else 0
  {
    var lg := if c == LocalContent(l) then None else c;
    if l.Some? && l.value.0 in saved && ChainSaved(saved, d, b, bd, None, rs, x, lg) {
      ChainSavedSnoc(saved, d, b, bd, None, rs, x, lg, r, y);
      return;
    }
    if |rs| == 0 {
      assert (rs + [r])[0] == r && (rs + [r])[1..] == [];
      if c.Some? {
        assert c == LocalContent(l);
        assert ChainSaved(saved, d, r.content, r.deleted, y, [], y, None);
      } else {
        assert ChainSaved(saved, d, r.content, r.deleted, y, [], y, c);
      }
    } else {
      var z := var z :| LinkSaved(saved, d, b, bd, l, rs[0], z)
        && (ChainSaved(saved, d, rs[0].content, rs[0].deleted, z, rs[1..], x, c)
            || (c.Some? && c == LocalContent(l) && ChainSaved(saved, d, rs[0].content, rs[0].deleted, z, rs[1..], x, None))); z;
      assert (rs + [r])[0] == rs[0] && (rs + [r])[1..] == rs[1..] + [r];
      assert ChainBase(rs[0].content, rs[1..]) == ChainBase(b, rs);
      assert ChainBaseDeleted(rs[0].deleted, rs[1..]) == ChainBaseDeleted(bd, rs);
      if ChainSaved(saved, d, rs[0].content, rs[0].deleted, z, rs[1..], x, c) {
        ChainSavedSnoc(saved, d, rs[0].content, rs[0].deleted, z, rs[1..], x, c, r, y);
      } else {
        ChainSavedSnoc(saved, d, rs[0].content, rs[0].deleted, z, rs[1..], x, None, r, y);
      }
    }
  }

  // The local side a chain leaves is one of its contents.
  lemma ChainSavedReaches(saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>, rs: seq<Revision>,
                          x: Option<(Hash, Kind)>)
    requires ChainSaved(saved, d, b, bd, l, rs, x, None) && x.Some?
    ensures ChainSaved(saved, d, b, bd, l, rs, x, Some(x.value.0))
    decreases |rs|, if l.Some? then 1 else 0
  {
    if l.Some? && l.value.0 in saved && ChainSaved(saved, d, b, bd, None, rs, x, None) {
      ChainSavedReaches(saved, d, b, bd, None, rs, x);
      return;
    }
    if |rs| > 0 {
      var y := var y :| LinkSaved(saved, d, b, bd, l, rs[0], y)
        && ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None); y;
      ChainSavedReaches(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x);
    }
  }

  lemma ChainSavedGrows(saved: set<Hash>, saved': set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>,
                        rs: seq<Revision>, x: Option<(Hash, Kind)>, c: Option<Hash>)
    requires ChainSaved(saved, d, b, bd, l, rs, x, c) && saved <= saved'
    ensures ChainSaved(saved', d, b, bd, l, rs, x, c)
    decreases |rs|, if l.Some? then 1 else 0
  {
    var lg := if c == LocalContent(l) then None else c;
    if l.Some? && l.value.0 in saved && ChainSaved(saved, d, b, bd, None, rs, x, lg) {
      ChainSavedGrows(saved, saved', d, b, bd, None, rs, x, lg);
      return;
    }
    if |rs| > 0 {
      var y := var y :| LinkSaved(saved, d, b, bd, l, rs[0], y)
        && (ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c)
            || (c.Some? && c == LocalContent(l) && ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None))); y;
      LinkSavedGrows(saved, saved', d, b, bd, l, rs[0], y);
      if ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c) {
        ChainSavedGrows(saved, saved', d, rs[0].content, rs[0].deleted, y, rs[1..], x, c);
      } else {
        ChainSavedGrows(saved, saved', d, rs[0].content, rs[0].deleted, y, rs[1..], x, None);
      }
    }
  }

  // At the end of the round: a chain whose saved contents are saved next to
  // it on the device the round leaves, and whose local side is what the
  // document sends, is RoundChain's ChainThrough.
  lemma ChainSavedIsThrough(post: State, saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>,
                            rs: seq<Revision>, x: Option<(Hash, Kind)>, c: Option<Hash>)
    requires ChainSaved(saved, d, b, bd, l, rs, x, c)
    requires forall h :: h in saved ==> SavedInRound(post, d, h)
    ensures ChainThrough(post, d, b, bd, l, rs, LocalContent(x), c)
    decreases |rs|, if l.Some? then 1 else 0
  {
    var lg := if c == LocalContent(l) then None else c;
    if l.Some? && l.value.0 in saved && ChainSaved(saved, d, b, bd, None, rs, x, lg) {
      ChainSavedIsThrough(post, saved, d, b, bd, None, rs, x, lg);
      return;
    }
    if |rs| > 0 {
      var y := var y :| LinkSaved(saved, d, b, bd, l, rs[0], y)
        && (ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c)
            || (c.Some? && c == LocalContent(l) && ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None))); y;
      LinkSavedIsLink(post, saved, d, b, bd, l, rs[0], y);
      if ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c) {
        ChainSavedIsThrough(post, saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c);
      } else {
        ChainSavedIsThrough(post, saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None);
      }
    }
  }

  // ---------------------------------------------------------------------
  // One link: the apply of one revision
  // ---------------------------------------------------------------------

  // The contents a step's effects save next to a document: its conflict
  // copies (writes for no document).
  ghost function SavedBy(effects: seq<Effect>): set<Hash> {
    set i | 0 <= i < |effects| && effects[i].Write? && effects[i].target.None? :: effects[i].content
  }



  // A create that moves the one untracked file in the way aside lists the
  // head at its name.
  lemma {:isolate_assertions} CreateMoveAsideReads(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput,
                                                   bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    requires |Create(platform, doc, document, r, input, bound, claims, rev).effects| == 2
    ensures var applied := Create(platform, doc, document, r, input, bound, claims, rev);
      var listing' := ListingAfter(platform, input.listing, applied.effects);
      Distinct(platform, listing') ==>
        applied.document.binding == Some(Binding(r.path, r.content, false, None))
        && ListedRead(platform, listing', r.path) == Some((r.content, r.kind))
  {
    var applied := Create(platform, doc, document, r, input, bound, claims, rev);
    var listing' := ListingAfter(platform, input.listing, applied.effects);
    if !Distinct(platform, listing') { return; }
    var held := Colliders(platform, input.listing, r.path);
    var q := LeastPath(held);
    var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, q, r.path).value;
    assert applied.effects == [Move(None, q, copy, input.listing[q].0), Write(Some(doc), r.path, r.content, r.kind, None)];
    ListingAfterTwo(platform, input.listing, applied.effects[0], applied.effects[1]);
    var mid := ListingAfterEffect(platform, input.listing, applied.effects[0]);
    assert q in held;
    SameFIsEquivalence(platform, q, q, q);
    assert Listed(platform, input.listing, q);
    assert ListedAt(platform, input.listing, q) == q by {
      var k := ListedAt(platform, input.listing, q);
      if k != q { assert SameF(platform, k, q); assert false; }
    }
    assert mid == (input.listing - {q})[copy := input.listing[q]];
    if Listed(platform, mid, r.path) {
      var k := ListedAt(platform, mid, r.path);
      if k == copy { assert CollideF(platform, copy, r.path); assert false; }
      assert k in input.listing && k != q;
      assert CollideF(platform, k, r.path);
      assert k in held - {q};
      assert |held - {q}| == |held| - 1 == 0;
      assert false;
    }
    WriteReads(platform, mid, applied.effects[1]);
  }

  // A write lists its content and kind at its name.
  lemma WriteReads(platform: Platform, listing: Listing, effect: Effect)
    requires effect.Write? && Distinct(platform, listing) && Distinct(platform, ListingAfterEffect(platform, listing, effect))
    requires (effect.precondition.Some? && Listed(platform, listing, effect.path))
             || (effect.precondition.None? && !Listed(platform, listing, effect.path))
    ensures ListedRead(platform, ListingAfterEffect(platform, listing, effect), effect.path) == Some((effect.content, effect.kind))
  {
    var after := ListingAfterEffect(platform, listing, effect);
    if Listed(platform, listing, effect.path) {
      var k := ListedAt(platform, listing, effect.path);
      assert k in after && SameF(platform, k, effect.path);
      assert Listed(platform, after, effect.path);
      var k' := ListedAt(platform, after, effect.path);
      if k' != k { SameFIsEquivalence(platform, k', effect.path, k); assert false; }
    } else {
      SameFIsEquivalence(platform, effect.path, effect.path, effect.path);
      assert effect.path in after;
      var k' := ListedAt(platform, after, effect.path);
      if k' != effect.path { SameFIsEquivalence(platform, k', effect.path, effect.path); assert false; }
    }
  }

  // After moves of distinct listed files to free, apart names, a listed
  // name is one moved to, or one that was listed and did not move.
  lemma MovesKeys(platform: Platform, listing: Listing, front: seq<Effect>)
    requires Distinct(platform, listing) && Distinct(platform, ListingAfter(platform, listing, front))
    requires forall i | 0 <= i < |front| :: front[i].Move? && front[i].from in listing && FreeIn(platform, listing, front[i].to)
    requires forall i, j | 0 <= i < j < |front| :: front[i].from != front[j].from && !CollideF(platform, front[i].to, front[j].to)
    ensures forall k | k in ListingAfter(platform, listing, front) ::
      (exists i | 0 <= i < |front| :: k == front[i].to) || (k in listing && forall i | 0 <= i < |front| :: k != front[i].from)
    decreases |front|
  {
    if |front| == 0 { return; }
    var m := front[0];
    var mid := ListingAfterEffect(platform, listing, m);
    if !Distinct(platform, mid) { ListingAfterFrozen(platform, mid, front[1..]); assert false; }
    SameFIsEquivalence(platform, m.from, m.from, m.from);
    assert Listed(platform, listing, m.from);
    assert ListedAt(platform, listing, m.from) == m.from by {
      var k := ListedAt(platform, listing, m.from);
      if k != m.from { assert false; }
    }
    assert mid == (listing - {m.from})[m.to := listing[m.from]];
    var rest := front[1..];
    forall i | 0 <= i < |rest| ensures rest[i].Move? && rest[i].from in mid && FreeIn(platform, mid, rest[i].to) {
      assert rest[i] == front[i + 1];
      forall q | q in mid ensures !CollideF(platform, q, rest[i].to) {
        if q == m.to { assert !CollideF(platform, front[0].to, front[i + 1].to); }
      }
    }
    forall i, j | 0 <= i < j < |rest| ensures rest[i].from != rest[j].from && !CollideF(platform, rest[i].to, rest[j].to) {
      assert rest[i] == front[i + 1] && rest[j] == front[j + 1];
    }
    MovesKeys(platform, mid, rest);
    forall k | k in ListingAfter(platform, listing, front)
      ensures (exists i | 0 <= i < |front| :: k == front[i].to) || (k in listing && forall i | 0 <= i < |front| :: k != front[i].from)
    {
      if exists i | 0 <= i < |rest| :: k == rest[i].to {
        var i := var i :| 0 <= i < |rest| && k == rest[i].to; i;
        assert k == front[i + 1].to;
      } else if k == m.to {
        assert k == front[0].to;
      } else {
        assert k in listing && k != m.from;
        forall i | 0 <= i < |front| ensures k != front[i].from {
          if i > 0 { assert front[i] == rest[i - 1]; }
        }
      }
    }
  }

  // After the moves aside, the only listed name in the way of the head is
  // the document's own file.
  lemma WayCleared(platform: Platform, listing: Listing, front: seq<Effect>, moves: seq<(Path, Path, Hash)>, keep: Option<Path>,
                   wanted: Path, k: Path)
    requires Distinct(platform, listing) && Distinct(platform, ListingAfter(platform, listing, front))
    requires |front| == |moves|
    requires forall i | 0 <= i < |front| :: front[i].Move? && front[i].from == moves[i].0 && front[i].to == moves[i].1
    requires forall i | 0 <= i < |moves| :: moves[i].0 in listing && FreeIn(platform, listing, moves[i].1) && !CollideF(platform, moves[i].1, wanted)
    requires forall i, j | 0 <= i < j < |moves| :: moves[i].0 != moves[j].0 && !CollideF(platform, moves[i].1, moves[j].1)
    requires forall q | q in InTheWay(platform, listing, wanted, keep) :: exists i | 0 <= i < |moves| :: moves[i].0 == q
    requires k in ListingAfter(platform, listing, front) && CollideF(platform, k, wanted)
    ensures keep == Some(k) && k in listing
  {
    MovesKeys(platform, listing, front);
    if exists i | 0 <= i < |front| :: k == front[i].to {
      var i := var i :| 0 <= i < |front| && k == front[i].to; i;
      assert false;
    }
    assert k in listing;
    if keep != Some(k) {
      InTheWayHas(platform, listing, wanted, keep, k);
      var i := var i :| 0 <= i < |moves| && moves[i].0 == k; i;
      assert front[i].from == k;
      assert false;
    }
  }

  // The arrival's removal of the document's own file in the way leaves
  // nothing listed in the head's way.
  lemma {:isolate_assertions} CollideCleared(platform: Platform, listing: Listing, front: seq<Effect>, moves: seq<(Path, Path, Hash)>, keep: Option<Path>,
                       wanted: Path, mid: Listing, before: Listing, k: Path, spelling: Path, avoid: set<Path>, doc: DocId, seen: Hash)
    requires Distinct(platform, listing) && mid == ListingAfter(platform, listing, front) && Distinct(platform, mid)
    requires |front| == |moves|
    requires forall i | 0 <= i < |front| :: front[i].Move? && front[i].from == moves[i].0 && front[i].to == moves[i].1
    requires forall i | 0 <= i < |moves| :: (moves[i].0 in listing && FreeIn(platform, listing, moves[i].1) && !CollideF(platform, moves[i].1, wanted)
                                              && (forall t | t in avoid :: !SameF(platform, t, moves[i].1)))
    requires forall i, j | 0 <= i < j < |moves| :: moves[i].0 != moves[j].0 && !CollideF(platform, moves[i].1, moves[j].1)
    requires forall q | q in InTheWay(platform, listing, wanted, keep) :: exists i | 0 <= i < |moves| :: moves[i].0 == q
    requires keep.Some? && keep.value in listing && SameF(platform, keep.value, spelling) && spelling in avoid
    requires forall i | 0 <= i < |moves| :: moves[i].0 != keep.value
    requires before == ListingAfterEffect(platform, mid, Remove(doc, keep.value, seen))
    requires k in before && CollideF(platform, k, wanted)
    ensures false
  {
    var own := keep.value;
    var rm := Remove(doc, own, seen);
    assert k in mid by {
      if Listed(platform, mid, own) { assert before == mid - {ListedAt(platform, mid, own)}; } else { assert before == mid; }
    }
    WayCleared(platform, listing, front, moves, keep, wanted, k);
    assert k == own;
    forall effect | effect in front ensures !Touches(platform, effect, own) {
      var i := var i :| 0 <= i < |front| && front[i] == effect; i;
      assert moves[i].0 != own;
      if SameF(platform, moves[i].1, own) {
        SameFIsEquivalence(platform, moves[i].1, own, spelling);
        assert false;
      }
    }
    ListingAfterUntouched(platform, listing, front, own);
    SameFIsEquivalence(platform, own, own, own);
    assert Listed(platform, listing, own);
    assert Listed(platform, mid, own);
    var q := ListedAt(platform, mid, own);
    assert before == mid - {q};
    assert k != q;
    MovesKeys(platform, listing, front);
    if exists i | 0 <= i < |front| :: q == front[i].to {
      var i := var i :| 0 <= i < |front| && q == front[i].to; i;
      SameFIsEquivalence(platform, q, own, own);
      assert CollideF(platform, own, front[i].to);
      assert false;
    }
    assert q in listing;
    assert q == own;
  }

  // A move lists what it moved at its new name.
  lemma MoveReads(platform: Platform, listing: Listing, effect: Effect)
    requires effect.Move? && Distinct(platform, listing) && Distinct(platform, ListingAfterEffect(platform, listing, effect))
    requires Listed(platform, listing, effect.from)
    ensures ListedRead(platform, ListingAfterEffect(platform, listing, effect), effect.to) == ListedRead(platform, listing, effect.from)
  {
    var after := ListingAfterEffect(platform, listing, effect);
    var q := ListedAt(platform, listing, effect.from);
    SameFIsEquivalence(platform, effect.to, effect.to, effect.to);
    assert effect.to in after && after[effect.to] == listing[q];
    var k' := ListedAt(platform, after, effect.to);
    if k' != effect.to { SameFIsEquivalence(platform, k', effect.to, effect.to); assert false; }
  }

  // Where the rule clears the way, the head's name reads the arriving
  // content: written or created there, or the document's own file moved
  // there as the round read it, where it already held that content.
  lemma {:isolate_assertions} ClearWayHeadReads(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      var a := Arriving(platform, documents[doc], r, input);
      var keep := Keeps(platform, documents[doc], r, input);
      doc in ruled.documents && Distinct(platform, listing') && ruled.documents[doc].ahead.None? ==>
        ListedRead(platform, listing', r.path) == Some((a.content, a.kind))
        || (keep.Some? && documents[doc].binding.Some?
            && a.content == ArrivingRow(platform, documents[doc], r, input).binding.value.seen
            && ListedRead(platform, listing', r.path) == ListedRead(platform, input.listing, documents[doc].binding.value.spelling))
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert ruled.documents[doc].ahead.Some?;
      return;
    }
    if !Distinct(platform, listing') { return; }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    ListingAfterAppend(platform, input.listing, front, arrive);
    var mid := ListingAfter(platform, input.listing, front);
    if !Distinct(platform, mid) { ListingAfterFrozen(platform, mid, arrive); assert false; }
    var row := ArrivingRow(platform, document, r, input);
    var a := Arriving(platform, document, r, input);
    if keep.Some? && row.binding.Some? && !(CollideF(platform, keep.value, r.path) && !SameF(platform, keep.value, r.path)) {
      var own := keep.value;
      var spelling := document.binding.value.spelling;
      var seen := row.binding.value.seen;
      assert own in input.listing && SameF(platform, own, spelling);
      assert spelling in avoid;
      forall effect | effect in front ensures !Touches(platform, effect, own) {
        var i := var i :| 0 <= i < |front| && front[i] == effect; i;
        assert moves[i].0 in way && moves[i].0 != own;
        if SameF(platform, moves[i].1, own) {
          SameFIsEquivalence(platform, moves[i].1, own, spelling);
          assert false;
        }
      }
      ListingAfterUntouched(platform, input.listing, front, own);
      SameFIsEquivalence(platform, own, own, own);
      assert Listed(platform, input.listing, own);
      assert ListedRead(platform, input.listing, own) == ListedRead(platform, input.listing, spelling) by {
        SameFIsEquivalence(platform, own, spelling, own);
        assert ListedAt(platform, input.listing, own) == ListedAt(platform, input.listing, spelling);
      }
      var mv := Move(Some(doc), own, r.path, a.content);
      if a.content == seen {
        assert arrive == [mv];
        ListingAfterOne(platform, mid, mv);
        MoveReads(platform, mid, mv);
      } else {
        var w := Write(Some(doc), own, a.content, a.kind, Some(seen));
        assert arrive == [w, mv];
        ListingAfterTwo(platform, mid, w, mv);
        var mid2 := ListingAfterEffect(platform, mid, w);
        if !Distinct(platform, mid2) { assert ListingAfterEffect(platform, mid2, mv) == mid2; assert false; }
        WriteReads(platform, mid, w);
        ListingEffectKeepsListed(platform, mid, w, own);
        MoveReads(platform, mid2, mv);
      }
    } else {
      var init := arrive[..|arrive| - 1];
      var last := arrive[|arrive| - 1];
      assert arrive == init + [last];
      assert last == Write(Some(doc), r.path, a.content, a.kind, None);
      ListingAfterSnoc(platform, mid, init, last);
      var before := ListingAfter(platform, mid, init);
      if !Distinct(platform, before) { assert ListingAfterEffect(platform, before, last) == before; assert false; }
      if Listed(platform, before, r.path) {
        // Nothing is left in the head's way: the moves and the arrival's
        // removal cleared it.
        AsideCovers(platform, input.listing, avoid, AllClaims(documents), way, r.path);
        forall i | 0 <= i < |front| ensures front[i].Move? && front[i].from in input.listing && FreeIn(platform, input.listing, front[i].to) {
          assert moves[i].0 in way;
        }
        var k := ListedAt(platform, before, r.path);
        assert CollideF(platform, k, r.path);
        assert forall q | q in way :: exists i | 0 <= i < |moves| :: moves[i].0 == q;
        if init == [] {
          assert before == mid && k in mid;
          WayCleared(platform, input.listing, front, moves, keep, r.path, k);
          assert keep.Some? && row.binding.Some?;
          assert false;
        } else {
          assert keep.Some? && row.binding.Some? && CollideF(platform, keep.value, r.path) && !SameF(platform, keep.value, r.path);
          var rm := Remove(doc, keep.value, row.binding.value.seen);
          assert init == [rm];
          ListingAfterOne(platform, mid, rm);
          assert keep.value in input.listing && SameF(platform, keep.value, document.binding.value.spelling);
          assert document.binding.value.spelling in avoid;
          forall i | 0 <= i < |moves| ensures moves[i].0 != keep.value { assert moves[i].0 in way; }
          CollideCleared(platform, input.listing, front, moves, keep, r.path, mid, before, k, document.binding.value.spelling, avoid, doc, row.binding.value.seen);
        }
      }
      WriteReads(platform, before, last);
    }
  }

  // A row's local side in a listing: the content and kind the listing
  // reads at its bound file, or none.
  function LocalSide(platform: Platform, listing: Listing, row: Document): Option<(Hash, Kind)>
    requires ListingDistinct(platform, listing)
  {
    if row.binding.Some? then ListedRead(platform, listing, row.binding.value.spelling) else None
  }

  // The apply settles a revision of a row with a base as a link of the
  // row's chain, or leaves its base as it was (it holds, or the revision
  // is not newer).
  lemma {:isolate_assertions} ApplyLink(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput,
                                        bound: set<Path>, claims: Claims, rev: RevId, d: DeviceId)
    requires ListingDistinct(platform, input.listing)
    requires document.base.Some? && PulledBy(document, r, d)
    // A base is the revision it names (the pass's accepted facts give it).
    requires document.base.value.rev == r.id ==> document.base == Some(BaseOf(r))
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      var listing' := ListingAfter(platform, input.listing, applied.effects);
      Distinct(platform, listing') ==>
        applied.document.base == document.base
        || (applied.document.base == Some(BaseOf(r))
            && LinkSaved(SavedBy(applied.effects), d, document.base.value.content, document.base.value.deleted,
                         LocalSide(platform, input.listing, document), r, LocalSide(platform, listing', applied.document)))
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    var listing' := ListingAfter(platform, input.listing, applied.effects);
    if !Distinct(platform, listing') || applied.document.base == document.base { return; }
    var b := document.base.value.content;
    var bd := document.base.value.deleted;
    var l := LocalSide(platform, input.listing, document);
    var x := LocalSide(platform, listing', applied.document);
    var saved := SavedBy(applied.effects);
    assert Newer(document, r);
    if SettlesIdentical(platform, document, r, input) {
      assert applied.effects == [] && listing' == input.listing;
      assert x == l;
      return;
    }
    if Acknowledges(document, r) {
      assert applied.effects == [] && listing' == input.listing;
      assert x == l;
      return;
    }
    assert r.device != d;
    if Revives(platform, document, r, input) {
      assert l.None?;
      assert !KeepsUntracked(platform, document, r, input);
      assert applied == Create(platform, doc, Revived(document), r, input, bound, claims, rev);
      if |applied.effects| == 1 {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        WriteReads(platform, input.listing, applied.effects[0]);
      } else if |applied.effects| == 2 {
        CreateMoveAsideReads(platform, doc, Revived(document), r, input, bound, claims, rev);
      } else {
        assert applied.effects == [] && listing' == input.listing;
        SameFIsEquivalence(platform, r.path, r.path, r.path);
        assert x == Some((r.content, r.kind));
      }
      return;
    }
    if document.binding.None? {
      assert l.None?;
      if r.deleted {
        assert applied.effects == [] && applied.document.binding.None?;
        return;
      }
      assert applied == Create(platform, doc, document, r, input, bound, claims, rev);
      if |applied.effects| == 1 {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        WriteReads(platform, input.listing, applied.effects[0]);
      } else if |applied.effects| == 2 {
        CreateMoveAsideReads(platform, doc, document, r, input, bound, claims, rev);
      } else {
        assert applied.effects == [] && listing' == input.listing;
        SameFIsEquivalence(platform, r.path, r.path, r.path);
        assert x == Some((r.content, r.kind));
      }
      return;
    }
    var spelling := document.binding.value.spelling;
    var read := ListedRead(platform, input.listing, spelling);
    assert l == read;
    if r.deleted && read.None? {
      assert x.None?;
      return;
    }
    if Concurrent(document, read, r) {
      assert applied == Settle(platform, doc, document, read.value, r, input, bound, claims, rev);
      var lc := read.value.0;
      if lc == b && lc == document.binding.value.seen {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        WriteReads(platform, input.listing, applied.effects[0]);
        assert x == Some((r.content, r.kind));
      } else if r.content == b {
        assert applied.effects == [] && listing' == input.listing;
        assert x == l;
      } else if lc != b && read.value.1 == Note && r.kind == Note && Merge(b, lc, r.content).Some? {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        WriteReads(platform, input.listing, applied.effects[0]);
        assert x == Some((Merge(b, lc, r.content).value, Note));
      } else {
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, spelling, spelling).value;
        assert applied.effects == [Write(None, copy, lc, read.value.1, None), Write(Some(doc), spelling, r.content, r.kind, Some(lc))];
        ListingAfterTwo(platform, input.listing, applied.effects[0], applied.effects[1]);
        var mid := ListingAfterEffect(platform, input.listing, applied.effects[0]);
        if Listed(platform, input.listing, copy) {
          var q := ListedAt(platform, input.listing, copy);
          assert CollideF(platform, q, copy);
          assert false;
        }
        var k := ListedAt(platform, input.listing, spelling);
        assert k in mid;
        assert Listed(platform, mid, spelling);
        WriteReads(platform, mid, applied.effects[1]);
        assert x == Some((r.content, r.kind));
        assert lc in saved by { assert applied.effects[0].Write? && applied.effects[0].target.None?; }
      }
      assert LinkSaved(saved, d, b, bd, l, r, x);
      return;
    }
    if EditedAgainstDelete(document, read, r) {
      assert applied.effects == [] && listing' == input.listing;
      assert x == l;
      return;
    }
    if MovedAgainstChange(document, read, r) { return; }
    if !Clean(platform, document, read) && !r.deleted && read.Some? && document.base.value.rev == r.id {
      assert applied.effects == [] && listing' == input.listing;
      assert x == l;
      return;
    }
    if !Clean(platform, document, read) { return; }
    if r.deleted {
      assert applied.document.binding.None?;
      return;
    }
    if r.path == spelling {
      ListingAfterOne(platform, input.listing, applied.effects[0]);
      WriteReads(platform, input.listing, applied.effects[0]);
      assert x == Some((r.content, r.kind));
      return;
    }
  }
  // The content a remote move against a local change keeps apart: the
  // file read stays as an untracked copy (MovedContent is None).
  ghost function KeptApart(platform: Platform, document: Document, r: Revision, input: RoundInput): set<Hash>
    requires ListingDistinct(platform, input.listing)
  {
    var read := MoveRead(platform, document, r, input);
    if read.Some? && MovedContent(document, read.value, r).None? then {read.value.0} else {}
  }

  // A revision held for its name, of a row whose file the listing reads,
  // that is no remote move against a local change: the file is what the
  // base holds and what the row last saw, or the revision is the base's.
  lemma {:isolate_assertions} HeldClean(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput,
                                        bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    requires document.base.Some? && document.binding.Some?
    requires HeldForName(document, ApplyRevision(platform, doc, document, r, input, bound, claims, rev), r)
    requires !r.deleted && !Revives(platform, document, r, input) && MoveRead(platform, document, r, input).None?
    ensures var read := ListedRead(platform, input.listing, document.binding.value.spelling);
      read.Some? && read.value.0 == document.binding.value.seen
      && (read.value.0 == document.base.value.content || document.base.value.rev == r.id)
  {
    var read := ListedRead(platform, input.listing, document.binding.value.spelling);
    assert !MovedAgainstChange(document, read, r);
    assert Newer(document, r) && !Acknowledges(document, r) && !SettlesIdentical(platform, document, r, input);
    assert !UnsavedAt(platform, input.unsaved, document.binding.value.spelling);
    assert !Concurrent(document, read, r);
  }

  // Where the rule clears the way, the head's row settles the revision as
  // a link of its chain.
  lemma {:isolate_assertions} ClearWayHeadLink(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                               revs: FreshRevs, first: Claims, d: DeviceId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires documents[doc].base.Some? && PulledBy(documents[doc], r, d)
    requires documents[doc].base.value.rev == r.id ==> documents[doc].base == Some(BaseOf(r))
    requires HeldForName(documents[doc], ApplyRevision(platform, doc, documents[doc], r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]), r)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      var document := documents[doc];
      doc in ruled.documents && Distinct(platform, listing') && ruled.documents[doc].ahead.None? ==>
            ruled.documents[doc].base == document.base
            || (ruled.documents[doc].base == Some(BaseOf(r))
                && LinkSaved(SavedBy(ruled.effects) + KeptApart(platform, document, r, input), d,
                             document.base.value.content, document.base.value.deleted,
                             LocalSide(platform, input.listing, document), r, LocalSide(platform, listing', ruled.documents[doc])))
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !(doc in ruled.documents && Distinct(platform, listing') && ruled.documents[doc].ahead.None?) { return; }
    ClearWayHeadReads(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    assert aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value);
    var head := HeadRow(platform, document, r, input, revs[doc]);
    assert ruled.documents[doc] == head;
    var x := LocalSide(platform, listing', head);
    assert x == ListedRead(platform, listing', r.path);
    var l := LocalSide(platform, input.listing, document);
    var b := document.base.value.content;
    var bd := document.base.value.deleted;
    var saved := SavedBy(ruled.effects) + KeptApart(platform, document, r, input);
    var a := Arriving(platform, document, r, input);
    var row := ArrivingRow(platform, document, r, input);
    var read := MoveRead(platform, document, r, input);
    assert !Acknowledges(document, r);
    assert r.device != d;
    assert !r.deleted;
    if read.Some? {
      reveal Arriving();
      reveal ArrivingRow();
      reveal Keeps();
      MovedContentSettlesAsG6(document, read.value, r);
      assert l == read;
      if MovedContent(document, read.value, r).None? {
        assert read.value.0 in saved;
      }
      assert LinkSaved(saved, d, b, bd, l, r, x);
    } else if Revives(platform, document, r, input) || document.binding.None? {
      reveal Arriving();
      reveal Keeps();
      assert keep.None?;
      assert l.None?;
      assert x == Some((r.content, r.kind));
    } else {
      HeldClean(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
      if document.base.value.rev == r.id { return; }
      reveal Arriving();
      reveal ArrivingRow();
      assert a == r && row == document;
      assert LinkSaved(saved, d, b, bd, l, r, x);
    }
  }

  // The contents a rule's link saves: the apply's conflict copies, or the
  // local version a remote move against a local change keeps apart.
  ghost function RuleSaved(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                           revs: FreshRevs, first: Claims): set<Hash>
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if !HeldForName(document, applied, r) then SavedBy(applied.effects)
    else if UnsavedCollides(platform, input.unsaved, r.path) then {}
    else KeptApart(platform, document, r, input)
  }

  // The rule settles a revision of a row with a base as a link of the
  // row's chain, or leaves its base as it was.
  lemma {:isolate_assertions} RuleLink(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                       revs: FreshRevs, first: Claims, d: DeviceId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires documents[doc].base.Some? && PulledBy(documents[doc], r, d)
    requires documents[doc].base.value.rev == r.id ==> documents[doc].base == Some(BaseOf(r))
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      var document := documents[doc];
      doc in ruled.documents
      && (Distinct(platform, listing') ==>
            ruled.documents[doc].base == document.base
            || (ruled.documents[doc].base == Some(BaseOf(r))
                && LinkSaved(RuleSaved(platform, documents, doc, r, input, revs, first), d,
                             document.base.value.content, document.base.value.deleted,
                             LocalSide(platform, input.listing, document), r, LocalSide(platform, listing', ruled.documents[doc]))))
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    var saved := RuleSaved(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      assert ruled.documents[doc] == applied.document && ruled.effects == applied.effects;
      ApplyLink(platform, doc, document, r, input, bound, claims, revs[doc], d);
      assert saved == SavedBy(ruled.effects);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) {
      assert ruled.documents[doc].base == document.base;
      return;
    }
    assert ruled == ClearWay(platform, documents, doc, r, input, revs);
    if ruled.documents[doc].ahead.Some? {
      // Deferred: the base stays.
      assert ruled.documents[doc].base == document.base;
      return;
    }
    ClearWayHeadLink(platform, documents, doc, r, input, revs, first, d);
    ClearWayWritesNoCopy(platform, documents, doc, r, input, revs);
    assert SavedBy(ruled.effects) == {} by {
      forall h | h in SavedBy(ruled.effects) ensures false {
        var i := var i :| 0 <= i < |ruled.effects| && ruled.effects[i].Write? && ruled.effects[i].target.None? && ruled.effects[i].content == h; i;
        assert ruled.effects[i] in ruled.effects;
      }
    }
    assert saved == SavedBy(ruled.effects) + KeptApart(platform, document, r, input);
  }
  // ---------------------------------------------------------------------
  // The other rows: their bases stay
  // ---------------------------------------------------------------------

  lemma MoveRowsKeepBases(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs)
    requires documents.Keys <= revs.Keys
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      rows.Keys == documents.Keys && forall e | e in rows :: rows[e].base == documents[e].base
    decreases |moves|
  {
    if moves != [] { MoveRowsKeepBases(platform, documents, doc, moves[1..], revs); }
  }

  // The rule changes no other row's base.
  lemma RuleKeepsOtherBases(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                            revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      ruled.documents.Keys == documents.Keys
      && forall e | e in documents && e != doc :: ruled.documents[e].base == documents[e].base
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        MoveRowsKeepBases(platform, documents, doc, aside.value, revs);
      }
    }
  }
  // ---------------------------------------------------------------------
  // The other rows: their local sides stay
  // ---------------------------------------------------------------------

  lemma ListedReadSameF(platform: Platform, listing: Listing, p: Path, q: Path)
    requires Distinct(platform, listing) && SameF(platform, p, q)
    ensures ListedRead(platform, listing, p) == ListedRead(platform, listing, q)
  {
    SameFIsEquivalence(platform, p, q, q);
    if Listed(platform, listing, p) {
      var k := ListedAt(platform, listing, p);
      SameFIsEquivalence(platform, k, p, q);
      assert Listed(platform, listing, q);
      var k' := ListedAt(platform, listing, q);
      if k != k' { SameFIsEquivalence(platform, k', q, p); SameFIsEquivalence(platform, k, p, k'); assert false; }
    } else if Listed(platform, listing, q) {
      var k' := ListedAt(platform, listing, q);
      SameFIsEquivalence(platform, k', q, p);
      assert false;
    }
  }

  // A row's file moved aside under W(a) holds at its new name what the
  // round read at its old one.
  lemma {:isolate_assertions} MovedKeepsRead(platform: Platform, listing: Listing, effects: seq<Effect>, moves: seq<(Path, Path, Hash)>,
                                             m: nat, s: Path)
    requires Distinct(platform, listing) && Distinct(platform, ListingAfter(platform, listing, effects))
    requires m < |moves| && |moves| <= |effects|
    requires forall i | 0 <= i < |moves| :: effects[i].Move? && effects[i].from == moves[i].0 && effects[i].to == moves[i].1
    requires forall i | 0 <= i < |moves| :: moves[i].0 in listing && FreeIn(platform, listing, moves[i].1)
    requires forall i, j | 0 <= i < j < |moves| :: moves[i].0 != moves[j].0
    requires SameF(platform, moves[m].1, s)
    requires forall k | m < k < |effects| :: !Touches(platform, effects[k], s)
    ensures ListedRead(platform, ListingAfter(platform, listing, effects), s) == ListedRead(platform, listing, moves[m].0)
  {
    var before := effects[..m];
    var tail := effects[m + 1..];
    assert effects == before + [effects[m]] + tail;
    ListingAfterAppend(platform, listing, before + [effects[m]], tail);
    ListingAfterSnoc(platform, listing, before, effects[m]);
    var l1 := ListingAfter(platform, listing, before);
    var l2 := ListingAfterEffect(platform, l1, effects[m]);
    assert ListingAfter(platform, listing, effects) == ListingAfter(platform, l2, tail);
    if !Distinct(platform, l2) { ListingAfterFrozen(platform, l2, tail); assert false; }
    if !Distinct(platform, l1) { assert l2 == l1; assert false; }
    var from := moves[m].0;
    forall effect | effect in before ensures !Touches(platform, effect, from) {
      var j := var j :| 0 <= j < |before| && before[j] == effect; j;
      assert effects[j] == effect;
      assert moves[j].0 != from && moves[j].0 in listing;
      assert !SameF(platform, moves[j].0, from);
      assert !CollideF(platform, from, moves[j].1);
      if SameF(platform, moves[j].1, from) { SameFIsEquivalence(platform, moves[j].1, from, from); assert false; }
    }
    ListingAfterUntouched(platform, listing, before, from);
    SameFIsEquivalence(platform, from, from, from);
    assert Listed(platform, listing, from);
    assert ListedRead(platform, l1, from) == ListedRead(platform, listing, from);
    MoveReads(platform, l1, effects[m]);
    forall effect | effect in tail ensures !Touches(platform, effect, s) {
      var k := var k :| 0 <= k < |tail| && tail[k] == effect; k;
      assert effects[m + 1 + k] == effect;
    }
    ListingAfterUntouched(platform, l2, tail, s);
    SameFIsEquivalence(platform, moves[m].1, s, s);
    assert Listed(platform, l2, s);
    ListedReadSameF(platform, l2, moves[m].1, s);
  }
  // The rule keeps every row.
  lemma ClearWayKeys(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures ClearWay(platform, documents, doc, r, input, revs).documents.Keys == documents.Keys
  {
    var document := documents[doc];
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      MoveRowsKeepBases(platform, documents, doc, aside.value, revs);
    }
  }

  // Where the rule clears the way, another row still bound reads what it
  // read: at its name, untouched, or moved aside under W(a).
  lemma {:isolate_assertions} ClearWayOtherSide(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                                revs: FreshRevs, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e != doc
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      e in ruled.documents
      && (Distinct(platform, listing') && ruled.documents[e].binding.Some? ==>
            LocalSide(platform, listing', ruled.documents[e]) == LocalSide(platform, input.listing, documents[e]))
  {
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    ClearWayKeys(platform, documents, doc, r, input, revs);
    ClearWayOrigin(platform, documents, doc, r, input, revs, e);
    ClearWayPutsLast(platform, documents, doc, r, input, revs, e);
    var after := ruled.documents[e];
    if !(Distinct(platform, listing') && after.binding.Some?) { return; }
    var sp := after.binding.value.spelling;
    if exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, sp) {
      var document := documents[doc];
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        assert |ruled.effects| == 1 && ruled.effects[0].Report?;
        assert false;
      }
      var moves := aside.value;
      AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      MoveEffectsShape(platform, documents, doc, moves);
      var front := MoveEffects(platform, documents, doc, moves);
      var arrive := ArriveOf(platform, doc, document, r, input);
      assert ruled.effects == front + arrive;
      var m := var m :| 0 <= m < |ruled.effects|
          && ((ruled.effects[m].Write? && ruled.effects[m].target == Some(e) && SameF(platform, ruled.effects[m].path, sp))
              || (ruled.effects[m].Move? && ruled.effects[m].mover == Some(e) && SameF(platform, ruled.effects[m].to, sp)))
          && forall k | m < k < |ruled.effects| :: !Touches(platform, ruled.effects[k], sp); m;
      ArriveFor(platform, doc, ArrivingRow(platform, document, r, input), Arriving(platform, document, r, input), keep);
      if m >= |front| {
        assert ruled.effects[m] in arrive;
        assert false;
      }
      assert ruled.effects[m] == front[m];
      MoveEffectsMoverOwns(platform, documents, doc, moves, m, e);
      forall i | 0 <= i < |moves| ensures moves[i].0 in input.listing { assert moves[i].0 in way; }
      MovedKeepsRead(platform, input.listing, ruled.effects, moves, m, sp);
      var t := documents[e].binding.value.spelling;
      ListedReadSameF(platform, input.listing, t, moves[m].0);
    } else {
      assert documents[e].binding.Some? && sp == documents[e].binding.value.spelling;
      ListingAfterUntouched(platform, input.listing, ruled.effects, sp);
    }
  }

  // The rule leaves another row still bound reading what it read.
  lemma {:isolate_assertions} RuleOtherSide(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                            revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e != doc
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      e in ruled.documents
      && (Distinct(platform, listing') && ruled.documents[e].binding.Some? ==>
            LocalSide(platform, listing', ruled.documents[e]) == LocalSide(platform, input.listing, documents[e]))
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      assert ruled.documents[e] == documents[e];
      if documents[e].binding.Some? {
        var t := documents[e].binding.value.spelling;
        assert t in bound;
        if document.binding.Some? && SameF(platform, document.binding.value.spelling, t) {
          assert false;
        }
        ApplyLeavesOthers(platform, doc, document, r, input, bound, claims, revs[doc], t);
        ListingAfterUntouched(platform, input.listing, ruled.effects, t);
      }
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      assert ruled.documents[e] == documents[e];
      ListingAfterOne(platform, input.listing, ruled.effects[0]);
    } else {
      ClearWayOtherSide(platform, documents, doc, r, input, revs, e);
    }
  }
  // The apply that leaves a row's base as it was (and does not pull the
  // base's own revision again) leaves its local side as it was, or unbound.
  lemma {:isolate_assertions} ApplyKeepsSide(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput,
                                             bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    requires document.base.Some? && document.base.value.rev != r.id
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      applied.document.base == document.base ==>
        (forall effect | effect in applied.effects :: effect.Report?) && (applied.document.binding == document.binding || applied.document.binding.None?
                                  || (document.binding.Some? && applied.document.binding.Some?
                                      && applied.document.binding.value.spelling == document.binding.value.spelling))
  {
    assert BaseOf(r).rev == r.id;
  }

  // Reports leave the listing as it is.
  lemma ListingAfterReports(platform: Platform, listing: Listing, effects: seq<Effect>)
    requires forall effect | effect in effects :: effect.Report?
    ensures ListingAfter(platform, listing, effects) == listing
    decreases |effects|
  {
    if |effects| > 0 {
      assert effects[0] in effects;
      assert ListingAfterEffect(platform, listing, effects[0]) == listing;
      ListingAfterReports(platform, listing, effects[1..]);
    }
  }

  // The rule that leaves the row's base as it was (and does not pull the
  // base's own revision again) leaves its local side as it was, or unbound.
  lemma {:isolate_assertions} RuleKeepsSide(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                            revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires documents[doc].base.Some? && documents[doc].base.value.rev != r.id
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      doc in ruled.documents
      && (Distinct(platform, listing') && ruled.documents[doc].base == documents[doc].base ==>
            LocalSide(platform, listing', ruled.documents[doc]) == LocalSide(platform, input.listing, documents[doc])
            || ruled.documents[doc].binding.None?)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    assert BaseOf(r).rev == r.id;
    if !HeldForName(document, applied, r) {
      ApplyKeepsSide(platform, doc, document, r, input, bound, claims, revs[doc]);
      if ruled.documents[doc].base == document.base { ListingAfterReports(platform, input.listing, ruled.effects); }
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      ApplyKeepsSide(platform, doc, document, r, input, bound, claims, revs[doc]);
      ListingAfterOne(platform, input.listing, ruled.effects[0]);
    } else {
      assert ruled == ClearWay(platform, documents, doc, r, input, revs);
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        assert ruled.documents[doc] == HeadRow(platform, document, r, input, revs[doc]);
      } else {
        assert ruled.documents[doc].binding == document.binding;
        ListingAfterOne(platform, input.listing, ruled.effects[0]);
      }
    }
  }
  // ---------------------------------------------------------------------
  // Saved contents: untracked files on the listing
  // ---------------------------------------------------------------------

  // The listing holds content `h` in a file no row is bound to.
  ghost predicate UntrackedHolds(platform: Platform, rows: map<DocId, Document>, listing: Listing, h: Hash) {
    exists p :: p in listing && listing[p].0 == h
      && forall e | e in rows && rows[e].binding.Some? :: !SameF(platform, rows[e].binding.value.spelling, p)
  }

  // The conflict copy a settle writes is an untracked file holding the
  // local version.
  lemma {:isolate_assertions} SettleCopyUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, read: (Hash, Kind),
                                                  r: Revision, input: RoundInput, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing) && doc in documents
    requires documents[doc].binding.Some? && documents[doc].base.Some?
    requires Listed(platform, input.listing, documents[doc].binding.value.spelling)
    ensures var applied := Settle(platform, doc, documents[doc], read, r, input, BoundNames(documents), claims, rev);
      var listing' := ListingAfter(platform, input.listing, applied.effects);
      Distinct(platform, listing') && applied.document.binding.Some?
      && applied.document.binding.value.spelling == documents[doc].binding.value.spelling ==>
        forall h | h in SavedBy(applied.effects) :: UntrackedHolds(platform, documents[doc := applied.document], listing', h)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var applied := Settle(platform, doc, document, read, r, input, bound, claims, rev);
    var listing' := ListingAfter(platform, input.listing, applied.effects);
    var spelling := document.binding.value.spelling;
    if !(Distinct(platform, listing') && applied.document.binding.Some? && applied.document.binding.value.spelling == spelling) { return; }
    if |applied.effects| != 2 {
      forall h | h in SavedBy(applied.effects) ensures false {
        var i := var i :| 0 <= i < |applied.effects| && applied.effects[i].Write? && applied.effects[i].target.None? && applied.effects[i].content == h; i;
      }
      return;
    }
    var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, spelling, spelling).value;
    var w0 := Write(None, copy, read.0, read.1, None);
    var w1 := Write(Some(doc), spelling, r.content, r.kind, Some(read.0));
    assert applied.effects == [w0, w1];
    ListingAfterTwo(platform, input.listing, w0, w1);
    var mid := ListingAfterEffect(platform, input.listing, w0);
    if !Distinct(platform, mid) { assert ListingAfterEffect(platform, mid, w1) == mid; assert false; }
    if Listed(platform, input.listing, copy) {
      var q := ListedAt(platform, input.listing, copy);
      assert CollideF(platform, q, copy);
      assert false;
    }
    assert mid == input.listing[copy := (read.0, read.1)];
    var k := ListedAt(platform, input.listing, spelling);
    assert k in mid && SameF(platform, k, spelling);
    assert Listed(platform, mid, spelling);
    var k' := ListedAt(platform, mid, spelling);
    if k' == copy {
      SameFIsEquivalence(platform, copy, spelling, spelling);
      assert spelling in bound;
      assert false;
    }
    assert listing' == mid[k' := (r.content, r.kind)];
    assert copy in listing' && listing'[copy].0 == read.0;
    var rows' := documents[doc := applied.document];
    forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, copy) {
      var t := rows'[e].binding.value.spelling;
      if e == doc { assert t == spelling; }
      assert t in bound;
    }
    forall h | h in SavedBy(applied.effects) ensures UntrackedHolds(platform, rows', listing', h) {
      var i := var i :| 0 <= i < |applied.effects| && applied.effects[i].Write? && applied.effects[i].target.None? && applied.effects[i].content == h; i;
      assert i == 0 && h == read.0;
    }
  }
  // The conflict copies the apply writes are untracked files holding what
  // they saved.
  lemma {:isolate_assertions} ApplyCopiesUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                   input: RoundInput, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing) && doc in documents
    ensures var applied := ApplyRevision(platform, doc, documents[doc], r, input, BoundNames(documents), claims, rev);
      var listing' := ListingAfter(platform, input.listing, applied.effects);
      Distinct(platform, listing') ==>
        forall h | h in SavedBy(applied.effects) :: UntrackedHolds(platform, documents[doc := applied.document], listing', h)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    if document.binding.Some? && document.base.Some? && Newer(document, r) && !SettlesIdentical(platform, document, r, input)
       && !Acknowledges(document, r) && !Revives(platform, document, r, input)
       && !UnsavedAt(platform, input.unsaved, document.binding.value.spelling) {
      var read := ListedRead(platform, input.listing, document.binding.value.spelling);
      if !(r.deleted && read.None?) && Concurrent(document, read, r) {
        assert applied == Settle(platform, doc, document, read.value, r, input, bound, claims, rev);
        SettleCopyUntracked(platform, documents, doc, read.value, r, input, claims, rev);
        if |applied.effects| == 2 {
          assert applied.document.binding.Some? && applied.document.binding.value.spelling == document.binding.value.spelling;
        }
        return;
      }
    }
    forall h | h in SavedBy(applied.effects) ensures false {
      var i := var i :| 0 <= i < |applied.effects| && applied.effects[i].Write? && applied.effects[i].target.None? && applied.effects[i].content == h; i;
    }
  }
  // After a move aside, no later move of the same aside nor the head's
  // write touches the name it moved to.
  lemma {:isolate_assertions} AsideTailUntouched(platform: Platform, listing: Listing, front: seq<Effect>, arrive: Effect,
                                                 moves: seq<(Path, Path, Hash)>, i: nat, wanted: Path)
    requires i < |moves| && |front| == |moves|
    requires forall k | 0 <= k < |moves| :: front[k].Move? && front[k].from == moves[k].0 && front[k].to == moves[k].1
    requires forall k | 0 <= k < |moves| :: moves[k].0 in listing && FreeIn(platform, listing, moves[k].1)
                                              && !CollideF(platform, moves[k].1, wanted)
    requires forall a, b | 0 <= a < b < |moves| :: !CollideF(platform, moves[a].1, moves[b].1)
    requires arrive.Write? && arrive.path == wanted
    ensures forall k | i < k < |front + [arrive]| :: !Touches(platform, (front + [arrive])[k], moves[i].1)
  {
    var effects := front + [arrive];
    forall k | i < k < |effects| ensures !Touches(platform, effects[k], moves[i].1) {
      if k < |front| {
        assert effects[k] == front[k];
        assert !CollideF(platform, moves[k].0, moves[i].1);
        assert !CollideF(platform, moves[i].1, moves[k].1);
        if SameF(platform, moves[k].1, moves[i].1) { SameFIsEquivalence(platform, moves[k].1, moves[i].1, moves[i].1); assert false; }
      } else {
        assert effects[k] == arrive;
        if SameF(platform, wanted, moves[i].1) { SameFIsEquivalence(platform, wanted, moves[i].1, moves[i].1); assert CollideF(platform, moves[i].1, wanted); assert false; }
      }
    }
  }
  // The local version a remote move against a local change keeps apart is
  // an untracked file after the rule: at its name, or moved aside.
  lemma {:isolate_assertions} ClearWayKeptApartUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                         input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      Distinct(platform, listing') && ruled.documents[doc].ahead.None? ==>
        forall h | h in KeptApart(platform, documents[doc], r, input) :: UntrackedHolds(platform, ruled.documents, listing', h)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    ClearWayKeys(platform, documents, doc, r, input, revs);
    var read := MoveRead(platform, document, r, input);
    if !(Distinct(platform, listing') && ruled.documents[doc].ahead.None?) { return; }
    if !(read.Some? && MovedContent(document, read.value, r).None?) { return; }
    var keep := Keeps(platform, document, r, input);
    reveal Keeps();
    assert keep.None?;
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    assert aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value);
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    AsideCovers(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    var t := document.binding.value.spelling;
    var lc := read.value.0;
    var own := ListedAt(platform, input.listing, t);
    assert ListedRead(platform, input.listing, t) == read;
    assert own in input.listing && SameF(platform, own, t) && input.listing[own].0 == lc;
    assert t in avoid;
    reveal ArrivingRow();
    reveal Arriving();
    assert arrive == [Write(Some(doc), r.path, Arriving(platform, document, r, input).content, Arriving(platform, document, r, input).kind, None)];
    var rows := ruled.documents;
    var name: Path;
    if CollideF(platform, own, r.path) {
      InTheWayHas(platform, input.listing, r.path, keep, own);
      var i := var i :| 0 <= i < |moves| && moves[i].0 == own; i;
      forall j | 0 <= j < |moves| ensures moves[j].0 in input.listing { assert moves[j].0 in way; }
      assert ruled.effects == front + [arrive[0]];
      AsideTailUntouched(platform, input.listing, front, arrive[0], moves, i, r.path);
      MovedKeepsRead(platform, input.listing, ruled.effects, moves, i, moves[i].1);
      name := moves[i].1;
      assert 0 <= i < |moves| && moves[i].0 == own && name == moves[i].1;
    } else {
      forall effect | effect in ruled.effects ensures !Touches(platform, effect, own) {
        if effect in front {
          var k := var k :| 0 <= k < |front| && front[k] == effect; k;
          assert moves[k].0 in way && moves[k].0 != own;
          assert !CollideF(platform, own, moves[k].1);
        } else {
          assert effect == arrive[0];
          if SameF(platform, r.path, own) { SameFIsEquivalence(platform, r.path, own, own); assert false; }
        }
      }
      ListingAfterUntouched(platform, input.listing, ruled.effects, own);
      SameFIsEquivalence(platform, own, own, own);
      name := own;
    }
    assert ListedRead(platform, listing', name) == read by {
      if name == own {
        assert Listed(platform, input.listing, own);
        ListedReadSameF(platform, input.listing, own, t);
      } else {
        ListedReadSameF(platform, input.listing, own, t);
      }
    }
    var p := ListedAt(platform, listing', name);
    assert p in listing' && listing'[p].0 == lc && SameF(platform, p, name);
    forall e | e in rows && rows[e].binding.Some? ensures !SameF(platform, rows[e].binding.value.spelling, p) {
      var se := rows[e].binding.value.spelling;
      if SameF(platform, se, p) {
        SameFIsEquivalence(platform, se, p, name);
        if e == doc {
          assert rows[doc] == HeadRow(platform, document, r, input, revs[doc]);
          assert se == r.path;
          assert CollideF(platform, se, name);
          if name == own {
            assert false;
          } else {
            assert false;
          }
        } else {
          ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e);
          assert e in documents && documents[e].binding.Some?;
          if se == documents[e].binding.value.spelling && rows[e].binding == documents[e].binding {
            assert se in BoundNames(documents);
            if name == own {
              SameFIsEquivalence(platform, se, own, t);
              assert false;
            } else {
              assert false;
            }
          } else {
            var j := var j :| 0 <= j < |moves| && se == moves[j].1 && FileOf(platform, documents, moves[j].0, e); j;
            if name == own {
              assert !CollideF(platform, own, moves[j].1);
              SameFIsEquivalence(platform, moves[j].1, own, own);
              assert false;
            } else {
              if moves[j].0 == own {
                SameFIsEquivalence(platform, documents[e].binding.value.spelling, own, t);
                assert false;
              }
              var i := var i :| 0 <= i < |moves| && moves[i].0 == own && name == moves[i].1; i;
              assert i != j;
              SameFIsEquivalence(platform, moves[j].1, moves[i].1, moves[i].1);
              if i < j {
                assert !CollideF(platform, moves[i].1, moves[j].1);
              } else {
                assert !CollideF(platform, moves[j].1, moves[i].1);
              }
              assert false;
            }
          }
        }
      }
    }
    forall h | h in KeptApart(platform, document, r, input) ensures UntrackedHolds(platform, rows, listing', h) {
      assert h == lc;
    }
  }
  // ---------------------------------------------------------------------
  // Untracked contents stay saved through the pass
  // ---------------------------------------------------------------------

  // An untracked listed file no effect touches, at a name no row binds
  // after, still holds its content untracked.
  lemma UntouchedStaysUntracked(platform: Platform, rows': map<DocId, Document>, listing: Listing, effects: seq<Effect>, p: Path, h: Hash)
    requires Distinct(platform, listing) && Distinct(platform, ListingAfter(platform, listing, effects))
    requires p in listing && listing[p].0 == h
    requires forall effect :: effect in effects ==> !Touches(platform, effect, p)
    requires forall e | e in rows' && rows'[e].binding.Some? :: !SameF(platform, rows'[e].binding.value.spelling, p)
    ensures UntrackedHolds(platform, rows', ListingAfter(platform, listing, effects), h)
  {
    var after := ListingAfter(platform, listing, effects);
    ListingAfterUntouched(platform, listing, effects, p);
    SameFIsEquivalence(platform, p, p, p);
    assert Listed(platform, listing, p);
    assert ListedAt(platform, listing, p) == p by {
      var k := ListedAt(platform, listing, p);
      if k != p { assert SameF(platform, k, p); assert false; }
    }
    var k := ListedAt(platform, after, p);
    assert k in after && after[k].0 == h && SameF(platform, k, p);
    forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, k) {
      if SameF(platform, rows'[e].binding.value.spelling, k) { SameFIsEquivalence(platform, rows'[e].binding.value.spelling, k, p); }
    }
  }

  // A create (of a row with no file here) keeps an untracked content
  // untracked: it writes at a free name, adopts the file (holding the
  // head), or moves the one file in the way aside to a copy.
  lemma {:isolate_assertions} CreateKeepsUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, row: Document, r: Revision,
                                                   input: RoundInput, claims: Claims, rev: RevId, p: Path, h: Hash)
    requires ListingDistinct(platform, input.listing) && row.binding.None? && !r.deleted
    requires p in input.listing && input.listing[p].0 == h
    requires forall e | e in documents && documents[e].binding.Some? :: !SameF(platform, documents[e].binding.value.spelling, p)
    ensures var applied := Create(platform, doc, row, r, input, BoundNames(documents), claims, rev);
      var listing' := ListingAfter(platform, input.listing, applied.effects);
      Distinct(platform, listing') ==>
        UntrackedHolds(platform, documents[doc := applied.document], listing', h) || (!r.deleted && h == r.content)
  {
    var bound := BoundNames(documents);
    var applied := Create(platform, doc, row, r, input, bound, claims, rev);
    var listing' := ListingAfter(platform, input.listing, applied.effects);
    var rows' := documents[doc := applied.document];
    if !Distinct(platform, listing') { return; }
    if applied.document.binding.None? || applied.document.binding.value.spelling != r.path {
      assert applied.effects == [] || applied.effects == [Report(Some(doc), r.path, "conflict: no copy name fits")];
      forall effect | effect in applied.effects ensures !Touches(platform, effect, p) { }
      forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, p) {
        if e == doc { assert applied.document.binding == row.binding; assert false; }
      }
      UntouchedStaysUntracked(platform, rows', input.listing, applied.effects, p, h);
      return;
    }
    if FreeIn(platform, input.listing, r.path) {
      assert applied.effects == [Write(Some(doc), r.path, r.content, r.kind, None)];
      assert !CollideF(platform, p, r.path);
      forall effect | effect in applied.effects ensures !Touches(platform, effect, p) { }
      forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, p) {
        if e == doc { assert rows'[e].binding.value.spelling == r.path; }
      }
      UntouchedStaysUntracked(platform, rows', input.listing, applied.effects, p, h);
      return;
    }
    var held := Colliders(platform, input.listing, r.path);
    if Adoptable(platform, row, input, r) {
      assert applied.effects == [];
      if SameF(platform, p, r.path) {
        assert CollideF(platform, p, r.path);
        assert p in held;
        assert p == r.path;
        assert h == input.listing[r.path].0 == r.content;
        return;
      }
      forall effect | effect in applied.effects ensures !Touches(platform, effect, p) { }
      forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, p) {
        if e == doc { assert rows'[e].binding.value.spelling == r.path; if SameF(platform, r.path, p) { SameFIsEquivalence(platform, r.path, p, p); } }
      }
      UntouchedStaysUntracked(platform, rows', input.listing, applied.effects, p, h);
      return;
    }
    var q := LeastPath(held);
    var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, q, r.path).value;
    var m := Move(None, q, copy, input.listing[q].0);
    var w := Write(Some(doc), r.path, r.content, r.kind, None);
    assert applied.effects == [m, w];
    AppliedMovesAndCopies(platform, doc, row, r, input, bound, claims, rev);
    CreateMoveAsideReads(platform, doc, row, r, input, bound, claims, rev);
    assert q in held && q in input.listing;
    assert FreeIn(platform, input.listing, copy);
    assert forall t | t in bound :: !SameF(platform, t, copy);
    if p == q {
      ListingAfterTwo(platform, input.listing, m, w);
      var mid := ListingAfterEffect(platform, input.listing, m);
      SameFIsEquivalence(platform, q, q, q);
      assert ListedAt(platform, input.listing, q) == q by {
        var k := ListedAt(platform, input.listing, q);
        if k != q { assert SameF(platform, k, q); assert false; }
      }
      assert mid == (input.listing - {q})[copy := input.listing[q]];
      assert !CollideF(platform, copy, r.path);
      assert !SameF(platform, r.path, copy);
      assert listing' == ListingAfterEffect(platform, mid, w);
      assert copy in listing' && listing'[copy].0 == h;
      forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, copy) {
        if e == doc { assert rows'[e].binding.value.spelling == r.path; if SameF(platform, r.path, copy) { SameFIsEquivalence(platform, r.path, copy, copy); } }
        else { assert rows'[e].binding.value.spelling in bound; }
      }
      return;
    }
    if SameF(platform, p, q) { assert false; }
    if SameF(platform, p, r.path) {
      assert CollideF(platform, p, r.path) && p in held;
      assert p in held - {q};
      assert |held - {q}| == |held| - 1 == 0;
      assert false;
    }
    assert !CollideF(platform, p, copy);
    forall effect | effect in applied.effects ensures !Touches(platform, effect, p) {
      if SameF(platform, copy, p) { SameFIsEquivalence(platform, copy, p, p); assert CollideF(platform, p, copy); }
      if SameF(platform, q, p) { SameFIsEquivalence(platform, q, p, p); }
      if SameF(platform, r.path, p) { SameFIsEquivalence(platform, r.path, p, p); }
    }
    forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, p) {
      if e == doc { assert rows'[e].binding.value.spelling == r.path; if SameF(platform, r.path, p) { SameFIsEquivalence(platform, r.path, p, p); } }
    }
    UntouchedStaysUntracked(platform, rows', input.listing, applied.effects, p, h);
  }

  // The apply keeps an untracked content untracked, or adopts it for the
  // head (which holds exactly it): it writes and removes only at its row's
  // own name and at free copy names, or creates.
  lemma {:isolate_assertions} ApplyKeepsUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                  input: RoundInput, claims: Claims, rev: RevId, p: Path, h: Hash)
    requires ListingDistinct(platform, input.listing) && doc in documents
    requires p in input.listing && input.listing[p].0 == h
    requires forall e | e in documents && documents[e].binding.Some? :: !SameF(platform, documents[e].binding.value.spelling, p)
    ensures var applied := ApplyRevision(platform, doc, documents[doc], r, input, BoundNames(documents), claims, rev);
      var listing' := ListingAfter(platform, input.listing, applied.effects);
      Distinct(platform, listing') ==>
        UntrackedHolds(platform, documents[doc := applied.document], listing', h) || (!r.deleted && h == r.content)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    var listing' := ListingAfter(platform, input.listing, applied.effects);
    var rows' := documents[doc := applied.document];
    if !Distinct(platform, listing') { return; }
    var creates := Newer(document, r) && !SettlesIdentical(platform, document, r, input) && !Acknowledges(document, r)
      && ((Revives(platform, document, r, input) && !KeepsUntracked(platform, document, r, input))
          || (!Revives(platform, document, r, input) && document.binding.None? && !r.deleted));
    if creates {
      if Revives(platform, document, r, input) {
        assert applied == Create(platform, doc, Revived(document), r, input, bound, claims, rev);
        CreateKeepsUntracked(platform, documents, doc, Revived(document), r, input, claims, rev, p, h);
      } else {
        assert applied == Create(platform, doc, document, r, input, bound, claims, rev);
        CreateKeepsUntracked(platform, documents, doc, document, r, input, claims, rev, p, h);
      }
      return;
    }
    AppliedMovesAndCopies(platform, doc, document, r, input, bound, claims, rev);
    assert applied.effects == [] || document.binding.Some?;
    assert applied.document.binding.None? || (document.binding.Some? && applied.document.binding.value.spelling == document.binding.value.spelling);
    forall effect | effect in applied.effects
      ensures effect.Report? || (effect.Write? && effect.target.None?)
              || ((effect.Write? || effect.Remove?) && effect.path == document.binding.value.spelling)
    {
    }
    forall effect | effect in applied.effects ensures !Touches(platform, effect, p) {
      if effect.Write? && effect.target.None? {
        assert !CollideF(platform, p, effect.path);
        if SameF(platform, effect.path, p) { SameFIsEquivalence(platform, effect.path, p, p); }
      } else if effect.Write? || effect.Remove? {
        var t := document.binding.value.spelling;
        assert !SameF(platform, t, p);
      }
    }
    forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, p) {
      if e == doc { assert rows'[e].binding.value.spelling == document.binding.value.spelling; }
    }
    UntouchedStaysUntracked(platform, rows', input.listing, applied.effects, p, h);
  }

  // After a move aside, no later move of the same aside, nor any effect of
  // a tail that leaves its name alone, touches the name it moved to.
  lemma {:isolate_assertions} AsideThenTail(platform: Platform, listing: Listing, front: seq<Effect>, tail: seq<Effect>,
                                            moves: seq<(Path, Path, Hash)>, i: nat)
    requires i < |moves| && |front| == |moves|
    requires forall k | 0 <= k < |moves| :: front[k].Move? && front[k].from == moves[k].0 && front[k].to == moves[k].1
    requires forall k | 0 <= k < |moves| :: moves[k].0 in listing && FreeIn(platform, listing, moves[k].1)
    requires forall a, b | 0 <= a < b < |moves| :: !CollideF(platform, moves[a].1, moves[b].1)
    requires forall effect :: effect in tail ==> !Touches(platform, effect, moves[i].1)
    ensures forall k | i < k < |front + tail| :: !Touches(platform, (front + tail)[k], moves[i].1)
  {
    var effects := front + tail;
    forall k | i < k < |effects| ensures !Touches(platform, effects[k], moves[i].1) {
      if k < |front| {
        assert effects[k] == front[k];
        assert !CollideF(platform, moves[k].0, moves[i].1);
        assert !CollideF(platform, moves[i].1, moves[k].1);
        if SameF(platform, moves[k].1, moves[i].1) { SameFIsEquivalence(platform, moves[k].1, moves[i].1, moves[i].1); assert false; }
      } else {
        assert effects[k] == tail[k - |front|];
        assert effects[k] in tail;
      }
    }
  }

  // The rule clearing the way keeps an untracked content untracked: its
  // file moves aside where it is in the way, and stays otherwise.
  lemma {:isolate_assertions} ClearWayKeepsUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                     input: RoundInput, revs: FreshRevs, p: Path, h: Hash)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires p in input.listing && input.listing[p].0 == h
    requires forall e | e in documents && documents[e].binding.Some? :: !SameF(platform, documents[e].binding.value.spelling, p)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      Distinct(platform, listing') ==> UntrackedHolds(platform, ruled.documents, listing', h)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !Distinct(platform, listing') { return; }
    var rows := ruled.documents;
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if !(aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value)) {
      assert ruled == Defer(documents, doc, r, false) || ruled == Defer(documents, doc, r, true);
      forall effect | effect in ruled.effects ensures !Touches(platform, effect, p) { }
      forall e | e in rows && rows[e].binding.Some? ensures !SameF(platform, rows[e].binding.value.spelling, p) {
        assert rows[e].binding == documents[e].binding;
      }
      UntouchedStaysUntracked(platform, rows, input.listing, ruled.effects, p, h);
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    AsideCovers(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    assert rows[doc] == HeadRow(platform, document, r, input, revs[doc]);
    if keep.Some? {
      assert keep == OwnFile(platform, document, input);
      assert SameF(platform, keep.value, document.binding.value.spelling);
      if SameF(platform, keep.value, p) { SameFIsEquivalence(platform, document.binding.value.spelling, keep.value, p); assert false; }
      assert keep.value != p;
    }
    forall j | 0 <= j < |moves| ensures moves[j].0 in input.listing { assert moves[j].0 in way; }
    if CollideF(platform, p, r.path) {
      InTheWayHas(platform, input.listing, r.path, keep, p);
      var i := var i :| 0 <= i < |moves| && moves[i].0 == p; i;
      var name := moves[i].1;
      reveal ArrivingRow(), Arriving();
      if keep.Some? { assert !CollideF(platform, keep.value, name); }
      if SameF(platform, r.path, name) { SameFIsEquivalence(platform, r.path, name, name); assert CollideF(platform, name, r.path); assert false; }
      ArriveTouchesOnly(platform, doc, ArrivingRow(platform, document, r, input), Arriving(platform, document, r, input), keep, name);
      AsideThenTail(platform, input.listing, front, arrive, moves, i);
      MovedKeepsRead(platform, input.listing, ruled.effects, moves, i, name);
      SameFIsEquivalence(platform, name, name, name);
      assert ListedAt(platform, input.listing, p) == p by {
        SameFIsEquivalence(platform, p, p, p);
        var k := ListedAt(platform, input.listing, p);
        if k != p { assert SameF(platform, k, p); assert false; }
      }
      var k' := ListedAt(platform, listing', name);
      assert k' in listing' && listing'[k'].0 == h && SameF(platform, k', name);
      forall e | e in rows && rows[e].binding.Some? ensures !SameF(platform, rows[e].binding.value.spelling, k') {
        var se := rows[e].binding.value.spelling;
        if SameF(platform, se, k') {
          SameFIsEquivalence(platform, se, k', name);
          if e == doc {
            assert se == r.path;
            assert false;
          } else {
            ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e);
            if rows[e].binding == documents[e].binding {
              assert se in avoid;
              assert false;
            } else {
              var j := var j :| 0 <= j < |moves| && se == moves[j].1 && FileOf(platform, documents, moves[j].0, e); j;
              if j == i { assert false; }
              SameFIsEquivalence(platform, moves[j].1, moves[i].1, moves[i].1);
              if i < j { assert !CollideF(platform, moves[i].1, moves[j].1); } else { assert !CollideF(platform, moves[j].1, moves[i].1); }
              assert false;
            }
          }
        }
      }
      return;
    }
    reveal ArrivingRow(), Arriving();
    if SameF(platform, r.path, p) { SameFIsEquivalence(platform, r.path, p, p); assert CollideF(platform, p, r.path); assert false; }
    ArriveTouchesOnly(platform, doc, ArrivingRow(platform, document, r, input), Arriving(platform, document, r, input), keep, p);
    forall effect | effect in ruled.effects ensures !Touches(platform, effect, p) {
      if effect in front {
        var k := var k :| 0 <= k < |front| && front[k] == effect; k;
        assert moves[k].0 in way && moves[k].0 != p;
        if SameF(platform, moves[k].0, p) { assert false; }
        assert !CollideF(platform, p, moves[k].1);
        if SameF(platform, moves[k].1, p) { SameFIsEquivalence(platform, moves[k].1, p, p); assert false; }
      } else {
        assert effect in arrive;
      }
    }
    forall e | e in rows && rows[e].binding.Some? ensures !SameF(platform, rows[e].binding.value.spelling, p) {
      var se := rows[e].binding.value.spelling;
      if e == doc {
        assert se == r.path;
      } else {
        ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e);
        if rows[e].binding != documents[e].binding {
          var j := var j :| 0 <= j < |moves| && se == moves[j].1 && FileOf(platform, documents, moves[j].0, e); j;
          assert !CollideF(platform, p, moves[j].1);
          if SameF(platform, se, p) { SameFIsEquivalence(platform, se, p, p); assert false; }
        }
      }
    }
    UntouchedStaysUntracked(platform, rows, input.listing, ruled.effects, p, h);
  }

  // The path rule keeps every untracked content untracked, or adopts it
  // for the head, which holds exactly it.
  lemma {:isolate_assertions} RuleKeepsUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                 input: RoundInput, revs: FreshRevs, first: Claims, h: Hash)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires UntrackedHolds(platform, documents, input.listing, h)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      Distinct(platform, listing') ==>
        UntrackedHolds(platform, ruled.documents, listing', h) || (!r.deleted && h == r.content)
  {
    var p := var p :| p in input.listing && input.listing[p].0 == h
      && forall e | e in documents && documents[e].binding.Some? :: !SameF(platform, documents[e].binding.value.spelling, p); p;
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !Distinct(platform, listing') { return; }
    if !HeldForName(document, applied, r) {
      ApplyKeepsUntracked(platform, documents, doc, r, input, claims, revs[doc], p, h);
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      assert applied.document.binding.None? || applied.document.binding == document.binding;
      var rows' := documents[doc := applied.document];
      assert ruled.documents == rows';
      forall effect | effect in ruled.effects ensures !Touches(platform, effect, p) { }
      forall e | e in rows' && rows'[e].binding.Some? ensures !SameF(platform, rows'[e].binding.value.spelling, p) {
        if e == doc { assert rows'[e].binding == document.binding; }
      }
      UntouchedStaysUntracked(platform, rows', input.listing, ruled.effects, p, h);
    } else {
      ClearWayKeepsUntracked(platform, documents, doc, r, input, revs, p, h);
    }
  }

  // What a link of the rule saves is an untracked file after it.
  lemma {:isolate_assertions} RuleSavedUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                 input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      doc in ruled.documents && Distinct(platform, listing') && ruled.documents[doc].base != documents[doc].base ==>
        forall h | h in RuleSaved(platform, documents, doc, r, input, revs, first) :: UntrackedHolds(platform, ruled.documents, listing', h)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      ApplyCopiesUntracked(platform, documents, doc, r, input, claims, revs[doc]);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) { return; }
    assert ruled == ClearWay(platform, documents, doc, r, input, revs);
    ClearWayKeys(platform, documents, doc, r, input, revs);
    if ruled.documents[doc].ahead.Some? {
      assert ruled.documents[doc].base == document.base;
      return;
    }
    ClearWayKeptApartUntracked(platform, documents, doc, r, input, revs);
  }

  // A live revision the server accepted holds `h`.
  ghost predicate AcceptedLive(accepted: map<RevId, Revision>, h: Hash) {
    exists rev :: rev in accepted && !accepted[rev].deleted && accepted[rev].content == h
  }

  // Every content in `saved` is an untracked file on the pass's listing,
  // or a live revision's the server accepted (on a distinct listing: the
  // pass leaves any other as it is).
  ghost predicate SavedHeld(platform: Platform, accepted: map<RevId, Revision>, rows: map<DocId, Document>, listing: Listing, saved: set<Hash>) {
    Distinct(platform, listing) ==>
      forall h | h in saved :: UntrackedHolds(platform, rows, listing, h) || AcceptedLive(accepted, h)
  }

  lemma {:isolate_assertions} SettleKeepsSaved(platform: Platform, accepted: map<RevId, Revision>, pass: RoundPass,
                                               doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, saved: set<Hash>)
    requires NeverJoinedRows(platform, pass.journal.documents) && AcceptedAs(accepted, r)
    requires SavedHeld(platform, accepted, pass.journal.documents, pass.listing, saved)
    ensures var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
      SavedHeld(platform, accepted, settled.journal.documents, settled.listing, saved)
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    if !Distinct(platform, pass.listing) { return; }
    if r.path in input.outOfScope {
      if Newer(row, r) {
        var rows' := settled.journal.documents;
        assert rows' == documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))];
        forall h | h in saved && UntrackedHolds(platform, documents, pass.listing, h)
          ensures UntrackedHolds(platform, rows', settled.listing, h)
        {
          var p := var p :| p in pass.listing && pass.listing[p].0 == h
            && forall e | e in documents && documents[e].binding.Some? :: !SameF(platform, documents[e].binding.value.spelling, p); p;
          assert forall e | e in rows' && rows'[e].binding.Some? :: e in documents && rows'[e].binding == documents[e].binding;
        }
      }
      return;
    }
    var rows := documents[doc := row];
    assert NeverJoinedRows(platform, rows);
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    var listing' := ListingAfter(platform, pass.listing, ruled.effects);
    assert settled.journal.documents == ruled.documents && settled.listing == listing';
    if !Distinct(platform, listing') { return; }
    forall h | h in saved ensures UntrackedHolds(platform, ruled.documents, listing', h) || AcceptedLive(accepted, h) {
      if !AcceptedLive(accepted, h) {
        assert UntrackedHolds(platform, documents, pass.listing, h);
        var p := var p :| p in pass.listing && pass.listing[p].0 == h
          && forall e | e in documents && documents[e].binding.Some? :: !SameF(platform, documents[e].binding.value.spelling, p); p;
        assert UntrackedHolds(platform, rows, pass.listing, h) by {
          assert forall e | e in rows && rows[e].binding.Some? :: e in documents && rows[e].binding == documents[e].binding;
        }
        RuleKeepsUntracked(platform, rows, doc, r, inner, revs', first, h);
        if !r.deleted && h == r.content { assert r.id in accepted && accepted[r.id] == r; assert false; }
      }
    }
  }

  lemma SettlePulledKeepsSaved(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                               revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims, saved: set<Hash>)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass)
    requires SavedHeld(platform, accepted, pass.journal.documents, pass.listing, saved)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    ensures var settled := SettlePulled(platform, pass, revisions, input, revs, first);
      SavedHeld(platform, accepted, settled.journal.documents, settled.listing, saved)
    decreases |revisions|
  {
    if |revisions| > 0 {
      var next := SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsSaved(platform, accepted, pass, revisions[0].doc, revisions[0], input, revs, first, saved);
      SettleKeepsNUD(platform, device0, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledKeepsSaved(platform, device0, accepted, next, revisions[1..], input, revs, first, saved);
    }
  }

  lemma RetryKeepsSaved(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                        docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims, saved: set<Hash>)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass)
    requires SavedHeld(platform, accepted, pass.journal.documents, pass.listing, saved)
    ensures var retried := RetryWaiting(platform, pass, docs, input, revs, first);
      SavedHeld(platform, accepted, retried.journal.documents, retried.listing, saved)
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert NeverJoinedRows(platform, cleared.journal.documents);
        assert PassNUD(platform, device0, accepted, cleared);
        assert SavedHeld(platform, accepted, cleared.journal.documents, cleared.listing, saved) by {
          if Distinct(platform, pass.listing) {
            forall h | h in saved && UntrackedHolds(platform, documents, pass.listing, h)
              ensures UntrackedHolds(platform, cleared.journal.documents, cleared.listing, h)
            {
              var p := var p :| p in pass.listing && pass.listing[p].0 == h
                && forall e | e in documents && documents[e].binding.Some? :: !SameF(platform, documents[e].binding.value.spelling, p); p;
              assert forall e | e in cleared.journal.documents :: cleared.journal.documents[e].binding == documents[e].binding;
            }
          }
        }
        var r := row.ahead.value.revision;
        assert AcceptedAs(accepted, r);
        SettleKeepsSaved(platform, accepted, cleared, docs[0], r, input, revs, first, saved);
        SettleKeepsNUD(platform, device0, accepted, cleared, docs[0], r, input, revs, first);
        RetryKeepsSaved(platform, device0, accepted, SettleRevision(platform, cleared, docs[0], r, input, revs, first), docs[1..], input, revs, first, saved);
      } else {
        RetryKeepsSaved(platform, device0, accepted, pass, docs[1..], input, revs, first, saved);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Each document's chain through the pass
  // ---------------------------------------------------------------------

  // The revisions a chain settled: accepted revisions of `e`, in feed
  // order after the base it started from.
  ghost predicate ChainOrder(accepted: map<RevId, Revision>, e: DocId, base0: Base, rs: seq<Revision>) {
    (forall k | 0 <= k < |rs| :: AcceptedAs(accepted, rs[k]) && rs[k].doc == e)
    && (|rs| > 0 ==> base0.position < rs[0].position)
    && (forall k | 0 <= k < |rs| - 1 :: rs[k].position < rs[k + 1].position)
  }

  // ---------------------------------------------------------------------
  // A row the rule lets go (W(b)): its file stays, untracked
  // ---------------------------------------------------------------------

  // A file moved aside reads at its copy name what it read, where nothing
  // after the move touches that name.
  lemma {:isolate_assertions} AsideMoveReads(platform: Platform, listing: Listing, front: seq<Effect>, tail: seq<Effect>,
                                             moves: seq<(Path, Path, Hash)>, i: nat)
    requires Distinct(platform, listing) && Distinct(platform, ListingAfter(platform, listing, front + tail))
    requires i < |moves| && |front| == |moves|
    requires forall k | 0 <= k < |moves| :: front[k].Move? && front[k].from == moves[k].0 && front[k].to == moves[k].1
    requires forall k | 0 <= k < |moves| :: moves[k].0 in listing && FreeIn(platform, listing, moves[k].1)
    requires forall a, b | 0 <= a < b < |moves| :: moves[a].0 != moves[b].0 && !CollideF(platform, moves[a].1, moves[b].1)
    requires forall effect :: effect in tail ==> !Touches(platform, effect, moves[i].1)
    ensures ListedRead(platform, ListingAfter(platform, listing, front + tail), moves[i].1) == ListedRead(platform, listing, moves[i].0)
  {
    AsideThenTail(platform, listing, front, tail, moves, i);
    SameFIsEquivalence(platform, moves[i].1, moves[i].1, moves[i].1);
    var effects := front + tail;
    assert forall k | 0 <= k < |moves| :: effects[k] == front[k];
    MovedKeepsRead(platform, listing, effects, moves, i, moves[i].1);
  }

  // Where the rule clears the way, another row it lets go had its file
  // moved aside: the copy holds what the row read, and no row is bound
  // to it.
  lemma {:isolate_assertions} ClearWayReleasedUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                        input: RoundInput, revs: FreshRevs, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e != doc && LocalSide(platform, input.listing, documents[e]).Some?
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      e in ruled.documents
      && (Distinct(platform, listing') && ruled.documents[e].binding.None? ==>
            UntrackedHolds(platform, ruled.documents, listing', LocalSide(platform, input.listing, documents[e]).value.0))
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    ClearWayKeys(platform, documents, doc, r, input, revs);
    var rows := ruled.documents;
    if !(Distinct(platform, listing') && rows[e].binding.None?) { return; }
    var t := documents[e].binding.value.spelling;
    var h := LocalSide(platform, input.listing, documents[e]).value.0;
    var p := ListedAt(platform, input.listing, t);
    assert p in input.listing && SameF(platform, p, t) && input.listing[p].0 == h;
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if !(aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value)) {
      assert ruled == Defer(documents, doc, r, false) || ruled == Defer(documents, doc, r, true);
      assert rows[e] == documents[e];
      assert false;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    AsideCovers(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    assert rows[doc] == HeadRow(platform, document, r, input, revs[doc]);
    forall j | 0 <= j < |moves| ensures moves[j].0 in input.listing { assert moves[j].0 in way; }
    var moved := MoveRows(platform, documents, doc, moves, revs);
    MoveRowsRow(platform, documents, doc, moves, revs, input.listing, e);
    assert Listed(platform, input.listing, t);
    assert !MissingIn(platform, input.listing, documents[e]);
    assert rows[e] == moved[e];
    if forall j | 0 <= j < |moves| :: !FileOf(platform, documents, moves[j].0, e) {
      assert moved[e] == documents[e];
      assert false;
    }
    var i := var i :| 0 <= i < |moves| && FileOf(platform, documents, moves[i].0, e); i;
    assert SameF(platform, t, moves[i].0);
    SameFIsEquivalence(platform, p, t, moves[i].0);
    assert moves[i].0 == p;
    var name := moves[i].1;
    reveal ArrivingRow(), Arriving();
    if keep.Some? {
      assert keep == OwnFile(platform, document, input);
      assert !CollideF(platform, keep.value, name);
    }
    if SameF(platform, r.path, name) { SameFIsEquivalence(platform, r.path, name, name); assert CollideF(platform, name, r.path); assert false; }
    ArriveTouchesOnly(platform, doc, ArrivingRow(platform, document, r, input), Arriving(platform, document, r, input), keep, name);
    AsideMoveReads(platform, input.listing, front, arrive, moves, i);
    SameFIsEquivalence(platform, name, name, name);
    assert ListedAt(platform, input.listing, p) == p by {
      SameFIsEquivalence(platform, p, p, p);
      var k := ListedAt(platform, input.listing, p);
      if k != p { assert SameF(platform, k, p); assert false; }
    }
    var k' := ListedAt(platform, listing', name);
    assert k' in listing' && listing'[k'].0 == h && SameF(platform, k', name);
    forall e' | e' in rows && rows[e'].binding.Some? ensures !SameF(platform, rows[e'].binding.value.spelling, k') {
      var se := rows[e'].binding.value.spelling;
      if SameF(platform, se, k') {
        SameFIsEquivalence(platform, se, k', name);
        if e' == doc {
          assert se == r.path;
          assert false;
        } else {
          ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e');
          if rows[e'].binding == documents[e'].binding {
            assert se in avoid;
            assert false;
          } else {
            var j := var j :| 0 <= j < |moves| && se == moves[j].1 && FileOf(platform, documents, moves[j].0, e'); j;
            if j == i {
              SameFIsEquivalence(platform, documents[e'].binding.value.spelling, moves[i].0, t);
              assert e' == e;
              assert false;
            }
            SameFIsEquivalence(platform, moves[j].1, moves[i].1, moves[i].1);
            if i < j { assert !CollideF(platform, moves[i].1, moves[j].1); } else { assert !CollideF(platform, moves[j].1, moves[i].1); }
            assert false;
          }
        }
      }
    }
  }

  // The rule lets another row go only where it clears the way, and then
  // its file stays, untracked.
  lemma {:isolate_assertions} RuleReleasedUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                    input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e != doc && LocalSide(platform, input.listing, documents[e]).Some?
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      e in ruled.documents
      && (Distinct(platform, listing') && ruled.documents[e].binding.None? ==>
            UntrackedHolds(platform, ruled.documents, listing', LocalSide(platform, input.listing, documents[e]).value.0))
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) || UnsavedCollides(platform, input.unsaved, r.path) {
      assert ruled.documents[e] == documents[e];
    } else {
      ClearWayReleasedUntracked(platform, documents, doc, r, input, revs, e);
    }
  }

  // An unbound other row stays unbound under the rule.
  lemma {:isolate_assertions} RuleOtherStaysUnbound(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                    input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e != doc && documents[e].binding.None?
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents && ruled.documents[e].binding.None?
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    RuleKeepsOtherBases(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) || UnsavedCollides(platform, input.unsaved, r.path) {
      assert ruled.documents[e] == documents[e];
    } else {
      ClearWayKeys(platform, documents, doc, r, input, revs);
      if ruled.documents[e].binding.Some? {
        var keep := Keeps(platform, document, r, input);
        var way := InTheWay(platform, input.listing, r.path, keep);
        var avoid := BoundNames(documents) + input.unsaved;
        var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
        assert aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value);
        ClearWayRow(platform, documents, doc, r, input, revs, keep, aside.value, e);
        assert false;
      }
    }
  }

  // A revision that is not newer than what its row knows leaves the rows
  // and the listing as they are.
  lemma RuleNotNewer(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                     input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires !Newer(documents[doc], r)
    ensures PathRule(platform, documents, doc, r, input, revs, first) == Ruled(documents, [])
  {
    assert documents[doc := documents[doc]] == documents;
  }

  // The rule that leaves the document's base as it was and lets its file
  // go leaves the file as it was, untracked.
  lemma {:isolate_assertions} RuleOwnReleasedUntracked(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                       input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires documents[doc].base.Some? && documents[doc].base.value.rev != r.id
    requires LocalSide(platform, input.listing, documents[doc]).Some?
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      doc in ruled.documents
      && (Distinct(platform, listing') && ruled.documents[doc].base == documents[doc].base && ruled.documents[doc].binding.None? ==>
            UntrackedHolds(platform, ruled.documents, listing', LocalSide(platform, input.listing, documents[doc]).value.0))
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !(Distinct(platform, listing') && ruled.documents[doc].base == document.base && ruled.documents[doc].binding.None?) { return; }
    var t := document.binding.value.spelling;
    var p := ListedAt(platform, input.listing, t);
    if !HeldForName(document, applied, r) {
      ApplyKeepsSide(platform, doc, document, r, input, bound, claims, revs[doc]);
      ListingAfterReports(platform, input.listing, ruled.effects);
      assert ruled.documents == documents[doc := applied.document];
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      ApplyKeepsSide(platform, doc, document, r, input, bound, claims, revs[doc]);
      ListingAfterOne(platform, input.listing, ruled.effects[0]);
      assert ruled.documents == documents[doc := applied.document];
    } else {
      assert ruled == ClearWay(platform, documents, doc, r, input, revs);
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        assert ruled.documents[doc] == HeadRow(platform, document, r, input, revs[doc]);
        assert false;
      }
      assert ruled.documents[doc].binding == document.binding;
      assert false;
    }
    assert listing' == input.listing;
    assert p in listing' && SameF(platform, p, t);
    forall e | e in ruled.documents && ruled.documents[e].binding.Some? ensures !SameF(platform, ruled.documents[e].binding.value.spelling, p) {
      assert e != doc && ruled.documents[e] == documents[e];
      if SameF(platform, documents[e].binding.value.spelling, p) {
        SameFIsEquivalence(platform, documents[e].binding.value.spelling, p, t);
        assert false;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Each document's chain through the pass, step by step
  // ---------------------------------------------------------------------

  // A chain may let its local side go at its end where its content is
  // saved.
  lemma ChainSavedLetGo(saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>, rs: seq<Revision>,
                        x: Option<(Hash, Kind)>, c: Option<Hash>)
    requires ChainSaved(saved, d, b, bd, l, rs, x, c) && x.Some? && x.value.0 in saved
    ensures ChainSaved(saved, d, b, bd, l, rs, None, c)
    decreases |rs|, if l.Some? then 1 else 0
  {
    var lg := if c == LocalContent(l) then None else c;
    if l.Some? && l.value.0 in saved && ChainSaved(saved, d, b, bd, None, rs, x, lg) {
      ChainSavedLetGo(saved, d, b, bd, None, rs, x, lg);
      return;
    }
    if |rs| == 0 {
      assert x == l;
      assert ChainSaved(saved, d, b, bd, None, rs, None, lg);
    } else {
      var y := var y :| LinkSaved(saved, d, b, bd, l, rs[0], y)
        && (ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c)
            || (c.Some? && c == LocalContent(l) && ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None))); y;
      if ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c) {
        ChainSavedLetGo(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c);
      } else {
        ChainSavedLetGo(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None);
      }
    }
  }

  // Document `e`, bound with base `base0` before the round and read as
  // `read0`, has settled the chain `rs` so far in rows `rows` over the
  // listing `listing`: the chain leaves the local side the listing reads
  // at its binding (none where the rule let its file go: the chain let it
  // go, saved); its base is the chain's last revision (the start where it
  // is empty), and its waiting revision not below it; every content it
  // saved is still saved; and, once it settled another device's revision,
  // the row is in step with its file (Synced).
  ghost predicate ChainRows(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, base0: Base, read0: (Hash, Kind),
                            e: DocId, rows: map<DocId, Document>, listing: Listing, rs: seq<Revision>, saved: set<Hash>,
                            x: Option<(Hash, Kind)>) {
    e in rows && Distinct(platform, listing)
    && ChainSaved(saved, d, base0.content, base0.deleted, Some(read0), rs, x, Some(read0.0))
    && ChainOrder(accepted, e, base0, rs)
    && SavedHeld(platform, accepted, rows, listing, saved)
    && AheadAboveBase(rows[e])
    && (|rs| == 0 ==> rows[e].base == Some(base0))
    && (|rs| > 0 ==> rows[e].base == Some(BaseOf(rs[|rs| - 1])))
    && x == LocalSide(platform, listing, rows[e])
    && (OthersIn(d, rs) ==> Synced(platform, listing, rows[e]))
  }

  // The chain settled another device's revision.
  ghost predicate OthersIn(d: DeviceId, rs: seq<Revision>) {
    exists k | 0 <= k < |rs| :: rs[k].device != d
  }

  ghost predicate PassChain(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, base0: Base, read0: (Hash, Kind),
                            e: DocId, pass: RoundPass) {
    !Distinct(platform, pass.listing)
    || exists rs, saved, x :: ChainRows(platform, d, accepted, base0, read0, e, pass.journal.documents, pass.listing, rs, saved, x)
  }

  // At the start of the round the chain is empty: the row is as it was.
  lemma PassChainStart(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, e: DocId, start: RoundPass)
    requires e in start.journal.documents && Distinct(platform, start.listing)
    requires var row := start.journal.documents[e];
      row.binding.Some? && row.base.Some? && ListedRead(platform, start.listing, row.binding.value.spelling).Some?
      && AheadAboveBase(row)
    ensures var row := start.journal.documents[e];
      PassChain(platform, d, accepted, row.base.value, ListedRead(platform, start.listing, row.binding.value.spelling).value, e, start)
  {
    var row := start.journal.documents[e];
    var read0 := ListedRead(platform, start.listing, row.binding.value.spelling).value;
    assert ChainRows(platform, d, accepted, row.base.value, read0, e, start.journal.documents, start.listing, [], {}, Some(read0));
  }

  // SavedHeld of two sets is SavedHeld of their union.
  lemma SavedHeldUnion(platform: Platform, accepted: map<RevId, Revision>, rows: map<DocId, Document>, listing: Listing,
                       s1: set<Hash>, s2: set<Hash>)
    requires SavedHeld(platform, accepted, rows, listing, s1) && SavedHeld(platform, accepted, rows, listing, s2)
    ensures SavedHeld(platform, accepted, rows, listing, s1 + s2)
  {}

  // The rule keeps every saved content saved (SettleKeepsSaved, one rule).
  lemma {:isolate_assertions} RuleKeepsSaved(platform: Platform, accepted: map<RevId, Revision>, documents: map<DocId, Document>,
                                             doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, saved: set<Hash>)
    requires doc in documents && documents.Keys <= revs.Keys
    requires Distinct(platform, input.listing) && NeverJoinedRows(platform, documents) && AcceptedAs(accepted, r)
    requires SavedHeld(platform, accepted, documents, input.listing, saved)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      SavedHeld(platform, accepted, ruled.documents, ListingAfter(platform, input.listing, ruled.effects), saved)
  {
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !Distinct(platform, listing') { return; }
    forall h | h in saved ensures UntrackedHolds(platform, ruled.documents, listing', h) || AcceptedLive(accepted, h) {
      if !AcceptedLive(accepted, h) {
        RuleKeepsUntracked(platform, documents, doc, r, input, revs, first, h);
        if !r.deleted && h == r.content { assert r.id in accepted && accepted[r.id] == r; assert false; }
      }
    }
  }

  // The rule keeps other rows' aheads.
  lemma RuleKeepsOtherAheads(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                             revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires e in documents && e != doc
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents && ruled.documents[e].ahead == documents[e].ahead && ruled.documents[e].base == documents[e].base
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    RuleKeepsOtherBases(platform, documents, doc, r, input, revs, first);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        MoveRowsKeepAheadAboveBase(platform, documents, doc, aside.value, revs);
        var moved := MoveRows(platform, documents, doc, aside.value, revs);
        assert PathRule(platform, documents, doc, r, input, revs, first).documents[e]
            == RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs)[e];
      }
    }
  }

  // Another row's chain through the rule: its base stays, and its local
  // side stays, or the rule lets its file go, saved.
  lemma {:isolate_assertions} RuleChainOther(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, base0: Base, read0: (Hash, Kind),
                                             e: DocId, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                             revs: FreshRevs, first: Claims, rs: seq<Revision>, saved: set<Hash>, x: Option<(Hash, Kind)>)
    requires doc in documents && documents.Keys <= revs.Keys && e != doc
    requires NeverJoinedRows(platform, documents) && AcceptedAs(accepted, r)
    requires ChainRows(platform, d, accepted, base0, read0, e, documents, input.listing, rs, saved, x)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      Distinct(platform, listing') ==>
        exists saved', x' :: ChainRows(platform, d, accepted, base0, read0, e, ruled.documents, listing', rs, saved', x')
  {
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !Distinct(platform, listing') { return; }
    var rows' := ruled.documents;
    RuleKeepsOtherAheads(platform, documents, doc, r, input, revs, first, e);
    if OthersIn(d, rs) { RuleOtherSynced(platform, documents, doc, r, input, revs, first, e); }
    RuleKeepsSaved(platform, accepted, documents, doc, r, input, revs, first, saved);
    if rows'[e].binding.Some? {
      RuleOtherSide(platform, documents, doc, r, input, revs, first, e);
      if documents[e].binding.None? { RuleOtherStaysUnbound(platform, documents, doc, r, input, revs, first, e); assert false; }
      assert ChainRows(platform, d, accepted, base0, read0, e, rows', listing', rs, saved, x);
    } else if x.None? {
      assert ChainRows(platform, d, accepted, base0, read0, e, rows', listing', rs, saved, x);
    } else {
      RuleReleasedUntracked(platform, documents, doc, r, input, revs, first, e);
      var saved' := saved + {x.value.0};
      assert SavedHeld(platform, accepted, rows', listing', {x.value.0});
      SavedHeldUnion(platform, accepted, rows', listing', saved, {x.value.0});
      ChainSavedGrows(saved, saved', d, base0.content, base0.deleted, Some(read0), rs, x, Some(read0.0));
      ChainSavedLetGo(saved', d, base0.content, base0.deleted, Some(read0), rs, x, Some(read0.0));
      assert ChainRows(platform, d, accepted, base0, read0, e, rows', listing', rs, saved', None);
    }
  }

  // The document's own chain through the rule: a link where its base
  // moves to the revision, and otherwise its local side stays, or the rule
  // lets its file go, saved.
  lemma {:isolate_assertions} RuleChainOwn(platform: Platform, d: DeviceId, accepted: map<RevId, Revision>, base0: Base, read0: (Hash, Kind),
                                           documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                           revs: FreshRevs, first: Claims, rs: seq<Revision>, saved: set<Hash>, x: Option<(Hash, Kind)>)
    requires doc in documents && documents.Keys <= revs.Keys
    requires NeverJoinedRows(platform, documents) && RowsNameAccepted(accepted, documents)
    requires AcceptedAs(accepted, r) && r.doc == doc
    requires Newer(documents[doc], r) ==> PulledBy(documents[doc], r, d) && NotBuiltOn(documents[doc], r)
    requires ChainRows(platform, d, accepted, base0, read0, doc, documents, input.listing, rs, saved, x)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      Distinct(platform, listing') ==>
        exists rs', saved', x' :: ChainRows(platform, d, accepted, base0, read0, doc, ruled.documents, listing', rs', saved', x')
  {
    var document := documents[doc];
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !Distinct(platform, listing') { return; }
    var rows' := ruled.documents;
    if !Newer(document, r) {
      RuleNotNewer(platform, documents, doc, r, input, revs, first);
      assert ChainRows(platform, d, accepted, base0, read0, doc, rows', listing', rs, saved, x);
      return;
    }
    var base := document.base.value;
    assert base.rev in accepted && BaseRecords(base, doc, accepted[base.rev]);
    assert r.position > base.position;
    assert base.rev != r.id;
    RuleRowFacts(platform, documents, doc, r, input, revs, first);
    RuleKeepsSaved(platform, accepted, documents, doc, r, input, revs, first, saved);
    RuleLink(platform, documents, doc, r, input, revs, first, d);
    if rows'[doc].base != document.base {
      var more := RuleSaved(platform, documents, doc, r, input, revs, first);
      RuleSavedUntracked(platform, documents, doc, r, input, revs, first);
      var saved' := saved + more;
      SavedHeldUnion(platform, accepted, rows', listing', saved, more);
      var x' := LocalSide(platform, listing', rows'[doc]);
      assert LinkSaved(more, d, base.content, base.deleted, x, r, x');
      LinkSavedGrows(more, saved', d, base.content, base.deleted, x, r, x');
      ChainSavedGrows(saved, saved', d, base0.content, base0.deleted, Some(read0), rs, x, Some(read0.0));
      assert ChainBase(base0.content, rs) == base.content && ChainBaseDeleted(base0.deleted, rs) == base.deleted;
      ChainSavedSnoc(saved', d, base0.content, base0.deleted, Some(read0), rs, x, Some(read0.0), r, x');
      var rs' := rs + [r];
      if r.device != d || OthersIn(d, rs) {
        RuleSynced(platform, documents, doc, r, input, revs, first, d);
        if r.device != d { assert rs'[|rs|].device != d; }
        else { var k :| 0 <= k < |rs| && rs[k].device != d; assert rs'[k] == rs[k]; }
      } else {
        assert !OthersIn(d, rs') by {
          forall k | 0 <= k < |rs'| ensures rs'[k].device == d { if k < |rs| { assert rs'[k] == rs[k]; } }
        }
      }
      assert ChainOrder(accepted, doc, base0, rs') by {
        assert forall k | 0 <= k < |rs| :: rs'[k] == rs[k];
        if |rs| > 0 { assert rs[|rs| - 1].position == base.position; }
      }
      assert ChainRows(platform, d, accepted, base0, read0, doc, rows', listing', rs', saved', x');
      return;
    }
    RuleKeepsSide(platform, documents, doc, r, input, revs, first);
    if OthersIn(d, rs) { RuleOwnKeepsSynced(platform, documents, doc, r, input, revs, first); }
    if rows'[doc].binding.Some? || x.None? {
      assert ChainRows(platform, d, accepted, base0, read0, doc, rows', listing', rs, saved, x);
      return;
    }
    RuleOwnReleasedUntracked(platform, documents, doc, r, input, revs, first);
    var saved' := saved + {x.value.0};
    assert SavedHeld(platform, accepted, rows', listing', {x.value.0});
    SavedHeldUnion(platform, accepted, rows', listing', saved, {x.value.0});
    ChainSavedGrows(saved, saved', d, base0.content, base0.deleted, Some(read0), rs, x, Some(read0.0));
    ChainSavedLetGo(saved', d, base0.content, base0.deleted, Some(read0), rs, x, Some(read0.0));
    assert ChainRows(platform, d, accepted, base0, read0, doc, rows', listing', rs, saved', None);
  }

  // Each settled revision keeps every document's chain.
  lemma {:isolate_assertions} SettleKeepsChain(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                                               base0: Base, read0: (Hash, Kind), e: DocId, pass: RoundPass,
                                               doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass) && AcceptedAs(accepted, r) && r.doc == doc
    requires doc in pass.journal.documents && Newer(pass.journal.documents[doc], r) ==>
               PulledBy(pass.journal.documents[doc], r, d) && NotBuiltOn(pass.journal.documents[doc], r)
    requires PassChain(platform, d, accepted, base0, read0, e, pass)
    ensures PassChain(platform, d, accepted, base0, read0, e, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    if !Distinct(platform, pass.listing) { return; }
    var rs, saved, x :| ChainRows(platform, d, accepted, base0, read0, e, documents, pass.listing, rs, saved, x);
    if r.path in input.outOfScope {
      if Newer(row, r) {
        var rows' := settled.journal.documents;
        assert rows' == documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))];
        assert forall f | f in rows' :: (f in documents && rows'[f].binding == documents[f].binding) || rows'[f].binding.None?;
        assert rows'[e].binding == documents[e].binding && rows'[e].base == documents[e].base;
        assert SavedHeld(platform, accepted, rows', settled.listing, saved) by {
          forall h | h in saved && UntrackedHolds(platform, documents, pass.listing, h)
            ensures UntrackedHolds(platform, rows', settled.listing, h)
          {
            var p := var p :| p in pass.listing && pass.listing[p].0 == h
              && forall f | f in documents && documents[f].binding.Some? :: !SameF(platform, documents[f].binding.value.spelling, p); p;
          }
        }
        assert ChainRows(platform, d, accepted, base0, read0, e, rows', settled.listing, rs, saved, x);
      }
      return;
    }
    var rows := documents[doc := row];
    assert NeverJoinedRows(platform, rows);
    assert RowsNameAccepted(accepted, rows);
    assert ChainRows(platform, d, accepted, base0, read0, e, rows, pass.listing, rs, saved, x) by {
      forall h | h in saved && UntrackedHolds(platform, documents, pass.listing, h)
        ensures UntrackedHolds(platform, rows, pass.listing, h)
      {
        var p := var p :| p in pass.listing && pass.listing[p].0 == h
          && forall f | f in documents && documents[f].binding.Some? :: !SameF(platform, documents[f].binding.value.spelling, p); p;
        assert forall f | f in rows && rows[f].binding.Some? :: f in documents && rows[f].binding == documents[f].binding;
      }
    }
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    assert settled.journal.documents == ruled.documents && settled.listing == ListingAfter(platform, pass.listing, ruled.effects);
    if e == doc {
      RuleChainOwn(platform, d, accepted, base0, read0, rows, doc, r, inner, revs', first, rs, saved, x);
    } else {
      RuleChainOther(platform, d, accepted, base0, read0, e, rows, doc, r, inner, revs', first, rs, saved, x);
    }
  }

  lemma SettlePulledKeepsChain(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                               base0: Base, read0: (Hash, Kind), e: DocId, pass: RoundPass,
                               revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass)
    requires PassChain(platform, d, accepted, base0, read0, e, pass)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    // Who made each revision (PulledBy), as the pass meets it.
    requires PulledInPass(platform, d, pass, revisions, input, revs, first)
    ensures PassChain(platform, d, accepted, base0, read0, e, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      var next := SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsChain(platform, device0, d, accepted, base0, read0, e, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsNUD(platform, device0, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledKeepsChain(platform, device0, d, accepted, base0, read0, e, next, revisions[1..], input, revs, first);
    }
  }

  // Every pulled revision the pass settles is PulledBy its row as the
  // pass meets it, and a commit in flight is NotBuiltOn it, where it is
  // newer (Apply.dfy states both; the round's final lemma takes them as
  // facts of the state before it).
  ghost predicate PulledInPass(platform: Platform, d: DeviceId, pass: RoundPass, revisions: seq<Revision>, input: RoundInput,
                               revs: FreshRevs, first: Claims)
    decreases |revisions|
  {
    |revisions| > 0 ==>
      var documents := pass.journal.documents;
      var r := revisions[0];
      (r.doc in documents && Newer(documents[r.doc], r) ==> PulledBy(documents[r.doc], r, d) && NotBuiltOn(documents[r.doc], r))
      && PulledInPass(platform, d, SettleRevision(platform, pass, r.doc, r, input, revs, first), revisions[1..], input, revs, first)
  }

  lemma RetryKeepsChain(platform: Platform, device0: Device, d: DeviceId, accepted: map<RevId, Revision>,
                        base0: Base, read0: (Hash, Kind), e: DocId, pass: RoundPass,
                        docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass)
    requires PassChain(platform, d, accepted, base0, read0, e, pass)
    requires RetriedInPass(platform, d, pass, docs, input, revs, first)
    ensures PassChain(platform, d, accepted, base0, read0, e, RetryWaiting(platform, pass, docs, input, revs, first))
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert NeverJoinedRows(platform, cleared.journal.documents);
        assert PassNUD(platform, device0, accepted, cleared);
        assert PassChain(platform, d, accepted, base0, read0, e, cleared) by {
          if Distinct(platform, pass.listing) {
            var rs, saved, x :| ChainRows(platform, d, accepted, base0, read0, e, documents, pass.listing, rs, saved, x);
            var rows' := cleared.journal.documents;
            assert forall f | f in rows' :: f in documents && rows'[f].binding == documents[f].binding && rows'[f].base == documents[f].base;
            assert SavedHeld(platform, accepted, rows', cleared.listing, saved) by {
              forall h | h in saved && UntrackedHolds(platform, documents, pass.listing, h)
                ensures UntrackedHolds(platform, rows', cleared.listing, h)
              {
                var p := var p :| p in pass.listing && pass.listing[p].0 == h
                  && forall f | f in documents && documents[f].binding.Some? :: !SameF(platform, documents[f].binding.value.spelling, p); p;
              }
            }
            assert ChainRows(platform, d, accepted, base0, read0, e, rows', cleared.listing, rs, saved, x);
          }
        }
        var r := row.ahead.value.revision;
        assert AcceptedAs(accepted, r) && r.doc == docs[0];
        SettleKeepsChain(platform, device0, d, accepted, base0, read0, e, cleared, docs[0], r, input, revs, first);
        SettleKeepsNUD(platform, device0, accepted, cleared, docs[0], r, input, revs, first);
        RetryKeepsChain(platform, device0, d, accepted, base0, read0, e, SettleRevision(platform, cleared, docs[0], r, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsChain(platform, device0, d, accepted, base0, read0, e, pass, docs[1..], input, revs, first);
      }
    }
  }

  // Every waiting revision the pass retries is PulledBy its row, once its
  // ahead is cleared.
  ghost predicate RetriedInPass(platform: Platform, d: DeviceId, pass: RoundPass, docs: seq<DocId>, input: RoundInput,
                                revs: FreshRevs, first: Claims)
    decreases |docs|
  {
    |docs| > 0 ==>
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? then
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        var r := row.ahead.value.revision;
        (Newer(row.(ahead := None), r) ==> PulledBy(row.(ahead := None), r, d) && NotBuiltOn(row.(ahead := None), r))
        && RetriedInPass(platform, d, SettleRevision(platform, cleared, docs[0], r, input, revs, first), docs[1..], input, revs, first)
      else RetriedInPass(platform, d, pass, docs[1..], input, revs, first)
  }

  // ---------------------------------------------------------------------
  // In step with the file: what the document sends is its local side
  // ---------------------------------------------------------------------

  // A row in step with its file: a bound row has seen what the listing
  // reads at its name, and a live outbox the document sends (Outgoing)
  // carries it.
  ghost predicate Synced(platform: Platform, listing: Listing, row: Document)
    requires ListingDistinct(platform, listing)
  {
    (row.binding.Some? ==>
       LocalSide(platform, listing, row).Some? && LocalSide(platform, listing, row).value.0 == row.binding.value.seen)
    && (row.outbox.Some? && !row.outbox.value.deleted && !Superseded(row) ==>
          row.binding.Some? && row.outbox.value.content == row.binding.value.seen)
  }

  // The apply that settles another device's revision leaves the row in
  // step with its file; its own revision's acknowledgement keeps it so.
  lemma {:isolate_assertions} ApplySynced(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput,
                                          bound: set<Path>, claims: Claims, rev: RevId, d: DeviceId)
    requires ListingDistinct(platform, input.listing)
    requires document.base.Some? && PulledBy(document, r, d) && NotBuiltOn(document, r)
    requires document.base.value.rev == r.id ==> document.base == Some(BaseOf(r))
    requires r.device == d ==> Synced(platform, input.listing, document)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      var listing' := ListingAfter(platform, input.listing, applied.effects);
      Distinct(platform, listing') && applied.document.base != document.base ==>
        Synced(platform, listing', applied.document)
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    var listing' := ListingAfter(platform, input.listing, applied.effects);
    if !Distinct(platform, listing') || applied.document.base == document.base { return; }
    var b := document.base.value.content;
    var after := applied.document;
    var x := LocalSide(platform, listing', after);
    assert Newer(document, r);
    if SettlesIdentical(platform, document, r, input) {
      assert applied.effects == [] && listing' == input.listing;
      assert after == IdenticalRow(document, r);
      return;
    }
    if Acknowledges(document, r) {
      assert applied.effects == [] && listing' == input.listing;
      return;
    }
    assert r.device != d;
    if Revives(platform, document, r, input) {
      assert !KeepsUntracked(platform, document, r, input);
      assert applied == Create(platform, doc, Revived(document), r, input, bound, claims, rev);
      if |applied.effects| == 1 {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        WriteReads(platform, input.listing, applied.effects[0]);
      } else if |applied.effects| == 2 {
        CreateMoveAsideReads(platform, doc, Revived(document), r, input, bound, claims, rev);
      } else {
        assert applied.effects == [] && listing' == input.listing;
        SameFIsEquivalence(platform, r.path, r.path, r.path);
        assert x == Some((r.content, r.kind));
      }
      return;
    }
    if document.binding.None? {
      if r.deleted {
        assert applied.effects == [] && after.binding.None?;
        return;
      }
      assert applied == Create(platform, doc, document, r, input, bound, claims, rev);
      if |applied.effects| == 1 {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        WriteReads(platform, input.listing, applied.effects[0]);
      } else if |applied.effects| == 2 {
        CreateMoveAsideReads(platform, doc, document, r, input, bound, claims, rev);
      } else {
        assert applied.effects == [] && listing' == input.listing;
        SameFIsEquivalence(platform, r.path, r.path, r.path);
        assert x == Some((r.content, r.kind));
      }
      return;
    }
    var spelling := document.binding.value.spelling;
    var read := ListedRead(platform, input.listing, spelling);
    if r.deleted && read.None? {
      return;
    }
    if Concurrent(document, read, r) {
      assert applied == Settle(platform, doc, document, read.value, r, input, bound, claims, rev);
      var lc := read.value.0;
      if lc == b && lc == document.binding.value.seen {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        WriteReads(platform, input.listing, applied.effects[0]);
        assert x == Some((r.content, r.kind));
      } else if r.content == b {
        assert applied.effects == [] && listing' == input.listing;
      } else if lc != b && read.value.1 == Note && r.kind == Note && Merge(b, lc, r.content).Some? {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        WriteReads(platform, input.listing, applied.effects[0]);
        assert x == Some((Merge(b, lc, r.content).value, Note));
      } else {
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, spelling, spelling).value;
        assert applied.effects == [Write(None, copy, lc, read.value.1, None), Write(Some(doc), spelling, r.content, r.kind, Some(lc))];
        ListingAfterTwo(platform, input.listing, applied.effects[0], applied.effects[1]);
        var mid := ListingAfterEffect(platform, input.listing, applied.effects[0]);
        if Listed(platform, input.listing, copy) {
          var q := ListedAt(platform, input.listing, copy);
          assert CollideF(platform, q, copy);
          assert false;
        }
        var k := ListedAt(platform, input.listing, spelling);
        assert k in mid;
        assert Listed(platform, mid, spelling);
        WriteReads(platform, mid, applied.effects[1]);
        assert x == Some((r.content, r.kind));
      }
      return;
    }
    if EditedAgainstDelete(document, read, r) {
      assert applied.effects == [] && listing' == input.listing;
      return;
    }
    if MovedAgainstChange(document, read, r) { return; }
    if !Clean(platform, document, read) && !r.deleted && read.Some? && document.base.value.rev == r.id {
      assert applied.effects == [] && listing' == input.listing;
      return;
    }
    if !Clean(platform, document, read) { return; }
    if r.deleted {
      assert after.binding.None? && after.outbox.None?;
      return;
    }
    if r.path == spelling {
      ListingAfterOne(platform, input.listing, applied.effects[0]);
      WriteReads(platform, input.listing, applied.effects[0]);
      assert x == Some((r.content, r.kind));
      return;
    }
  }

  // Where the rule clears the way, the head's row is in step with its
  // file.
  lemma {:isolate_assertions} ClearWayHeadSynced(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                                 revs: FreshRevs, first: Claims, d: DeviceId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires documents[doc].base.Some? && PulledBy(documents[doc], r, d) && NotBuiltOn(documents[doc], r)
    requires HeldForName(documents[doc], ApplyRevision(platform, doc, documents[doc], r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]), r)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      doc in ruled.documents && Distinct(platform, listing') && ruled.documents[doc].ahead.None?
      && ruled.documents[doc].base != documents[doc].base ==>
        Synced(platform, listing', ruled.documents[doc])
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !(doc in ruled.documents && Distinct(platform, listing') && ruled.documents[doc].ahead.None?
         && ruled.documents[doc].base != document.base) { return; }
    ClearWayHeadReads(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    assert aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value);
    var head := HeadRow(platform, document, r, input, revs[doc]);
    assert ruled.documents[doc] == head;
    var x := LocalSide(platform, listing', head);
    assert x == ListedRead(platform, listing', r.path);
    var a := Arriving(platform, document, r, input);
    var read := MoveRead(platform, document, r, input);
    assert !Acknowledges(document, r);
    assert !r.deleted;
    reveal HeadRow();
    if read.Some? {
      reveal Arriving();
      reveal ArrivingRow();
      reveal Keeps();
      assert x.Some? && x.value.0 == a.content;
      if MovedContent(document, read.value, r).None? {
        assert a == r;
        assert head.binding.value.seen == r.content;
      } else {
        assert head.binding.value.seen == a.content;
      }
    } else if Revives(platform, document, r, input) || document.binding.None? {
      reveal Arriving();
      reveal Keeps();
      assert keep.None?;
      assert x == Some((r.content, r.kind));
    } else {
      HeldClean(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
      reveal Arriving();
      reveal ArrivingRow();
      assert a == r;
      assert x.Some? && x.value.0 == r.content;
      assert document.outbox.None?;
    }
  }

  // The rule that settles another device's revision leaves the document's
  // row in step with its file; its own revision's acknowledgement keeps it
  // so.
  lemma {:isolate_assertions} RuleSynced(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                         revs: FreshRevs, first: Claims, d: DeviceId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires documents[doc].base.Some? && PulledBy(documents[doc], r, d) && NotBuiltOn(documents[doc], r)
    requires documents[doc].base.value.rev == r.id ==> documents[doc].base == Some(BaseOf(r))
    requires r.device == d ==> Synced(platform, input.listing, documents[doc])
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      doc in ruled.documents
      && (Distinct(platform, listing') && ruled.documents[doc].base != documents[doc].base ==>
            Synced(platform, listing', ruled.documents[doc]))
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      assert ruled.documents[doc] == applied.document && ruled.effects == applied.effects;
      ApplySynced(platform, doc, document, r, input, bound, claims, revs[doc], d);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) {
      assert ruled.documents[doc].base == document.base;
      return;
    }
    assert ruled == ClearWay(platform, documents, doc, r, input, revs);
    ClearWayKeys(platform, documents, doc, r, input, revs);
    if ruled.documents[doc].ahead.Some? {
      assert ruled.documents[doc].base == document.base;
      return;
    }
    ClearWayHeadSynced(platform, documents, doc, r, input, revs, first, d);
  }

  // Where the rule clears the way, another row is as it was, or moved
  // aside, or (its file missing) records the user's delete.
  lemma {:isolate_assertions} ClearWayOtherRow(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                               input: RoundInput, revs: FreshRevs, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e != doc
    ensures var rows := ClearWay(platform, documents, doc, r, input, revs).documents;
      e in rows
      && (rows[e] == documents[e]
          || (documents[e].binding.Some? && exists c :: rows[e] == MovedAside(documents[e], c, revs[e]))
          || MissingIn(platform, input.listing, documents[e]))
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    ClearWayKeys(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if !(aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value)) {
      assert ruled == Defer(documents, doc, r, false) || ruled == Defer(documents, doc, r, true);
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    forall j | 0 <= j < |moves| ensures moves[j].0 in input.listing { assert moves[j].0 in way; }
    var moved := MoveRows(platform, documents, doc, moves, revs);
    MoveRowsRow(platform, documents, doc, moves, revs, input.listing, e);
    if MissingIn(platform, input.listing, documents[e]) { return; }
    assert ruled.documents[e] == moved[e];
    if exists j | 0 <= j < |moves| :: FileOf(platform, documents, moves[j].0, e) {
      var j := var j :| 0 <= j < |moves| && FileOf(platform, documents, moves[j].0, e); j;
      assert moved[e] == MovedAside(documents[e], moves[j].1, revs[e]);
    }
  }

  // The rule keeps every other row in step with its file.
  lemma {:isolate_assertions} RuleOtherSynced(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                              revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e != doc && Synced(platform, input.listing, documents[e])
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      e in ruled.documents
      && (Distinct(platform, listing') ==> Synced(platform, listing', ruled.documents[e]))
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    RuleOtherSide(platform, documents, doc, r, input, revs, first, e);
    if !Distinct(platform, listing') { return; }
    var before := documents[e];
    var after := ruled.documents[e];
    if !HeldForName(document, applied, r) || UnsavedCollides(platform, input.unsaved, r.path) {
      assert after == before;
    } else {
      ClearWayOtherRow(platform, documents, doc, r, input, revs, e);
      if before.binding.Some? {
        assert !MissingIn(platform, input.listing, before);
      }
    }
    if after != before {
      var c :| after == MovedAside(before, c, revs[e]);
      assert after.base == before.base;
    }
  }

  // The apply that leaves a row's base as it was changes at most what
  // waits (and, reviving, drops the binding: Create holds the revived
  // row), and touches no file.
  lemma {:isolate_assertions} ApplyKeepsRow(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput,
                                            bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    requires document.base.Some? && document.base.value.rev != r.id
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      applied.document.base == document.base ==>
        (applied.document == document.(ahead := applied.document.ahead)
         || applied.document == Revived(document).(ahead := applied.document.ahead))
        && forall effect | effect in applied.effects :: effect.Report?
  {
    assert BaseOf(r).rev == r.id;
  }

  // The rule that leaves the document's base as it was keeps its row in
  // step with its file.
  lemma {:isolate_assertions} RuleOwnKeepsSynced(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                                                 revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires documents[doc].base.Some? && documents[doc].base.value.rev != r.id
    requires Synced(platform, input.listing, documents[doc])
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      var listing' := ListingAfter(platform, input.listing, ruled.effects);
      doc in ruled.documents
      && (Distinct(platform, listing') && ruled.documents[doc].base == documents[doc].base ==>
            Synced(platform, listing', ruled.documents[doc]))
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !(Distinct(platform, listing') && ruled.documents[doc].base == document.base) { return; }
    ApplyKeepsRow(platform, doc, document, r, input, bound, claims, revs[doc]);
    if !HeldForName(document, applied, r) {
      ListingAfterReports(platform, input.listing, ruled.effects);
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      ListingAfterOne(platform, input.listing, ruled.effects[0]);
    } else {
      assert ruled == ClearWay(platform, documents, doc, r, input, revs);
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        assert ruled.documents[doc] == HeadRow(platform, document, r, input, revs[doc]);
        assert false;
      }
      ListingAfterOne(platform, input.listing, ruled.effects[0]);
    }
    assert listing' == input.listing;
    assert ruled.documents[doc] == document.(ahead := ruled.documents[doc].ahead)
        || ruled.documents[doc] == Revived(document).(ahead := ruled.documents[doc].ahead);
  }

  // ---------------------------------------------------------------------
  // The push half: saved contents stay saved, and a chain ends in what the
  // document sends
  // ---------------------------------------------------------------------

  // An untracked content on the pass's listing is saved next to it on the
  // device the push leaves: untracked still, or the push's new document.
  lemma {:isolate_assertions} PushKeepsUntracked(platform: Platform, read: Journal, input: RoundInput, revs: FreshRevs,
                                                 after: Device, h: Hash)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    requires after.platform == platform && ListingOf(after) == input.listing
    requires after.journal.documents == OnPush(platform, read, input, revs).0.documents
    requires UntrackedHolds(platform, read.documents, input.listing, h)
    ensures SavedNextToIt(after, h)
  {
    var p := var p :| p in input.listing && input.listing[p].0 == h
      && forall e | e in read.documents && read.documents[e].binding.Some? :: !SameF(platform, read.documents[e].binding.value.spelling, p); p;
    var created := Created(platform, read, input, revs);
    var creates := Creates(Untracked(platform, read.documents, input.listing), input.freshDocs);
    assert p in after.disk && after.disk[p].content == h;
    if Tracked(after, p) {
      var doc :| BoundTo(after, doc, p);
      assert after.journal.documents[doc] == Seal(created[doc]);
      if doc in read.documents {
        assert created[doc] == read.documents[doc];
        assert false;
      }
      assert doc in creates;
      assert created[doc] == NewDocument(creates[doc], input.listing[creates[doc]], revs[doc]);
      assert NewDocumentAt(after, p);
    }
  }

  // The content a document sends after the push is what its file holds,
  // for a row in step with its file.
  lemma {:isolate_assertions} PushSends(platform: Platform, read: Journal, input: RoundInput, revs: FreshRevs,
                                        after: Device, doc: DocId)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    requires after.platform == platform && ListingOf(after) == input.listing && Distinct(platform, input.listing)
    requires after.journal.documents == OnPush(platform, read, input, revs).0.documents
    requires doc in read.documents && Synced(platform, input.listing, read.documents[doc])
    ensures Outgoing(after, doc) == LocalContent(LocalSide(platform, input.listing, read.documents[doc]))
  {
    var row := read.documents[doc];
    var created := Created(platform, read, input, revs);
    assert created[doc] == row;
    var post := after.journal.documents[doc];
    assert post == Seal(row);
    assert post.binding == row.binding && post.base == row.base;
    if row.binding.Some? {
      var s := row.binding.value.spelling;
      var k := ListedAt(platform, input.listing, s);
      assert k in after.disk && SameF(platform, k, s);
      assert HasFile(after, s);
      var q :| q in after.disk && SameF(platform, q, s) && FileAt(after, s) == after.disk[q];
      if q != k {
        SameFIsEquivalence(platform, q, s, k);
        assert false;
      }
      assert BoundFile(after, doc).value.content == row.binding.value.seen;
    }
  }
}
