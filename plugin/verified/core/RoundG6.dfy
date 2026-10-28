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

}
