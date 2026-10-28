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
  // place of SavedNextToIt on the device the round leaves.
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

  lemma LinkSavedIsLink(after: Device, saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>,
                        r: Revision, x: Option<(Hash, Kind)>)
    requires LinkSaved(saved, d, b, bd, l, r, x)
    requires forall h :: h in saved ==> SavedNextToIt(after, h)
    ensures SettleLink(after, d, b, bd, l, r, x)
  {}

  // The chain so far: settling `rs` in turn from base content `b` (`bd`: a
  // tombstone) and local side `l` leaves the local side `x`, and, where
  // `c` is some, it is one of the chain's contents.
  ghost predicate ChainSaved(saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>, rs: seq<Revision>,
                             x: Option<(Hash, Kind)>, c: Option<Hash>)
    decreases |rs|
  {
    if |rs| == 0 then x == l && (c.None? || c == LocalContent(l))
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
    decreases |rs|
  {
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
    decreases |rs|
  {
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
    decreases |rs|
  {
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
  lemma ChainSavedIsThrough(after: Device, saved: set<Hash>, d: DeviceId, b: Hash, bd: bool, l: Option<(Hash, Kind)>,
                            rs: seq<Revision>, x: Option<(Hash, Kind)>, c: Option<Hash>)
    requires ChainSaved(saved, d, b, bd, l, rs, x, c)
    requires forall h :: h in saved ==> SavedNextToIt(after, h)
    ensures ChainThrough(after, d, b, bd, l, rs, LocalContent(x), c)
    decreases |rs|
  {
    if |rs| > 0 {
      var y := var y :| LinkSaved(saved, d, b, bd, l, rs[0], y)
        && (ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c)
            || (c.Some? && c == LocalContent(l) && ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None))); y;
      LinkSavedIsLink(after, saved, d, b, bd, l, rs[0], y);
      if ChainSaved(saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c) {
        ChainSavedIsThrough(after, saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, c);
      } else {
        ChainSavedIsThrough(after, saved, d, rs[0].content, rs[0].deleted, y, rs[1..], x, None);
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
}
