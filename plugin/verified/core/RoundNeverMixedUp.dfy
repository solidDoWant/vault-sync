// G5_NeverMixedUp of the sync round: the disk frame, and the pass
// invariant that every binding the round leaves names a file of its own
// document (an adopted file holds an accepted live revision).
include "RoundMovesAndRemoves.dfy"

abstract module RoundNeverMixedUp refines RoundMovesAndRemoves {

  // ---------------------------------------------------------------------
  // G5_NeverMixedUp: the disk frame
  // ---------------------------------------------------------------------

  // A file at a name no effect touches (under F) stays as it was, the same
  // file, and no file arrives there. With EffectsUntouchedKeepFile, this
  // holds of any effect sequence, so of any prefix of a round's effects (a
  // crash cut).
  lemma EffectUntouchedKeepsFile(platform: Platform, disk: map<Path, DiskFile>, effect: Effect, disk': map<Path, DiskFile>, s: Path, x: Path)
    requires EffectTakes(platform, disk, effect, disk')
    requires !Touches(platform, effect, s) && SameF(platform, x, s)
    ensures (x in disk <==> x in disk') && (x in disk ==> disk'[x] == disk[x])
  {
    match effect
    case Write(_, path, content, kind, precondition) =>
      if precondition.Some? {
        if exists q :: Holds(platform, disk, q, path, precondition.value) {
          var q := var q :| Holds(platform, disk, q, path, precondition.value)
            && disk' == disk[q := DiskFile(content, kind, disk[q].identity)]; q;
          if q == x { SameFIsEquivalence(platform, path, x, s); SameFIsEquivalence(platform, x, path, s); }
        }
      } else if FreeOn(platform, disk, path) {
        if x == path { SameFIsEquivalence(platform, path, x, s); }
      }
    case Remove(_, path, expected) =>
      if exists q :: Holds(platform, disk, q, path, expected) {
        var q := var q :| Holds(platform, disk, q, path, expected) && disk' == disk - {q}; q;
        if q == x { SameFIsEquivalence(platform, x, path, s); }
      }
    case Move(_, from, to, expected) =>
      if exists q :: MovableTo(platform, disk, q, from, to, expected) {
        var q := var q :| MovableTo(platform, disk, q, from, to, expected) && disk' == (disk - {q})[to := disk[q]]; q;
        if q == x { SameFIsEquivalence(platform, x, from, s); }
        if to == x { SameFIsEquivalence(platform, to, x, s); }
      }
    case _ =>
  }

  lemma EffectsUntouchedKeepFile(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>, s: Path, x: Path)
    requires EffectsTake(platform, disk, effects, disk')
    requires (forall effect :: effect in effects ==> !Touches(platform, effect, s)) && SameF(platform, x, s)
    ensures (x in disk <==> x in disk') && (x in disk ==> disk'[x] == disk[x])
    decreases |effects|
  {
    if |effects| > 0 {
      var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :|
        EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk'); mid;
      assert effects[0] in effects;
      EffectUntouchedKeepsFile(platform, disk, effects[0], mid, s, x);
      assert forall effect :: effect in effects[1..] ==> effect in effects;
      EffectsUntouchedKeepFile(platform, mid, effects[1..], disk', s, x);
    }
  }

  // ---------------------------------------------------------------------
  // G5_NeverMixedUp: the pass invariant
  // ---------------------------------------------------------------------

  // Before the pass's effects so far, `e`'s own file is at `p`: bound to
  // it before the round where nothing touched the name since, or written
  // or moved there for it (RoundOwnName, read on the pass).
  ghost predicate OwnNameIn(platform: Platform, device0: Device, effects: seq<Effect>, e: DocId, p: Path) {
    match RoundPut(platform, effects, p)
    case Untouched => BoundTo(device0, e, p)
    case Freed => false
    case By(j) => (effects[j].Write? && effects[j].target == Some(e)) || (effects[j].Move? && effects[j].mover == Some(e))
  }

  // The file at `p` may be taken as untracked as the pass left it
  // (UntrackedThen, read on the pass; the end of the round decides which
  // case): on disk before the round and untouched since (untracked before
  // the round, or let go: RoundLetGo), or last put there by the pass (for
  // no document, RoundLeftUntracked, or for one that lets it go,
  // RoundLetGo).
  ghost predicate UntrackedIn(platform: Platform, device0: Device, effects: seq<Effect>, p: Path) {
    match RoundPut(platform, effects, p)
    case Untouched => HasFile(device0, p)
    case Freed => false
    case By(j) => true
  }

  // Where a row's bound file came from, for G5: its own file
  // (OwnNameIn), or a file it adopted or took as a new document at a name
  // untracked as the pass left it.
  ghost predicate RowG5(platform: Platform, device0: Device, effects: seq<Effect>, e: DocId, row: Document) {
    row.binding.Some? ==>
      OwnNameIn(platform, device0, effects, e, row.binding.value.spelling)
      || UntrackedIn(platform, device0, effects, row.binding.value.spelling)
  }

  ghost predicate PassG5(platform: Platform, device0: Device, pass: RoundPass) {
    var rows := pass.journal.documents;
    NeverJoinedRows(platform, rows)
    && (forall e | e in rows :: RowG5(platform, device0, pass.effects, e, rows[e]))
    && ListedTaken(platform, device0, pass.effects, pass.listing)
    && ListingOn(platform, pass.listing)
    && DiskFollows(platform, device0.disk, pass.effects, pass.listing)
  }

  // Every disk the pass's effects can leave holds the pass's listing.
  ghost predicate DiskFollows(platform: Platform, disk0: map<Path, DiskFile>, effects: seq<Effect>, listing: Listing) {
    forall disk' | EffectsTake(platform, disk0, effects, disk') :: DiskMap(disk') == listing && OneFilePerName(platform, disk')
  }

  // The invariant holds at the start of the round: every binding names
  // the file bound before it, and a row whose file is missing had none.
  lemma PassG5Start(device0: Device, start: RoundPass, cursor: nat)
    requires start.journal.documents == device0.journal.documents
    requires start.listing == ListingOf(device0) && ListingDistinct(device0.platform, start.listing)
    requires start.effects == [Pull(cursor)]
    requires NeverJoinedRows(device0.platform, start.journal.documents)
    requires OneFilePerName(device0.platform, device0.disk)
    ensures PassG5(device0.platform, device0, start)
  {
    var platform := device0.platform;
    assert DiskMap(device0.disk) == ListingOf(device0);
    forall disk' | EffectsTake(platform, device0.disk, start.effects, disk')
      ensures DiskMap(disk') == start.listing && OneFilePerName(platform, disk')
    {
      var mid := var mid :| EffectTakes(platform, device0.disk, start.effects[0], mid) && EffectsTake(platform, mid, start.effects[1..], disk'); mid;
      assert mid == device0.disk;
    }
    var rows := start.journal.documents;
    ListedTakenStart(device0, cursor);
    forall e | e in rows ensures RowG5(platform, device0, start.effects, e, rows[e]) {
      if rows[e].binding.Some? {
        var s := rows[e].binding.value.spelling;
        assert RoundPut(platform, start.effects, s).Untouched?;
        SameFIsEquivalence(platform, s, s, s);
        assert BoundTo(device0, e, s);
        if !Listed(platform, start.listing, s) {
          assert ListedRead(platform, start.listing, s).None?;
          UnlistedNotOnDisk(device0, s);
        }
      }
    }
  }

  // Create binds without putting the document's file only by adoption.
  lemma {:isolate_assertions} CreateAdoption(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing) && !r.deleted && document.binding.None?
    ensures var applied := Create(platform, doc, document, r, input, bound, claims, rev);
      (applied.document.binding.Some?
       && !(exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, applied.document.binding.value.spelling))) ==>
        applied.effects == [] && applied.document.binding.value.spelling == r.path
        && !BoundName(platform, bound, r.path)
        && ListedRead(platform, input.listing, r.path) == Some((r.content, r.kind))
        && applied.document.base == Some(BaseOf(r))
        && (document.base.None? || document.base.value.rev != r.id)
  {
    var applied := Create(platform, doc, document, r, input, bound, claims, rev);
    assert SameF(platform, r.path, r.path);
    if UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path) {
    } else if FreeIn(platform, input.listing, r.path) {
      assert applied.effects[0] in applied.effects;
    } else if Adoptable(platform, document, input, r) {
      ListedAtSelf(platform, input.listing, r.path);
      assert ListedRead(platform, input.listing, r.path) == Some(input.listing[r.path]);
    } else {
      var held := Colliders(platform, input.listing, r.path);
      if |held| == 1 && !BoundName(platform, bound, LeastPath(held))
         && !UnsavedCollides(platform, input.unsaved, LeastPath(held)) {
        var q := LeastPath(held);
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, q, r.path);
        if copy.Some? {
          assert applied.effects[1] in applied.effects;
        }
      }
    }
  }

  // The apply changes its row's binding without an effect only by
  // adoption (G5 (d)): the row had no file in the listing, and the file
  // at the head's name, bound to no row, holds exactly the head, which
  // becomes the base.
  lemma {:isolate_assertions} ApplyAdoption(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      (applied.document.binding.Some?
       && !(exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, applied.document.binding.value.spelling))
       && (document.binding.None? || applied.document.binding.value.spelling != document.binding.value.spelling)) ==>
        var s := applied.document.binding.value.spelling;
        applied.effects == []
        && (document.binding.None? || ListedRead(platform, input.listing, document.binding.value.spelling).None?)
        && !BoundName(platform, bound, s) && s == r.path && !r.deleted
        && ListedRead(platform, input.listing, s) == Some((r.content, r.kind))
        && applied.document.base == Some(BaseOf(r))
        && (document.base.None? || document.base.value.rev != r.id)
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    if !Newer(document, r) {
    } else if SettlesIdentical(platform, document, r, input) {
    } else if Acknowledges(document, r) {
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreateAdoption(platform, doc, Revived(document), r, input, bound, claims, rev);
      }
    } else if document.binding.Some? {
      // The binding keeps its name, or is dropped.
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
      } else if r.deleted && read.None? {
      } else if Concurrent(document, read, r) {
        var settled := Settle(platform, doc, document, read.value, r, input, bound, claims, rev);
        assert settled.document.binding.None? || settled.document.binding.value.spelling == spelling;
      }
    } else if r.deleted {
    } else {
      CreateAdoption(platform, doc, document, r, input, bound, claims, rev);
    }
  }

  // The rule binds a row to a file it did not put there for it, at a name
  // other than the row's untouched own, only by the apply's adoption.
  lemma {:isolate_assertions} RuleAdopt(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents
      && var after := ruled.documents[e];
      (after.binding.Some?
       && !(exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, after.binding.value.spelling))
       && !(documents[e].binding.Some? && after.binding.value.spelling == documents[e].binding.value.spelling
            && forall effect :: effect in ruled.effects ==> !Touches(platform, effect, after.binding.value.spelling))) ==>
        var s := after.binding.value.spelling;
        var document := documents[doc];
        e == doc && ruled.effects == []
        && (document.binding.None? || ListedRead(platform, input.listing, document.binding.value.spelling).None?)
        && !BoundName(platform, BoundNames(documents), s) && s == r.path && !r.deleted
        && ListedRead(platform, input.listing, s) == Some((r.content, r.kind))
        && after.base == Some(BaseOf(r))
        && (document.base.None? || document.base.value.rev != r.id)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    RuleOrigin(platform, documents, doc, r, input, revs, first, e);
    if !HeldForName(document, applied, r) {
      if e == doc {
        ApplyAdoption(platform, doc, document, r, input, bound, claims, revs[doc]);
        var after := ruled.documents[e];
        ApplyOrigin(platform, doc, document, r, input, bound, claims, revs[doc]);
      }
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      HeldKeepsBinding(platform, doc, document, r, input, bound, claims, revs[doc]);
    } else if e == doc {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      assert ruled == ClearWay(platform, documents, doc, r, input, revs);
      if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        assert ruled.documents[e].binding == documents[e].binding;
        return;
      }
      var moves := aside.value;
      var front := MoveEffects(platform, documents, doc, moves);
      var arrive := ArriveOf(platform, doc, document, r, input);
      assert ruled.effects == front + arrive;
      assert ruled.documents == ClearRows(platform, documents, doc, r, input, moves, revs);
      assert ruled.documents[doc].binding.Some? && ruled.documents[doc].binding.value.spelling == r.path;
      var a := Arriving(platform, document, r, input);
      ArrivePutsHead(platform, doc, ArrivingRow(platform, document, r, input), a, keep);
      var effect := var effect :| effect in arrive && PutsFor(platform, effect, doc, a.path); effect;
      assert effect in ruled.effects;
    }
  }

  // Effects that do not touch `s` leave what the earlier ones put there.
  lemma RoundPutUntouchedTail(platform: Platform, a: seq<Effect>, b: seq<Effect>, s: Path)
    requires forall effect :: effect in b ==> !Touches(platform, effect, s)
    ensures RoundPut(platform, a + b, s) == RoundPut(platform, a, s)
    decreases |b|
  {
    if |b| > 0 {
      var ab := a + b;
      assert ab[..|ab| - 1] == a + b[..|b| - 1];
      assert b[|b| - 1] in b;
      assert forall effect :: effect in b[..|b| - 1] ==> effect in b;
      RoundPutUntouchedTail(platform, a, b[..|b| - 1], s);
    } else {
      assert a + b == a;
    }
  }

  // The last effect that touches `s` decides what is there.
  lemma RoundPutLastTouch(platform: Platform, a: seq<Effect>, b: seq<Effect>, s: Path, m: nat)
    requires m < |b| && Touches(platform, b[m], s)
    requires forall k | m < k < |b| :: !Touches(platform, b[k], s)
    ensures RoundPut(platform, a + b, s) == RoundPut(platform, a + b[..m + 1], s)
    ensures var put := RoundPut(platform, a + b[..m + 1], s);
      (PutsTracked(platform, b[m], s) || (b[m].Write? && SameF(platform, b[m].path, s)) || (b[m].Move? && SameF(platform, b[m].to, s)))
        ==> put == By(|a| + m)
  {
    var c := a + b[..m + 1];
    var d := b[m + 1..];
    SplitAt(a, b, m);
    TailUntouched(platform, b, s, m);
    RoundPutUntouchedTail(platform, c, d, s);
    RoundPutLastIs(platform, c, s);
  }

  lemma SplitAt(a: seq<Effect>, b: seq<Effect>, m: nat)
    requires m < |b|
    ensures a + b == (a + b[..m + 1]) + b[m + 1..]
    ensures |a + b[..m + 1]| == |a| + m + 1 && (a + b[..m + 1])[|a| + m] == b[m]
  {
    assert b == b[..m + 1] + b[m + 1..];
  }

  lemma TailUntouched(platform: Platform, b: seq<Effect>, s: Path, m: nat)
    requires m < |b|
    requires forall k | m < k < |b| :: !Touches(platform, b[k], s)
    ensures forall effect :: effect in b[m + 1..] ==> !Touches(platform, effect, s)
  {
    forall effect | effect in b[m + 1..] ensures !Touches(platform, effect, s) {
      var k := var k :| 0 <= k < |b[m + 1..]| && b[m + 1..][k] == effect; k;
      assert effect == b[m + 1 + k];
    }
  }

  // A last effect that puts a file at `s` is what is there.
  lemma RoundPutLastIs(platform: Platform, c: seq<Effect>, s: Path)
    requires |c| > 0
    ensures var last := c[|c| - 1];
      ((last.Write? && SameF(platform, last.path, s)) || (last.Move? && SameF(platform, last.to, s)))
        ==> RoundPut(platform, c, s) == By(|c| - 1)
  {}


  // Where the apply puts the document's file at its new binding, that put
  // is its last effect: a write of the document's file at that name.
  lemma {:isolate_assertions} CreatePutsLast(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := Create(platform, doc, document, r, input, bound, claims, rev);
      (applied.document.binding.Some?
       && exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, applied.document.binding.value.spelling)) ==>
        |applied.effects| > 0
        && applied.effects[|applied.effects| - 1].Write?
        && applied.effects[|applied.effects| - 1].target == Some(doc)
        && applied.effects[|applied.effects| - 1].path == applied.document.binding.value.spelling
  {
    var applied := Create(platform, doc, document, r, input, bound, claims, rev);
    if UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path) {
    } else if FreeIn(platform, input.listing, r.path) {
    } else if Adoptable(platform, document, input, r) {
    } else {
      var held := Colliders(platform, input.listing, r.path);
      if |held| == 1 && !BoundName(platform, bound, LeastPath(held))
         && !UnsavedCollides(platform, input.unsaved, LeastPath(held)) {
        var q := LeastPath(held);
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, q, r.path);
      }
    }
  }

  lemma {:isolate_assertions} ApplyPutsLast(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      (applied.document.binding.Some?
       && exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, applied.document.binding.value.spelling)) ==>
        |applied.effects| > 0
        && applied.effects[|applied.effects| - 1].Write?
        && applied.effects[|applied.effects| - 1].target == Some(doc)
        && applied.effects[|applied.effects| - 1].path == applied.document.binding.value.spelling
  {
    if !Newer(document, r) {
    } else if SettlesIdentical(platform, document, r, input) {
    } else if Acknowledges(document, r) {
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreatePutsLast(platform, doc, Revived(document), r, input, bound, claims, rev);
      }
    } else if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
      } else if r.deleted && read.None? {
      } else if Concurrent(document, read, r) {
        var settled := Settle(platform, doc, document, read.value, r, input, bound, claims, rev);
        assert settled.document.binding.None? || settled.document.binding.value.spelling == spelling;
      }
    } else if r.deleted {
    } else {
      CreatePutsLast(platform, doc, document, r, input, bound, claims, rev);
    }
  }

  // The arrival ends with the put of the document's file at the head's name.
  lemma ArriveLast(platform: Platform, doc: DocId, document: Document, a: Revision, own: Option<Path>)
    ensures var effects := Arrive(platform, doc, document, a, own);
      |effects| > 0
      && var last := effects[|effects| - 1];
      (last.Write? && last.target == Some(doc) && last.path == a.path)
      || (last.Move? && last.mover == Some(doc) && last.to == a.path)
  {}

  // A move aside moves the file of the row it names, if any.
  lemma MoveEffectsMoverOwns(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, i: nat, x: DocId)
    requires i < |moves|
    requires var effects := MoveEffects(platform, documents, doc, moves);
      i < |effects| && effects[i].Move? && effects[i].mover == Some(x)
    ensures x != doc && FileOf(platform, documents, moves[i].0, x)
    decreases |moves|
  {
    MoveEffectsShape(platform, documents, doc, moves);
    if i > 0 {
      assert MoveEffects(platform, documents, doc, moves)[i] == MoveEffects(platform, documents, doc, moves[1..])[i - 1];
      MoveEffectsShape(platform, documents, doc, moves[1..]);
      MoveEffectsMoverOwns(platform, documents, doc, moves[1..], i - 1, x);
    } else {
      var q := moves[0].0;
      var keepers := set e' | e' in documents && e' != doc && FileOf(platform, documents, q, e') && LocallyPlaced(documents[e']);
      assert keepers != {};
      assert x == LeastDoc(keepers);
    }
  }

  // The arrival writes and moves only the document's own file.
  lemma ArriveFor(platform: Platform, doc: DocId, document: Document, a: Revision, own: Option<Path>)
    ensures forall effect :: effect in Arrive(platform, doc, document, a, own) ==>
      (effect.Write? ==> effect.target == Some(doc)) && (effect.Move? ==> effect.mover == Some(doc))
  {}

  // Where the rule clears the way, the effect that puts a row's file at
  // its new binding is the last one touching that name.
  lemma {:isolate_assertions} ClearWayPutsLast(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      e in ruled.documents
      && var after := ruled.documents[e];
      (after.binding.Some?
       && exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, after.binding.value.spelling)) ==>
        var s := after.binding.value.spelling;
        exists m :: 0 <= m < |ruled.effects|
          && ((ruled.effects[m].Write? && ruled.effects[m].target == Some(e) && SameF(platform, ruled.effects[m].path, s))
              || (ruled.effects[m].Move? && ruled.effects[m].mover == Some(e) && SameF(platform, ruled.effects[m].to, s)))
          && forall k | m < k < |ruled.effects| :: !Touches(platform, ruled.effects[k], s)
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
    var a := Arriving(platform, document, r, input);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    var rows := ruled.documents;
    assert rows == ClearRows(platform, documents, doc, r, input, moves, revs);
    MoveRowsRow(platform, documents, doc, moves, revs, input.listing, e);
    if rows[e].binding.None? { return; }
    var s := rows[e].binding.value.spelling;
    if !exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, s) { return; }
    if e == doc {
      assert s == r.path;
      ArriveLast(platform, doc, ArrivingRow(platform, document, r, input), a, keep);
      var m := |ruled.effects| - 1;
      assert ruled.effects[m] == arrive[|arrive| - 1];
      assert SameF(platform, r.path, r.path);
      return;
    }
    ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e);
    if exists i | 0 <= i < |moves| :: s == moves[i].1 && FileOf(platform, documents, moves[i].0, e) {
      var i := var i :| 0 <= i < |moves| && s == moves[i].1 && FileOf(platform, documents, moves[i].0, e); i;
      var moved := MoveRows(platform, documents, doc, moves, revs);
      assert LocallyPlaced(documents[e]) by {
        if !LocallyPlaced(documents[e]) {
          assert moved[e] == MovedAside(documents[e], moves[i].1, revs[e]);
          var recorded := RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs);
          assert rows[e] == recorded[e];
        }
      }
      MoveEffectsMover(platform, documents, doc, moves, i, e);
      assert ruled.effects[i] == front[i];
      assert SameF(platform, moves[i].1, s);
      forall k | i < k < |ruled.effects| ensures !Touches(platform, ruled.effects[k], s) {
        if k < |front| {
          assert ruled.effects[k] == front[k];
          assert !CollideF(platform, moves[i].1, moves[k].1);
          assert moves[k].0 in input.listing;
          assert !CollideF(platform, moves[k].0, moves[i].1);
        } else {
          var t := documents[e].binding.value.spelling;
          assert ruled.effects[k] in arrive;
          assert !CollideF(platform, moves[i].1, r.path);
          if keep.Some? {
            var b := document.binding.value.spelling;
            assert SameF(platform, keep.value, b);
            assert b in avoid;
            assert !SameF(platform, b, moves[i].1);
            if SameF(platform, keep.value, s) { SameFIsEquivalence(platform, b, keep.value, s); }
          }
          ArriveTouchesOnly(platform, doc, ArrivingRow(platform, document, r, input), a, keep, s);
        }
      }
    } else {
      // Left as it was: no effect puts its file anywhere for it.
      assert rows[e].binding == documents[e].binding;
      ArriveFor(platform, doc, ArrivingRow(platform, document, r, input), a, keep);
      forall effect | effect in ruled.effects ensures !PutsFor(platform, effect, e, s) {
        if effect in front {
          var i := var i :| 0 <= i < |front| && front[i] == effect; i;
          if effect.mover == Some(e) {
            MoveEffectsMoverOwns(platform, documents, doc, moves, i, e);
          }
        } else {
          assert effect in arrive;
        }
      }
    }
  }

  // The effect that puts a row's file at its binding is the rule's last
  // one touching that name (OwnNameIn's By(j), read on the pass).
  lemma {:isolate_assertions} RulePutsLast(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents
      && var after := ruled.documents[e];
      (after.binding.Some?
       && exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, after.binding.value.spelling)) ==>
        var s := after.binding.value.spelling;
        exists m :: 0 <= m < |ruled.effects|
          && ((ruled.effects[m].Write? && ruled.effects[m].target == Some(e) && SameF(platform, ruled.effects[m].path, s))
              || (ruled.effects[m].Move? && ruled.effects[m].mover == Some(e) && SameF(platform, ruled.effects[m].to, s)))
          && forall k | m < k < |ruled.effects| :: !Touches(platform, ruled.effects[k], s)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      if e == doc {
        ApplyPutsLast(platform, doc, document, r, input, bound, claims, revs[doc]);
        var after := ruled.documents[e];
        if after.binding.Some? && exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, after.binding.value.spelling) {
          assert SameF(platform, after.binding.value.spelling, after.binding.value.spelling);
          assert ruled.effects[|ruled.effects| - 1] == applied.effects[|applied.effects| - 1];
        }
      } else if documents[e].binding.Some? {
        var t := documents[e].binding.value.spelling;
        assert t in bound;
        ApplyLeavesOthers(platform, doc, document, r, input, bound, claims, revs[doc], t);
        assert ruled.documents[e] == documents[e];
      }
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
    } else {
      ClearWayPutsLast(platform, documents, doc, r, input, revs, e);
    }
  }

  // A put for `e` at `s` that no later effect touches makes `s` e's own
  // name after all of them.
  lemma LastPutOwnName(platform: Platform, device0: Device, a: seq<Effect>, b: seq<Effect>, e: DocId, s: Path, m: nat)
    requires m < |b|
    requires (b[m].Write? && b[m].target == Some(e) && SameF(platform, b[m].path, s))
             || (b[m].Move? && b[m].mover == Some(e) && SameF(platform, b[m].to, s))
    requires forall k | m < k < |b| :: !Touches(platform, b[k], s)
    ensures OwnNameIn(platform, device0, a + b, e, s)
  {
    assert Touches(platform, b[m], s);
    RoundPutLastTouch(platform, a, b, s, m);
    assert (a + b)[|a| + m] == b[m];
  }

  // Effects that do not touch `s` keep what the pass read at `s`.
  lemma UntouchedTailKeepsReadings(platform: Platform, device0: Device, a: seq<Effect>, b: seq<Effect>, e: DocId, s: Path)
    requires forall effect :: effect in b ==> !Touches(platform, effect, s)
    ensures OwnNameIn(platform, device0, a + b, e, s) == OwnNameIn(platform, device0, a, e, s)
    ensures UntrackedIn(platform, device0, a + b, s) == UntrackedIn(platform, device0, a, s)
  {
    RoundPutUntouchedTail(platform, a, b, s);
    var put := RoundPut(platform, a, s);
    if put.By? { assert (a + b)[put.index] == a[put.index]; }
  }

  // Names the same under F read the same.
  lemma RoundPutSameF(platform: Platform, effects: seq<Effect>, p: Path, q: Path)
    requires SameF(platform, p, q)
    ensures RoundPut(platform, effects, p) == RoundPut(platform, effects, q)
    decreases |effects|
  {
    if |effects| > 0 {
      var last := effects[|effects| - 1];
      SameFIsEquivalence(platform, p, q, q);
      if last.Write? { SameFIsEquivalence(platform, last.path, p, q); SameFIsEquivalence(platform, last.path, q, p); }
      if last.Remove? { SameFIsEquivalence(platform, last.path, p, q); SameFIsEquivalence(platform, last.path, q, p); }
      if last.Move? {
        SameFIsEquivalence(platform, last.to, p, q); SameFIsEquivalence(platform, last.to, q, p);
        SameFIsEquivalence(platform, last.from, p, q); SameFIsEquivalence(platform, last.from, q, p);
      }
      RoundPutSameF(platform, effects[..|effects| - 1], p, q);
    }
  }

  // Every name the pass's listing lists may be taken as untracked as the
  // pass left it (UntrackedIn): a listed name is never freed, and listed
  // and untouched it is on disk before the round.
  ghost predicate ListedTaken(platform: Platform, device0: Device, effects: seq<Effect>, listing: Listing) {
    Distinct(platform, listing) ==> forall s :: Listed(platform, listing, s) ==> UntrackedIn(platform, device0, effects, s)
  }

  lemma ListedTakenStart(device0: Device, cursor: nat)
    requires ListingDistinct(device0.platform, ListingOf(device0))
    ensures ListedTaken(device0.platform, device0, [Pull(cursor)], ListingOf(device0))
  {
    forall s | Listed(device0.platform, ListingOf(device0), s)
      ensures UntrackedIn(device0.platform, device0, [Pull(cursor)], s)
    {
      var q := var q :| q in ListingOf(device0) && SameF(device0.platform, q, s); q;
      assert q in device0.disk;
      assert RoundPut(device0.platform, [Pull(cursor)], s).Untouched?;
    }
  }

  // A freed name is not listed after the effect that freed it.
  lemma FreedUnlisted(platform: Platform, listing: Listing, effect: Effect, s: Path)
    requires Distinct(platform, listing)
    requires (effect.Remove? && SameF(platform, effect.path, s))
             || (effect.Move? && SameF(platform, effect.from, s) && !SameF(platform, effect.to, s))
    ensures !Listed(platform, ListingAfterEffect(platform, listing, effect), s)
  {
    var after := ListingAfterEffect(platform, listing, effect);
    var p := if effect.Remove? then effect.path else effect.from;
    if k :| k in after && SameF(platform, k, s) {
      SameFIsEquivalence(platform, k, s, p);
      SameFIsEquivalence(platform, p, s, k);
      if Listed(platform, listing, p) {
        var q := ListedAt(platform, listing, p);
        SameFIsEquivalence(platform, q, p, k);
        if effect.Move? && k == effect.to {
          SameFIsEquivalence(platform, k, s, s);
        }
      } else {
        assert k in listing;
      }
    }
  }

  lemma ListedTakenStep(platform: Platform, device0: Device, effects: seq<Effect>, listing: Listing, effect: Effect)
    requires ListedTaken(platform, device0, effects, listing)
    ensures ListedTaken(platform, device0, effects + [effect], ListingAfterEffect(platform, listing, effect))
  {
    var after := ListingAfterEffect(platform, listing, effect);
    var effects' := effects + [effect];
    assert effects'[..|effects'| - 1] == effects;
    assert effects'[|effects'| - 1] == effect;
    if Distinct(platform, after) && Distinct(platform, listing) {
      forall s | Listed(platform, after, s) ensures UntrackedIn(platform, device0, effects', s) {
        if !Touches(platform, effect, s) {
          ListingEffectUntouched(platform, listing, effect, s);
          assert RoundPut(platform, effects', s) == RoundPut(platform, effects, s);
        } else if (effect.Write? && SameF(platform, effect.path, s)) || (effect.Move? && SameF(platform, effect.to, s)) {
          assert RoundPut(platform, effects', s).By?;
        } else {
          FreedUnlisted(platform, listing, effect, s);
        }
      }
    } else if !Distinct(platform, listing) {
      assert after == listing;
    }
  }

  lemma ListedTakenAfter(platform: Platform, device0: Device, effects: seq<Effect>, listing: Listing, more: seq<Effect>)
    requires ListedTaken(platform, device0, effects, listing)
    ensures ListedTaken(platform, device0, effects + more, ListingAfter(platform, listing, more))
    decreases |more|
  {
    if |more| == 0 {
      assert effects + more == effects;
    } else {
      ListedTakenStep(platform, device0, effects, listing, more[0]);
      ListedTakenAfter(platform, device0, effects + [more[0]], ListingAfterEffect(platform, listing, more[0]), more[1..]);
      assert (effects + [more[0]]) + more[1..] == effects + more;
    }
  }

  // Settling one revision keeps the G5 pass invariant: a row the rule
  // puts a file for owns its name (RulePutsLast, LastPutOwnName), a row
  // the rule left at an untouched name keeps what the pass read there,
  // and an adoption takes a listed name (RuleAdopt, ListedTaken).
  lemma {:isolate_assertions} SettleKeepsG5(platform: Platform, device0: Device, pass: RoundPass,
                                            doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass)
    ensures PassG5(platform, device0, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    if !Distinct(platform, pass.listing) { return; }
    if r.path in input.outOfScope {
      if Newer(row, r) {
        var rows' := settled.journal.documents;
        assert rows' == documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))];
        assert forall e | e in rows' :: (e in documents && rows'[e].binding == documents[e].binding)
                                        || rows'[e].binding.None?;
        assert settled.listing == pass.listing && settled.effects == pass.effects;
        assert NeverJoinedRows(platform, rows');
        forall e | e in rows' ensures RowG5(platform, device0, settled.effects, e, rows'[e]) {
          if rows'[e].binding.Some? { assert RowG5(platform, device0, pass.effects, e, documents[e]); }
        }
      }
      return;
    }
    var rows := documents[doc := row];
    assert NeverJoinedRows(platform, rows);
    forall e | e in rows ensures RowG5(platform, device0, pass.effects, e, rows[e]) {
      if e in documents && rows[e] == documents[e] { assert RowG5(platform, device0, pass.effects, e, documents[e]); }
    }
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    var intents := IntentsFor(doc, r, ruled.effects, pass.n);
    var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
    var effects' := pass.effects + guard + ruled.effects;
    // Once, here: inside the per-row forall below the solver's search for
    // this sequence identity timed out on some seeds.
    assert effects' == pass.effects + (guard + ruled.effects);
    var listing' := ListingAfter(platform, pass.listing, ruled.effects);
    assert settled.journal.documents == ruled.documents && settled.effects == effects' && settled.listing == listing';
    RuleKeepsNeverJoined(platform, rows, doc, r, inner, revs', first);
    RuleDeleteSeen(platform, rows, doc, r, inner, revs', first);
    RuleKeepsListingOn(platform, pass.listing, rows, doc, r, input, revs', first);
    forall disk'' | EffectsTake(platform, device0.disk, effects', disk'')
      ensures DiskMap(disk'') == listing' && OneFilePerName(platform, disk'')
    {
      EffectsTakeSplit(platform, device0.disk, pass.effects + guard, ruled.effects, disk'');
      var mid1 := var mid1 :| EffectsTake(platform, device0.disk, pass.effects + guard, mid1) && EffectsTake(platform, mid1, ruled.effects, disk''); mid1;
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
      EffectsDiskMap(platform, mid1, ruled.effects, disk'');
    }
    forall effect | effect in guard ensures !Touches(platform, effect, r.path) && effect.PersistJournal? { }
    assert ListingAfter(platform, pass.listing, guard) == pass.listing;
    ListedTakenAfter(platform, device0, pass.effects, pass.listing, guard);
    ListedTakenAfter(platform, device0, pass.effects + guard, pass.listing, ruled.effects);
    forall e | e in ruled.documents ensures RowG5(platform, device0, effects', e, ruled.documents[e]) {
      var after := ruled.documents[e];
      if after.binding.Some? {
        var s := after.binding.value.spelling;
        if exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, s) {
          RulePutsLast(platform, rows, doc, r, inner, revs', first, e);
          var m := var m :| 0 <= m < |ruled.effects|
            && ((ruled.effects[m].Write? && ruled.effects[m].target == Some(e) && SameF(platform, ruled.effects[m].path, s))
                || (ruled.effects[m].Move? && ruled.effects[m].mover == Some(e) && SameF(platform, ruled.effects[m].to, s)))
            && forall k | m < k < |ruled.effects| :: !Touches(platform, ruled.effects[k], s); m;
          LastPutOwnName(platform, device0, pass.effects + guard, ruled.effects, e, s, m);
        } else if rows[e].binding.Some? && s == rows[e].binding.value.spelling
                  && forall effect :: effect in ruled.effects ==> !Touches(platform, effect, s) {
          assert RowG5(platform, device0, pass.effects, e, rows[e]);
          forall effect | effect in guard + ruled.effects ensures !Touches(platform, effect, s) {
            if effect in guard { assert effect.PersistJournal?; } else { assert effect in ruled.effects; }
          }
          UntouchedTailKeepsReadings(platform, device0, pass.effects, guard + ruled.effects, e, s);
        } else {
          RuleAdopt(platform, rows, doc, r, inner, revs', first, e);
          assert ruled.effects == [] && s == r.path;
          assert Listed(platform, pass.listing, s);
          assert listing' == pass.listing;
        }
      }
    }
  }

  lemma SettlePulledKeepsG5(platform: Platform, device0: Device, pass: RoundPass,
                            revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass)
    ensures PassG5(platform, device0, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsG5(platform, device0, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettlePulledKeepsG5(platform, device0, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsG5(platform: Platform, device0: Device, pass: RoundPass,
                     docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass)
    ensures PassG5(platform, device0, RetryWaiting(platform, pass, docs, input, revs, first))
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
        SettleKeepsG5(platform, device0, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryKeepsG5(platform, device0, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsG5(platform, device0, pass, docs[1..], input, revs, first);
      }
    }
  }

  // The push keeps where each row's bound file came from: it seals
  // outboxes, and a new document is bound to a listed name of the pass
  // (ListedTaken), and its effects touch no file.
  lemma {:isolate_assertions} PushKeepsG5(platform: Platform, device0: Device, settled: RoundPass, read: Journal, input: RoundInput, revs: FreshRevs)
    requires device0.platform == platform
    requires PassG5(platform, device0, settled) && read.documents == settled.journal.documents
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures var push := OnPush(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
      forall e | e in push.0.documents :: RowG5(platform, device0, settled.effects + push.1, e, push.0.documents[e])
  {
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    var push := OnPush(platform, read, input', revs);
    var created := Created(platform, read, input', revs);
    var disk := var disk :| OneFilePerName(platform, disk) && DiskMap(disk) == settled.listing; disk;
    OneFileDistinct(platform, disk);
    PushTouchesNoFile(platform, read, input', revs);
    forall e | e in push.0.documents ensures RowG5(platform, device0, settled.effects + push.1, e, push.0.documents[e]) {
      assert push.0.documents[e] == Seal(created[e]);
      var row := push.0.documents[e];
      if row.binding.Some? {
        var s := row.binding.value.spelling;
        forall effect | effect in push.1 ensures !Touches(platform, effect, s) { }
        UntouchedTailKeepsReadings(platform, device0, settled.effects, push.1, e, s);
        if e in read.documents {
          assert RowG5(platform, device0, settled.effects, e, settled.journal.documents[e]);
        } else {
          var creates := Creates(Untracked(platform, read.documents, input'.listing), input'.freshDocs);
          assert s == creates[e];
          assert s in settled.listing;
          SameFIsEquivalence(platform, s, s, s);
          assert Listed(platform, settled.listing, s);
        }
      }
    }
  }

  // A name the round's effects left untouched (RoundPut) is touched by
  // none of them.
  lemma UntouchedNoTouch(platform: Platform, effects: seq<Effect>, s: Path)
    requires RoundPut(platform, effects, s).Untouched?
    ensures forall effect :: effect in effects ==> !Touches(platform, effect, s)
    decreases |effects|
  {
    if |effects| > 0 {
      var init := effects[..|effects| - 1];
      UntouchedNoTouch(platform, init, s);
      assert effects == init + [effects[|effects| - 1]];
    }
  }

  // At a name the round's effects left untouched, the device after holds
  // the same file as before, or none as before (disks distinct under F).
  lemma UntouchedSameFile(before: Device, after: Device, effects: seq<Effect>, s: Path)
    requires after.platform == before.platform
    requires EffectsTake(before.platform, before.disk, effects, after.disk)
    requires ListingDistinct(before.platform, ListingOf(before)) && ListingDistinct(after.platform, ListingOf(after))
    requires RoundPut(before.platform, effects, s).Untouched?
    ensures HasFile(before, s) <==> HasFile(after, s)
    ensures HasFile(before, s) ==> FileAt(before, s) == FileAt(after, s)
  {
    var platform := before.platform;
    UntouchedNoTouch(platform, effects, s);
    forall x | SameF(platform, x, s) ensures (x in before.disk <==> x in after.disk) && (x in before.disk ==> after.disk[x] == before.disk[x]) {
      EffectsUntouchedKeepFile(platform, before.disk, effects, after.disk, s, x);
    }
    if HasFile(before, s) {
      var q := var q :| q in before.disk && SameF(platform, q, s) && FileAt(before, s) == before.disk[q]; q;
      var k := var k :| k in after.disk && SameF(platform, k, s) && FileAt(after, s) == after.disk[k]; k;
      assert q in ListingOf(after) && k in ListingOf(after);
      if q != k {
        SameFIsEquivalence(platform, q, s, k);
        SameFIsEquivalence(platform, k, s, q);
      }
    }
  }

  // ---------------------------------------------------------------------
  // The pass's listing is the disk its effects leave (for G5's content)
  // ---------------------------------------------------------------------

  // Where its precondition holds on a disk with one file per name, an
  // effect leaves a disk whose contents are the listing after it.
  lemma {:isolate_assertions} EffectDiskMap(platform: Platform, disk: map<Path, DiskFile>, e: Effect, m: map<Path, DiskFile>)
    requires OneFilePerName(platform, disk) && PreconditionHolds(platform, disk, e) && EffectTakes(platform, disk, e, m)
    ensures DiskMap(m) == ListingAfterEffect(platform, DiskMap(disk), e) && OneFilePerName(platform, m)
  {
    var listing := DiskMap(disk);
    OneFileDistinct(platform, disk);
    EffectKeepsOneFilePerName(platform, disk, e, m);
    match e
    case Write(_, path, content, kind, precondition) =>
      if precondition.Some? {
        var q := var q :| Holds(platform, disk, q, path, precondition.value)
          && m == disk[q := DiskFile(content, kind, disk[q].identity)]; q;
        assert q in listing && SameF(platform, q, path);
        assert ListedAt(platform, listing, path) == q;
        assert DiskMap(m) == listing[q := (content, kind)];
      } else {
        assert !Listed(platform, listing, path) by {
          forall q | q in listing ensures !SameF(platform, q, path) {
            assert !CollideF(platform, q, path);
          }
        }
        var identity: FileIdentity := var identity: FileIdentity :| (forall q :: q in disk ==> disk[q].identity != identity)
          && m == disk[path := DiskFile(content, kind, identity)]; identity;
        assert DiskMap(m) == listing[path := (content, kind)];
      }
    case Remove(_, path, expected) =>
      var q := var q :| Holds(platform, disk, q, path, expected) && m == disk - {q}; q;
      assert q in listing && SameF(platform, q, path);
      assert ListedAt(platform, listing, path) == q;
      assert DiskMap(m) == listing - {q};
    case Move(_, from, to, expected) =>
      var q := var q :| MovableTo(platform, disk, q, from, to, expected) && m == (disk - {q})[to := disk[q]]; q;
      assert q in listing && SameF(platform, q, from);
      assert ListedAt(platform, listing, from) == q;
      assert DiskMap(m) == (listing - {q})[to := listing[q]];
    case _ =>
  }

  lemma EffectsDiskMap(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>)
    requires OneFilePerName(platform, disk) && PreconditionsInOrder(platform, disk, effects) && EffectsTake(platform, disk, effects, disk')
    ensures DiskMap(disk') == ListingAfter(platform, DiskMap(disk), effects) && OneFilePerName(platform, disk')
    decreases |effects|
  {
    if |effects| > 0 {
      var mid := var mid :| EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk'); mid;
      EffectDiskMap(platform, disk, effects[0], mid);
      EffectsDiskMap(platform, mid, effects[1..], disk');
    }
  }

  // ---------------------------------------------------------------------
  // G5 (d) content: an adopted file holds an accepted live revision
  // ---------------------------------------------------------------------

  // A row bound to a file that is not its own (an adoption) at a listed
  // name: the listing reads there a live revision of the row's document
  // the server accepted.
  ghost predicate RowContent(platform: Platform, device0: Device, accepted: map<RevId, Revision>, effects: seq<Effect>,
                             listing: Listing, e: DocId, row: Document) {
    (row.binding.Some? && Distinct(platform, listing)
     && !OwnNameIn(platform, device0, effects, e, row.binding.value.spelling)
     && Listed(platform, listing, row.binding.value.spelling)) ==>
      AcceptedContent(accepted, e, ListedRead(platform, listing, row.binding.value.spelling).value.0)
  }

  ghost predicate PassContent(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass) {
    forall e | e in pass.journal.documents ::
      RowContent(platform, device0, accepted, pass.effects, pass.listing, e, pass.journal.documents[e])
  }

  lemma PassContentStart(device0: Device, accepted: map<RevId, Revision>, start: RoundPass, cursor: nat)
    requires start.journal.documents == device0.journal.documents
    requires start.effects == [Pull(cursor)]
    ensures PassContent(device0.platform, device0, accepted, start)
  {
    var platform := device0.platform;
    forall e | e in start.journal.documents
      ensures RowContent(platform, device0, accepted, start.effects, start.listing, e, start.journal.documents[e])
    {
      var row := start.journal.documents[e];
      if row.binding.Some? {
        var s := row.binding.value.spelling;
        assert RoundPut(platform, start.effects, s).Untouched?;
        SameFIsEquivalence(platform, s, s, s);
        assert BoundTo(device0, e, s);
      }
    }
  }

  lemma {:isolate_assertions} SettleKeepsContent(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                                                 doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && PassContent(platform, device0, accepted, pass)
    requires AcceptedAs(accepted, r) && r.doc == doc
    ensures PassContent(platform, device0, accepted, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    if !Distinct(platform, pass.listing) { return; }
    if r.path in input.outOfScope {
      if Newer(row, r) {
        var rows' := settled.journal.documents;
        assert rows' == documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))];
        assert settled.listing == pass.listing && settled.effects == pass.effects;
        forall e | e in rows' ensures RowContent(platform, device0, accepted, settled.effects, settled.listing, e, rows'[e]) {
          if e in documents { assert RowContent(platform, device0, accepted, pass.effects, pass.listing, e, documents[e]); }
        }
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
    // Once, here, as in SettleKeepsG5: inside the per-row forall below the
    // solver's search for this sequence identity is costly.
    assert effects' == pass.effects + (guard + ruled.effects);
    var listing' := ListingAfter(platform, pass.listing, ruled.effects);
    assert settled.journal.documents == ruled.documents && settled.effects == effects' && settled.listing == listing';
    RuleDeleteSeen(platform, rows, doc, r, inner, revs', first);
    forall effect | effect in guard ensures effect.PersistJournal? { }
    forall e | e in ruled.documents ensures RowContent(platform, device0, accepted, effects', listing', e, ruled.documents[e]) {
      var after := ruled.documents[e];
      if after.binding.Some? && Distinct(platform, listing') && !OwnNameIn(platform, device0, effects', e, after.binding.value.spelling)
         && Listed(platform, listing', after.binding.value.spelling) {
        var s := after.binding.value.spelling;
        if exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, s) {
          RulePutsLast(platform, rows, doc, r, inner, revs', first, e);
          var m := var m :| 0 <= m < |ruled.effects|
            && ((ruled.effects[m].Write? && ruled.effects[m].target == Some(e) && SameF(platform, ruled.effects[m].path, s))
                || (ruled.effects[m].Move? && ruled.effects[m].mover == Some(e) && SameF(platform, ruled.effects[m].to, s)))
            && forall k | m < k < |ruled.effects| :: !Touches(platform, ruled.effects[k], s); m;
          LastPutOwnName(platform, device0, pass.effects + guard, ruled.effects, e, s, m);
          assert false;
        } else if rows[e].binding.Some? && s == rows[e].binding.value.spelling
                  && forall effect :: effect in ruled.effects ==> !Touches(platform, effect, s) {
          forall effect | effect in guard + ruled.effects ensures !Touches(platform, effect, s) {
            if effect in guard { assert effect.PersistJournal?; } else { assert effect in ruled.effects; }
          }
          UntouchedTailKeepsReadings(platform, device0, pass.effects, guard + ruled.effects, e, s);
          ListingAfterUntouched(platform, pass.listing, ruled.effects, s);
          assert e in documents && rows[e] == documents[e];
          assert RowContent(platform, device0, accepted, pass.effects, pass.listing, e, documents[e]);
        } else {
          RuleAdopt(platform, rows, doc, r, inner, revs', first, e);
          assert ruled.effects == [] && s == r.path && e == doc;
          assert listing' == pass.listing;
          assert accepted[r.id] == r;
          assert AcceptedContent(accepted, e, r.content);
        }
      }
    }
  }

  lemma SettlePulledKeepsContent(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                                 revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && PassContent(platform, device0, accepted, pass)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    ensures PassContent(platform, device0, accepted, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsContent(platform, device0, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleKeepsG5(platform, device0, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledKeepsContent(platform, device0, accepted, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsContent(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                          docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass) && PassContent(platform, device0, accepted, pass)
    requires PassNUD(platform, device0, accepted, pass)
    ensures PassContent(platform, device0, accepted, RetryWaiting(platform, pass, docs, input, revs, first))
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
        SettleKeepsContent(platform, device0, accepted, cleared, docs[0], r, input, revs, first);
        SettleKeepsG5(platform, device0, cleared, docs[0], r, input, revs, first);
        SettleKeepsNUD(platform, device0, accepted, cleared, docs[0], r, input, revs, first);
        RetryKeepsContent(platform, device0, accepted, SettleRevision(platform, cleared, docs[0], r, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsContent(platform, device0, accepted, pass, docs[1..], input, revs, first);
      }
    }
  }

  // Names the same under F hold the same file on a disk with one file per
  // name.
  lemma FileAtSameF(device: Device, p: Path, q: Path)
    requires ListingDistinct(device.platform, ListingOf(device)) && SameF(device.platform, p, q)
    ensures HasFile(device, p) <==> HasFile(device, q)
    ensures HasFile(device, p) ==> FileAt(device, p) == FileAt(device, q)
  {
    var platform := device.platform;
    if HasFile(device, p) {
      var a := var a :| a in device.disk && SameF(platform, a, p) && FileAt(device, p) == device.disk[a]; a;
      SameFIsEquivalence(platform, a, p, q);
      var b := var b :| b in device.disk && SameF(platform, b, q) && FileAt(device, q) == device.disk[b]; b;
      SameFIsEquivalence(platform, b, q, a);
      SameFIsEquivalence(platform, a, q, b);
      assert a in ListingOf(device) && b in ListingOf(device);
    } else if HasFile(device, q) {
      var b := var b :| b in device.disk && SameF(platform, b, q); b;
      SameFIsEquivalence(platform, p, q, b);
      SameFIsEquivalence(platform, b, q, p);
    }
  }

  // G5_NeverMixedUp of the round: every binding the round changes
  // names a file the round put there for the document (b), or one that
  // was untracked as the round left it (UntrackedThen): a new document's
  // (e), or an adoption of a live revision of the document the server
  // accepted (d). It takes the step's G5_NeverJoined after the round as
  // given (the round's G5_NeverJoined is its own lemma).
  lemma {:isolate_assertions} RoundG5NeverMixedUp(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input)
    requires G5_NeverJoined(pre) && JournalsNameAccepted(pre) && G7_OneFilePerName(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    requires G5_NeverJoined(RoundStepOf(pre, d, input, revs).post)
    ensures G5_NeverMixedUp(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    var device := pre.devices[d];
    var platform := device.platform;
    var journal := device.journal;
    var accepted := pre.server.accepted;
    RoundOnlyTouchesDevice(pre, d, input, revs);
    RoundStepJournal(pre, d, input, revs);
    if !(forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs) {
      assert step.post.devices[d] == device;
      return;
    }
    var after := step.post.devices[d];
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
    assert after.journal == push.0;
    // The pass invariants.
    assert OneFilePerName(platform, device.disk);
    assert input.listing == ListingOf(device);
    OneFileDistinct(platform, device.disk);
    assert NeverJoinedRows(platform, journal.documents);
    PassG5Start(device, start, journal.cursor);
    PassContentStart(device, accepted, start, journal.cursor);
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
    RetryKeepsG5(platform, device, start, WaitingRows(journal.documents), input, revs, first);
    RetryKeepsContent(platform, device, accepted, start, WaitingRows(journal.documents), input, revs, first);
    if behind {
      var ids := feed[journal.cursor..];
      RevisionsHeld(pre.server, ids);
      forall i | 0 <= i < |pulled| ensures AcceptedAs(accepted, pulled[i]) {
        assert pulled[i] in pulled;
      }
    }
    SettlePulledKeepsG5(platform, device, retried, pulled, input, revs, first);
    SettlePulledKeepsContent(platform, device, accepted, retried, pulled, input, revs, first);
    PushKeepsG5(platform, device, settled, read, input, revs);
    PushTouchesNoFile(platform, read, input', revs);
    // The disk after the round is the pass's listing.
    RoundDisksFollowEffects(pre, d, input, revs);
    assert EffectsTake(platform, device.disk, step.effects, after.disk);
    EffectsTakeSplit(platform, device.disk, settled.effects, push.1, after.disk);
    var mid := var mid :| EffectsTake(platform, device.disk, settled.effects, mid) && EffectsTake(platform, mid, push.1, after.disk); mid;
    PushKeepsDisk(platform, mid, push.1, after.disk);
    assert DiskMap(after.disk) == settled.listing && OneFilePerName(platform, after.disk);
    assert DiskMap(after.disk) == ListingOf(after);
    OneFileDistinct(platform, after.disk);
    RoundIdsAreNew(pre, d, input);
    var created := Created(platform, read, input', revs);
    var creates := Creates(Untracked(platform, read.documents, input'.listing), input'.freshDocs);
    CreatesFacts(Untracked(platform, read.documents, input'.listing), input'.freshDocs);
    assert step.effects[..|settled.effects|] == settled.effects;
    assert step.effects[|settled.effects|..] == push.1;
    forall doc | BoundIdentity(after, doc).Some? && BoundIdentity(after, doc) != BoundIdentity(device, doc)
      ensures var spelling := after.journal.documents[doc].binding.value.spelling;
        var file := BoundFile(after, doc).value;
        var known := doc in device.journal.documents;
        var hadFile := known && BoundFile(device, doc).Some?;
        (exists effect :: effect in step.effects
           && ((effect.Write? && effect.target == Some(doc) && SameF(after.platform, effect.path, spelling))
               || (effect.Move? && effect.mover == Some(doc) && SameF(after.platform, effect.to, spelling))))
        || ((!hadFile || RoundEvent(step.event)) && UntrackedThen(step, device, spelling)
            && ((after.journal.documents[doc].base.Some?
                 && (!known || device.journal.documents[doc].base.None?
                     || device.journal.documents[doc].base.value.rev != after.journal.documents[doc].base.value.rev)
                 && file.content == after.journal.documents[doc].base.value.content)
                || (RoundEvent(step.event) && DocVersion(step, doc, file.content))))
        || (!known && UntrackedThen(step, device, spelling) && after.journal.documents[doc].base.None?)
    {
      assert push.0.documents[doc] == Seal(created[doc]);
      if doc in settled.journal.documents {
        assert created[doc] == settled.journal.documents[doc];
        assert RowContent(platform, device, accepted, settled.effects, settled.listing, doc, settled.journal.documents[doc]);
      } else {
        assert doc in creates;
        var i := var i :| 0 <= i < |input.freshDocs| && input.freshDocs[i] == doc; i;
      }
      RoundG5Doc(step, device, after, settled.effects, settled.listing, settled.journal.documents, doc);
    }
  }

  // The push's effects leave the disk as it is.
  lemma PushKeepsDisk(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>)
    requires forall e | e in effects :: !e.Write? && !e.Remove? && !e.Move?
    requires EffectsTake(platform, disk, effects, disk')
    ensures disk' == disk
    decreases |effects|
  {
    if |effects| > 0 {
      var m := var m :| EffectTakes(platform, disk, effects[0], m) && EffectsTake(platform, m, effects[1..], disk'); m;
      assert effects[0] in effects;
      assert m == disk;
      assert forall e | e in effects[1..] :: e in effects;
      PushKeepsDisk(platform, m, effects[1..], disk');
    }
  }

  // One rebinding of the round, as G5_NeverMixedUp asks: from the pass
  // invariants at the end of the round.
  lemma {:isolate_assertions} RoundG5Doc(step: Step, before: Device, after: Device, settledEffects: seq<Effect>, listing: Listing,
                                         settledRows: map<DocId, Document>, doc: DocId)
    requires RoundEvent(step.event) && step.event.device in step.pre.devices && step.event.device in step.post.devices
    requires before == step.pre.devices[step.event.device] && after == step.post.devices[step.event.device]
    requires after.platform == before.platform
    requires ListingDistinct(before.platform, ListingOf(before)) && ListingDistinct(after.platform, ListingOf(after))
    requires EffectsTake(before.platform, before.disk, step.effects, after.disk)
    requires DiskMap(after.disk) == listing
    requires G5_NeverJoined(step.post)
    requires |settledEffects| <= |step.effects| && step.effects[..|settledEffects|] == settledEffects
    requires forall effect | effect in step.effects[|settledEffects|..] :: !effect.Write? && !effect.Remove? && !effect.Move?
    requires doc in after.journal.documents
    requires RowG5(before.platform, before, step.effects, doc, after.journal.documents[doc])
    requires doc in settledRows ==>
      settledRows[doc].binding == after.journal.documents[doc].binding
      && RowContent(before.platform, before, step.post.server.accepted, settledEffects, listing, doc, settledRows[doc])
    requires doc !in settledRows ==> doc !in before.journal.documents && after.journal.documents[doc].base.None?
    requires BoundIdentity(after, doc).Some? && BoundIdentity(after, doc) != BoundIdentity(before, doc)
    ensures var spelling := after.journal.documents[doc].binding.value.spelling;
      var file := BoundFile(after, doc).value;
      var known := doc in before.journal.documents;
      var hadFile := known && BoundFile(before, doc).Some?;
      (exists effect :: effect in step.effects
         && ((effect.Write? && effect.target == Some(doc) && SameF(after.platform, effect.path, spelling))
             || (effect.Move? && effect.mover == Some(doc) && SameF(after.platform, effect.to, spelling))))
      || ((!hadFile || RoundEvent(step.event)) && UntrackedThen(step, before, spelling)
          && ((after.journal.documents[doc].base.Some?
               && (!known || before.journal.documents[doc].base.None?
                   || before.journal.documents[doc].base.value.rev != after.journal.documents[doc].base.value.rev)
               && file.content == after.journal.documents[doc].base.value.content)
              || (RoundEvent(step.event) && DocVersion(step, doc, file.content))))
      || (!known && UntrackedThen(step, before, spelling) && after.journal.documents[doc].base.None?)
  {
    var platform := before.platform;
    var row := after.journal.documents[doc];
    var s := row.binding.value.spelling;
    var file := BoundFile(after, doc).value;
    var effects := step.effects;
    var put := RoundPut(platform, effects, s);
    RoundPutIndexTouches(platform, effects, s);
    // (b): the round put the file there for the document.
    if put.By? && ((effects[put.index].Write? && effects[put.index].target == Some(doc))
                   || (effects[put.index].Move? && effects[put.index].mover == Some(doc))) {
      var effect := effects[put.index];
      assert effect in effects;
      RoundPutIndexTouches(platform, effects, s);
      return;
    }
    // Not its own untouched file: the identity changed.
    if put.Untouched? && BoundTo(before, doc, s) {
      var p0 := before.journal.documents[doc].binding.value.spelling;
      UntouchedSameFile(before, after, effects, s);
      FileAtSameF(before, p0, s);
      assert HasFile(after, s);
      assert false;
    }
    assert !OwnNameIn(platform, before, effects, doc, s);
    assert UntrackedIn(platform, before, effects, s);
    // UntrackedThen.
    if put.Untouched? {
      if Tracked(before, s) {
        forall y | BoundTo(before, y, s) ensures !BoundTo(after, y, s) {
          if y == doc { assert false; }
          if BoundTo(after, y, s) {
            SameFIsEquivalence(platform, after.journal.documents[y].binding.value.spelling, s, s);
            assert false;
          }
        }
        assert RoundLetGo(step, before, s);
      } else {
        assert HasFile(before, s) && !Tracked(before, s);
      }
    } else if put.By? {
      var effect := effects[put.index];
      if PutsUntracked(effect) {
        assert RoundLeftUntracked(step, s);
      } else {
        var y := if effect.Write? then effect.target.value else effect.mover.value;
        assert y != doc;
        if BoundTo(after, y, s) {
          SameFIsEquivalence(platform, after.journal.documents[y].binding.value.spelling, s, s);
          assert false;
        }
        assert RoundLetGo(step, before, s);
      }
    }
    assert UntrackedThen(step, before, s);
    if doc in settledRows {
      // (d): the file holds an accepted live revision of the document.
      var tail := effects[|settledEffects|..];
      assert effects == settledEffects + tail;
      forall effect | effect in tail ensures !Touches(platform, effect, s) { }
      UntouchedTailKeepsReadings(platform, before, settledEffects, tail, doc, s);
      assert !OwnNameIn(platform, before, settledEffects, doc, s);
      var k := var k :| k in after.disk && SameF(platform, k, s) && file == after.disk[k]; k;
      assert k in listing;
      SameFIsEquivalence(platform, k, s, s);
      assert Listed(platform, listing, s);
      assert ListingOf(after) == listing;
      var at := ListedAt(platform, listing, s);
      SameFIsEquivalence(platform, at, s, k);
      assert ListedAt(platform, listing, s) == k;
      assert AcceptedContent(step.post.server.accepted, doc, file.content);
      assert DocVersion(step, doc, file.content);
    }
  }

  // The effect the round's last put at `s` names puts a file at `s`.
  lemma RoundPutIndexTouches(platform: Platform, effects: seq<Effect>, s: Path)
    ensures var put := RoundPut(platform, effects, s);
      put.By? ==>
        (effects[put.index].Write? && SameF(platform, effects[put.index].path, s))
        || (effects[put.index].Move? && SameF(platform, effects[put.index].to, s))
    decreases |effects|
  {
    if |effects| > 0 {
      var init := effects[..|effects| - 1];
      RoundPutIndexTouches(platform, init, s);
      var put := RoundPut(platform, init, s);
      if put.By? { assert effects[put.index] == init[put.index]; }
    }
  }
}
