// The path-conflict rule of the sync round (#962, docs/design/verified-core.md
// §3.10). One rule decides every name collision a pulled revision meets:
//
//   The server's head takes its name. Every file in its way on this device
//   (each listed file that collides with the name under F, folders and
//   files under it included, other than the document's own file) moves
//   aside with its contents, to a name the copy-name function (#1004)
//   picks. A document whose file moves aside keeps it under its own id
//   when a local change put it there (rule W(a)); otherwise it lets the
//   file go, as an untracked copy (rule W(b)). The rule moves nothing, and
//   the revision waits, where an open editor holds unsaved text in the way
//   (PathHeld, which UserMustAct reports), where another document's newest
//   server claim still holds the name (Unmaterializable(alias := true)),
//   and where no copy name is free (Unmaterializable(alias := false)).
//
// The rule runs where the pull apply (`ApplyRevision`, Apply.dfy) leaves a
// revision `PathHeld`, and only there: every other outcome of the apply is
// the rule's result unchanged.
include "Apply.dfy"

abstract module PathRuleCore refines ApplyCore {

  // ---------------------------------------------------------------------
  // Vocabulary (compiled)
  // ---------------------------------------------------------------------

  // Every name a document is bound to.
  function BoundNames(documents: map<DocId, Document>): set<Path> {
    set d | d in documents && documents[d].binding.Some? :: documents[d].binding.value.spelling
  }

  // The document a listed file is bound to, if any (under F).
  predicate FileOf(platform: Platform, documents: map<DocId, Document>, q: Path, e: DocId) {
    e in documents && documents[e].binding.Some? && SameF(platform, documents[e].binding.value.spelling, q)
  }

  // Every document's server claims, the document the rule applies included:
  // a copy collides with none of them (CopiesTakeFreeNames, PO-14).
  function AllClaims(documents: map<DocId, Document>): Claims {
    Claims((set d | d in documents && documents[d].base.Some? && !documents[d].base.value.deleted
              :: documents[d].base.value.path)
           + (set d | d in documents && documents[d].ahead.Some? && !documents[d].ahead.value.revision.deleted
                :: documents[d].ahead.value.revision.path),
           set d | d in documents && documents[d].outbox.Some? && !documents[d].outbox.value.deleted
             :: documents[d].outbox.value.path)
  }

  // A document's newest server claim: its live `ahead`'s path, else its live
  // base's path (design §4.2). A tombstone claims no path.
  function NewestClaim(document: Document): Option<Path> {
    if document.ahead.Some? then
      (if document.ahead.value.revision.deleted then None else Some(document.ahead.value.revision.path))
    else if document.base.Some? && !document.base.value.deleted then Some(document.base.value.path)
    else None
  }

  // Another document still claims `p` on the server: its newest server claim
  // collides with `p` under K, or is the same file under F (an F-alias,
  // design §4.5 step 3). The revision cannot take the name on this device
  // while that claim stands (rule W(c) and the alias case).
  predicate StillClaimed(platform: Platform, documents: map<DocId, Document>, doc: DocId, p: Path) {
    exists e | e in documents && e != doc ::
      NewestClaim(documents[e]).Some?
      && (CollideK(NewestClaim(documents[e]).value, p) || CollideF(platform, NewestClaim(documents[e]).value, p))
  }

  // A file is held by a local change of its document (rule W(a)): the
  // document has no live base at that name, or an outbox that sends it
  // elsewhere or anew.
  predicate LocallyPlaced(document: Document) {
    document.binding.Some?
    && (document.base.None? || document.base.value.deleted
        || document.base.value.path != document.binding.value.spelling
        || document.outbox.Some?)
  }

  // The files in the way of `p`: every listed file colliding with it under
  // F, apart from `own` (the document's own file, which the rule moves to
  // `p` itself).
  function InTheWay(platform: Platform, listing: Listing, p: Path, own: Option<Path>): set<Path> {
    set q | q in listing && CollideF(platform, q, p) && own != Some(q)
  }

  // ---------------------------------------------------------------------
  // Moving aside (compiled)
  // ---------------------------------------------------------------------

  // A copy name for each file in `way`, chosen one after another: each name
  // is picked against the listing with the earlier names already in it, so
  // no two collide. None when one of them has no free name.
  function Aside(platform: Platform, listing: Listing, avoid: set<Path>, claims: Claims, way: set<Path>, wanted: Path): (moves: Option<seq<(Path, Path, Hash)>>)
    requires way <= listing.Keys
    decreases |way|
  {
    if way == {} then Some([])
    else
      var q := LeastPath(way);
      match PathConflictCopy(platform, listing, avoid, claims, q, wanted)
      case None => None
      case Some(c) =>
        match Aside(platform, listing[c := listing[q]], avoid, claims, way - {q}, wanted)
        case None => None
        case Some(rest) => Some([(q, c, listing[q].0)] + rest)
  }

  // The new row of a document whose file `from` moved aside to `to`: under
  // W(a) it keeps the file, and its outbox (opened with `rev` if it has
  // none) sends the new name; under W(b) it lets the file go, and the copy
  // is untracked. A commit in flight stays as it was sealed.
  function MovedAside(document: Document, to: Path, rev: RevId): Document
    requires document.binding.Some?
  {
    var b := document.binding.value;
    if LocallyPlaced(document) then
      var row := document.(binding := Some(b.(spelling := to)));
      if document.outbox.Some? && document.outbox.value.sealed then row
      else if document.outbox.Some? then row.(outbox := Some(document.outbox.value.(path := to)))
      else row.(outbox := Some(Outbox(rev, if document.base.Some? then Some(document.base.value.rev) else None,
                                      to, b.seen, KindOfBase(document), false, false, false)))
    else
      document.(binding := None, absence := Released,
                outbox := if document.outbox.Some? && document.outbox.value.sealed then document.outbox else None)
  }

  function KindOfBase(document: Document): Kind {
    if document.base.Some? then document.base.value.kind else Note
  }

  // ---------------------------------------------------------------------
  // The rule (compiled)
  // ---------------------------------------------------------------------

  datatype Ruled = Ruled(documents: map<DocId, Document>, effects: seq<Effect>)

  // The apply left `r`, newer than what the row knew, waiting for its name.
  // (A revision the row already holds as `ahead` is not newer: the apply
  // leaves its row as it is.)
  predicate HeldForName(document: Document, applied: Applied, r: Revision) {
    Newer(document, r) && applied.document.ahead.Some? && applied.document.ahead.value.blocker.PathHeld?
    && applied.document.ahead.value.revision == r
  }

  function Defer(documents: map<DocId, Document>, doc: DocId, r: Revision, alias: bool): Ruled
    requires doc in documents
  {
    Ruled(documents[doc := documents[doc].(ahead := Some(Ahead(r, Unmaterializable(alias), false)))],
          [Report(Some(doc), r.path, if alias then "conflict: name held by another file" else "conflict: no copy name fits")])
  }

  // One pulled revision `r` of document `doc` in a round, against the
  // journal's rows `documents`, the round's input, and the revision ids of
  // §3.1.
  function PathRule(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs): Ruled
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), AllClaims(documents), revs[doc]);
    if !HeldForName(document, applied, r) then Ruled(documents[doc := applied.document], applied.effects)
    else if UnsavedCollides(platform, input.unsaved, r.path) then
      // A user must act: the revision waits, and the round reports it.
      Ruled(documents[doc := applied.document], [Report(Some(doc), r.path, "conflict: unsaved changes in the way")])
    else ClearWay(platform, documents, doc, r, input, revs)
  }

  // The rule proper: the files in the way move aside, and the head takes its
  // name.
  function ClearWay(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs): Ruled
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
  {
    var document := documents[doc];
    var own := if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
               then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None;
    var way := InTheWay(platform, input.listing, r.path, own);
    if r.deleted || (document.binding.Some? && own.None?) then Defer(documents, doc, r, false)
    else if (exists q | q in way :: UnsavedCollides(platform, input.unsaved, q))
            || (own.Some? && UnsavedCollides(platform, input.unsaved, own.value)) then
      // Unsaved text collides with a file that would move, though not with
      // the name itself: nothing moves, and the device cannot hold the head.
      Defer(documents, doc, r, false)
    else if StillClaimed(platform, documents, doc, r.path) then Defer(documents, doc, r, true)
    else
      var avoid := BoundNames(documents) + input.unsaved;
      var claims := AllClaims(documents);
      assert way <= input.listing.Keys;
      match Aside(platform, input.listing, avoid, claims, way, r.path)
      case None => Defer(documents, doc, r, false)
      case Some(moves) =>
        var moved := MoveRows(platform, documents, doc, moves, revs);
        var row := document.(base := Some(BaseOf(r)), ahead := None,
                             binding := Some(Binding(r.path, r.content, false, None)), absence := Never);
        Ruled(moved[doc := row], MoveEffects(platform, documents, doc, moves) + Arrive(platform, doc, document, r, own))
  }

  // The rows after the files in the way moved aside.
  function MoveRows(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs): map<DocId, Document>
    requires documents.Keys <= revs.Keys
    decreases |moves|
  {
    if moves == [] then documents
    else
      var (q, c, content) := moves[0];
      var rest := MoveRows(platform, documents, doc, moves[1..], revs);
      var holders := set e | e in documents && e != doc && FileOf(platform, documents, q, e);
      if holders != {} then
        var e := LeastDoc(holders);
        if e in rest && rest[e].binding.Some? then rest[e := MovedAside(rest[e], c, revs[e])] else rest
      else rest
  }

  // The disk effects of moving aside: each file moves with its contents,
  // under its document's id where W(a) keeps it.
  function MoveEffects(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>): seq<Effect>
    decreases |moves|
  {
    if moves == [] then []
    else
      var (q, c, content) := moves[0];
      var keepers := set e | e in documents && e != doc && FileOf(platform, documents, q, e) && LocallyPlaced(documents[e]);
      var mover := if keepers != {} then Some(LeastDoc(keepers)) else None;
      [Move(mover, q, c, content)] + MoveEffects(platform, documents, doc, moves[1..])
  }

  // The head arrives at its name: the document's own clean file is written
  // over where the content changed and moves there, or, with no file, the
  // head is created there.
  // A file whose name is a folder of the new name, or lies under it, cannot
  // be moved there: it is removed (it is clean, so the server has its
  // content) and the head is created.
  function Arrive(platform: Platform, doc: DocId, document: Document, r: Revision, own: Option<Path>): seq<Effect> {
    if own.Some? && document.binding.Some? then
      var seen := document.binding.value.seen;
      if CollideF(platform, own.value, r.path) && !SameF(platform, own.value, r.path) then
        [Remove(doc, own.value, seen), Write(Some(doc), r.path, r.content, r.kind, None)]
      else
        // Written over in place first, where its file is still the one the
        // document is bound to (G2_OnlyWhatItSaw), then moved.
        (if r.content == seen then [] else [Write(Some(doc), own.value, r.content, r.kind, Some(seen))])
        + [Move(Some(doc), own.value, r.path, r.content)]
    else [Write(Some(doc), r.path, r.content, r.kind, None)]
  }

  // ---------------------------------------------------------------------
  // The rule's contract (verified-core.md §4, PathRuleContract)
  // ---------------------------------------------------------------------

  lemma AsideFrom(platform: Platform, listing: Listing, avoid: set<Path>, claims: Claims, way: set<Path>, wanted: Path)
    requires way <= listing.Keys
    ensures var moves := Aside(platform, listing, avoid, claims, way, wanted);
      moves.Some? ==> forall i | 0 <= i < |moves.value| :: moves.value[i].0 in way
    decreases |way|
  {
    if way != {} {
      var q := LeastPath(way);
      var c := PathConflictCopy(platform, listing, avoid, claims, q, wanted);
      if c.Some? {
        AsideFrom(platform, listing[c.value := listing[q]], avoid, claims, way - {q}, wanted);
      }
    }
  }

  lemma MoveEffectsShape(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>)
    ensures var effects := MoveEffects(platform, documents, doc, moves);
      |effects| == |moves|
      && forall i | 0 <= i < |effects| :: effects[i].Move? && effects[i].from == moves[i].0 && effects[i].to == moves[i].1
    decreases |moves|
  {
    if moves != [] { MoveEffectsShape(platform, documents, doc, moves[1..]); }
  }

  // The apply moves only an untracked file no unsaved text collides with,
  // and writes copies only at names the copy-name function picked.
  lemma AppliedMovesAndCopies(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var effects := ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects;
      forall e | e in effects ::
        (e.Move? ==> !UnsavedCollides(platform, input.unsaved, e.from))
        && (e.Write? && e.target.None? ==>
              FreeIn(platform, input.listing, e.path)
              && (forall t | t in bound + input.unsaved :: !SameF(platform, t, e.path))
              && (forall s | s in claims.paths :: !CollideK(s, e.path))
              && (forall s | s in claims.names :: !SameK(s, e.path)))
  {}

  // NoMoveFromUnsaved, on the rule: no file that collides with a path an
  // open editor holds unsaved text at is moved.
  lemma RuleNoMoveFromUnsaved(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var effects := PathRule(platform, documents, doc, r, input, revs).effects;
      forall i | 0 <= i < |effects| && effects[i].Move? :: !UnsavedCollides(platform, input.unsaved, effects[i].from)
  {
    var document := documents[doc];
    AppliedMovesAndCopies(platform, doc, document, r, input, BoundNames(documents), AllClaims(documents), revs[doc]);
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), AllClaims(documents), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      ClearWayNoMoveFromUnsaved(platform, documents, doc, r, input, revs);
    }
  }

  lemma ClearWayNoMoveFromUnsaved(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var effects := ClearWay(platform, documents, doc, r, input, revs).effects;
      forall i | 0 <= i < |effects| && effects[i].Move? :: !UnsavedCollides(platform, input.unsaved, effects[i].from)
  {
    var document := documents[doc];
    var own := if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
               then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None;
    var way := InTheWay(platform, input.listing, r.path, own);
    var avoid := BoundNames(documents) + input.unsaved;
    var claims := AllClaims(documents);
    var aside := Aside(platform, input.listing, avoid, claims, way, r.path);
    AsideFrom(platform, input.listing, avoid, claims, way, r.path);
    if !r.deleted && !(document.binding.Some? && own.None?)
       && !((exists q | q in way :: UnsavedCollides(platform, input.unsaved, q))
            || (own.Some? && UnsavedCollides(platform, input.unsaved, own.value)))
       && !StillClaimed(platform, documents, doc, r.path) && aside.Some? {
      var moves := aside.value;
      MoveEffectsShape(platform, documents, doc, moves);
      var front := MoveEffects(platform, documents, doc, moves);
      var back := Arrive(platform, doc, document, r, own);
      var effects := ClearWay(platform, documents, doc, r, input, revs).effects;
      assert effects == front + back;
      forall i | 0 <= i < |effects| && effects[i].Move?
        ensures !UnsavedCollides(platform, input.unsaved, effects[i].from)
      {
        if i < |front| {
          assert effects[i] == front[i];
          assert moves[i].0 in way;
        } else {
          assert effects[i] == back[i - |front|];
          assert effects[i].from == own.value;
        }
      }
    }
  }

  // The rule leaves the revision waiting for its name (PathHeld) only where
  // unsaved text collides with the name, which UserMustAct reports; it
  // changes no other document's `ahead`.
  lemma RuleHeldOnlyForUnsaved(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs);
      ruled.documents.Keys == documents.Keys
      && (forall e | e in documents && e != doc :: ruled.documents[e].ahead == documents[e].ahead)
      && (ruled.documents[doc].ahead != documents[doc].ahead && ruled.documents[doc].ahead.Some?
          && ruled.documents[doc].ahead.value.blocker.PathHeld?
          ==> ruled.documents[doc].ahead.value.revision == r && UnsavedCollides(platform, input.unsaved, r.path))
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), AllClaims(documents), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var own := if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
                 then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None;
      var way := InTheWay(platform, input.listing, r.path, own);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? {
        MoveRowsAheads(platform, documents, doc, aside.value, revs);
      }
    }
  }

  lemma MoveRowsAheads(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs)
    requires documents.Keys <= revs.Keys
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      rows.Keys == documents.Keys && forall e | e in documents :: rows[e].ahead == documents[e].ahead
    decreases |moves|
  {
    if moves != [] { MoveRowsAheads(platform, documents, doc, moves[1..], revs); }
  }

  // CopiesTakeFreeNames, on the rule: every copy it writes (a write of no
  // document) takes a name that collides under F with nothing listed, bound
  // or unsaved, and under K with no document's server claim.
  lemma RuleCopiesTakeFreeNames(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var effects := PathRule(platform, documents, doc, r, input, revs).effects;
      forall e | e in effects && e.Write? && e.target.None? ::
        (forall q :: q in input.listing ==> !CollideF(platform, q, e.path))
        && (forall u :: u in input.unsaved ==> !SameF(platform, u, e.path))
        && (forall d :: d in documents ==>
              var row := documents[d];
              (row.binding.Some? ==> !SameF(platform, row.binding.value.spelling, e.path))
              && (row.base.Some? && !row.base.value.deleted ==> !CollideK(row.base.value.path, e.path))
              && (row.ahead.Some? && !row.ahead.value.revision.deleted ==> !CollideK(row.ahead.value.revision.path, e.path))
              && (row.outbox.Some? && !row.outbox.value.deleted ==> !SameK(row.outbox.value.path, e.path)))
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := AllClaims(documents);
    AppliedMovesAndCopies(platform, doc, document, r, input, bound, claims, revs[doc]);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      ClearWayWritesNoCopy(platform, documents, doc, r, input, revs);
    }
    forall e | e in PathRule(platform, documents, doc, r, input, revs).effects && e.Write? && e.target.None?
      ensures forall d :: d in documents ==>
              var row := documents[d];
              (row.binding.Some? ==> !SameF(platform, row.binding.value.spelling, e.path))
              && (row.base.Some? && !row.base.value.deleted ==> !CollideK(row.base.value.path, e.path))
              && (row.ahead.Some? && !row.ahead.value.revision.deleted ==> !CollideK(row.ahead.value.revision.path, e.path))
              && (row.outbox.Some? && !row.outbox.value.deleted ==> !SameK(row.outbox.value.path, e.path))
    {
      forall d | d in documents
        ensures var row := documents[d];
              (row.binding.Some? ==> !SameF(platform, row.binding.value.spelling, e.path))
              && (row.base.Some? && !row.base.value.deleted ==> !CollideK(row.base.value.path, e.path))
              && (row.ahead.Some? && !row.ahead.value.revision.deleted ==> !CollideK(row.ahead.value.revision.path, e.path))
              && (row.outbox.Some? && !row.outbox.value.deleted ==> !SameK(row.outbox.value.path, e.path))
      {
        var row := documents[d];
        if row.binding.Some? { assert row.binding.value.spelling in bound; }
        if row.base.Some? && !row.base.value.deleted { assert row.base.value.path in claims.paths; }
        if row.ahead.Some? && !row.ahead.value.revision.deleted { assert row.ahead.value.revision.path in claims.paths; }
        if row.outbox.Some? && !row.outbox.value.deleted { assert row.outbox.value.path in claims.names; }
      }
    }
  }

  lemma ClearWayWritesNoCopy(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures forall e | e in ClearWay(platform, documents, doc, r, input, revs).effects :: !(e.Write? && e.target.None?)
  {
    var document := documents[doc];
    var own := if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
               then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None;
    var way := InTheWay(platform, input.listing, r.path, own);
    var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    if aside.Some? {
      MoveEffectsShape(platform, documents, doc, aside.value);
    }
  }

  // ---------------------------------------------------------------------
  // The rule keeps every row's invariant (CoreInv one row at a time)
  // ---------------------------------------------------------------------

  // The apply leaves a revision waiting for its name only for a document
  // with no change the server lacks.
  lemma HeldHasNoChange(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures HeldForName(document, ApplyRevision(platform, doc, document, r, input, bound, claims, rev), r) ==> !JournalChange(document)
  {}

  lemma MovedAsideKeepsRowInv(document: Document, to: Path, rev: RevId)
    requires document.binding.Some? && RowInv(document)
    ensures RowInv(MovedAside(document, to, rev))
  {}

  lemma MoveRowsKeepRowInv(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs)
    requires documents.Keys <= revs.Keys
    requires forall e | e in documents :: RowInv(documents[e])
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      rows.Keys == documents.Keys && forall e | e in rows :: RowInv(rows[e])
    decreases |moves|
  {
    if moves != [] {
      MoveRowsKeepRowInv(platform, documents, doc, moves[1..], revs);
      var rest := MoveRows(platform, documents, doc, moves[1..], revs);
      forall e | e in rest && rest[e].binding.Some? ensures RowInv(MovedAside(rest[e], moves[0].1, revs[e])) {
        MovedAsideKeepsRowInv(rest[e], moves[0].1, revs[e]);
      }
    }
  }

  // From rows that keep RowInv, every row the rule returns keeps it.
  lemma RuleKeepsRowInv(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires forall e | e in documents :: RowInv(documents[e])
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs);
      ruled.documents.Keys == documents.Keys && forall e | e in ruled.documents :: RowInv(ruled.documents[e])
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := AllClaims(documents);
    AppliedKeepsRowInv(platform, doc, document, r, input, bound, claims, revs[doc]);
    HeldHasNoChange(platform, doc, document, r, input, bound, claims, revs[doc]);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var own := if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
                 then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None;
      var way := InTheWay(platform, input.listing, r.path, own);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, claims, way, r.path);
      if aside.Some? {
        MoveRowsKeepRowInv(platform, documents, doc, aside.value, revs);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Moving aside: every move's precondition holds in order
  // ---------------------------------------------------------------------

  // A disk the moves can leave: each file is a file of the original disk
  // that was not in the way, unchanged, or a copy at a new name that does
  // not collide with the wanted name.
  ghost predicate AsideLeaves(platform: Platform, disk0: map<Path, DiskFile>, way0: set<Path>, wanted: Path, keep: set<Path>, disk: map<Path, DiskFile>) {
    (forall k | k in keep :: k in disk && k in disk0 && disk[k] == disk0[k])
    && forall x | x in disk :: (x in disk0 && x !in way0 && disk[x] == disk0[x])
                            || (x !in disk0 && !CollideF(platform, x, wanted) && forall y | y in disk0 :: !CollideF(platform, y, x))
  }

  lemma AsideInOrder(platform: Platform, documents: map<DocId, Document>, doc: DocId, listing: Listing, avoid: set<Path>, claims: Claims,
                     way: set<Path>, wanted: Path, disk: map<Path, DiskFile>, disk0: map<Path, DiskFile>, way0: set<Path>, keep: set<Path>, tail: seq<Effect>)
    requires way <= listing.Keys && disk.Keys <= listing.Keys && disk0.Keys <= listing.Keys
    requires ListingDistinct(platform, listing)
    requires way <= disk.Keys && way <= way0
    requires forall q | q in way :: disk[q].content == listing[q].0
    requires forall x | x in disk :: (x in disk0 && x !in way0 && disk[x] == disk0[x]) || x in way
                                     || (x !in disk0 && !CollideF(platform, x, wanted) && forall y | y in disk0 :: !CollideF(platform, y, x))
    requires forall x | x in way :: x in disk0
    requires forall k | k in keep :: k in disk && k in disk0 && k !in way0 && disk[k] == disk0[k]
    requires forall d' :: AsideLeaves(platform, disk0, way0, wanted, keep, d') ==> PreconditionsInOrder(platform, d', tail)
    ensures var moves := Aside(platform, listing, avoid, claims, way, wanted);
      moves.Some? ==> PreconditionsInOrder(platform, disk, MoveEffects(platform, documents, doc, moves.value) + tail)
    decreases |way|
  {
    var moves := Aside(platform, listing, avoid, claims, way, wanted);
    if moves.None? { return; }
    if way == {} {
      assert MoveEffects(platform, documents, doc, moves.value) + tail == tail;
      assert AsideLeaves(platform, disk0, way0, wanted, keep, disk);
      return;
    }
    var q := LeastPath(way);
    var c := PathConflictCopy(platform, listing, avoid, claims, q, wanted).value;
    var listing' := listing[c := listing[q]];
    var rest := Aside(platform, listing', avoid, claims, way - {q}, wanted).value;
    assert moves.value == [(q, c, listing[q].0)] + rest;
    var effects := MoveEffects(platform, documents, doc, moves.value) + tail;
    var move := effects[0];
    assert move.Move? && move.from == q && move.to == c && move.expected == listing[q].0;
    assert effects[1..] == MoveEffects(platform, documents, doc, rest) + tail;
    assert c !in listing by { assert !CollideF(platform, c, c); }
    assert MovableTo(platform, disk, q, q, c, listing[q].0);
    assert ListingDistinct(platform, listing') by {
      forall x, y | x in listing' && y in listing' && x != y ensures !SameF(platform, x, y) {
        if x == c { assert !CollideF(platform, y, c); }
        else if y == c { assert !CollideF(platform, x, c); }
      }
    }
    forall mid | EffectTakes(platform, disk, move, mid)
      ensures PreconditionsInOrder(platform, mid, effects[1..])
    {
      var q' := var q' :| MovableTo(platform, disk, q', q, c, listing[q].0) && mid == (disk - {q'})[c := disk[q']]; q';
      assert q' == q;
      assert c !in disk0;
      AsideInOrder(platform, documents, doc, listing', avoid, claims, way - {q}, wanted, mid, disk0, way0, keep, tail);
    }
  }

  // After the moves, the head arrives at its name: the precondition of each
  // of Arrive's effects holds in order.
  lemma ArriveInOrder(platform: Platform, doc: DocId, document: Document, r: Revision, own: Option<Path>,
                      disk0: map<Path, DiskFile>, way0: set<Path>, keep: set<Path>, d': map<Path, DiskFile>)
    requires document.binding.Some? <==> own.Some?
    requires own.Some? ==> own.value in disk0 && disk0[own.value].content == document.binding.value.seen && own.value !in way0
    requires forall x | x in disk0 && x !in way0 && Some(x) != own :: !CollideF(platform, x, r.path)
    requires forall x, y | x in disk0 && y in disk0 && x != y :: !SameF(platform, x, y)
    requires own.Some? ==> own.value in keep
    requires AsideLeaves(platform, disk0, way0, r.path, keep, d')
    ensures PreconditionsInOrder(platform, d', Arrive(platform, doc, document, r, own))
  {
    var effects := Arrive(platform, doc, document, r, own);
    if own.None? {
      OneEffect(platform, d', effects[0]);
      return;
    }
    var o := own.value;
    var seen := document.binding.value.seen;
    assert Holds(platform, d', o, o, seen);
    // The file found at `o` under F is `o` itself.
    forall q' | q' in d' && SameF(platform, q', o) ensures q' == o {
      if q' != o {
        if q' in disk0 { } else { assert !CollideF(platform, o, q'); }
      }
    }
    assert FreeOn(platform, d' - {o}, r.path);
    if CollideF(platform, o, r.path) && !SameF(platform, o, r.path) {
      var remove := Remove(doc, o, seen);
      var write := Write(Some(doc), r.path, r.content, r.kind, None);
      assert effects == [remove, write];
      forall mid | EffectTakes(platform, d', remove, mid) ensures PreconditionsInOrder(platform, mid, [write]) {
        OneEffect(platform, mid, write);
      }
      assert effects[1..] == [write];
    } else {
      var move := Move(Some(doc), o, r.path, r.content);
      if r.content == seen {
        assert effects == [move];
        assert MovableTo(platform, d', o, o, r.path, seen);
        OneEffect(platform, d', move);
      } else {
        var write := Write(Some(doc), o, r.content, r.kind, Some(seen));
        assert effects == [write, move];
        forall mid | EffectTakes(platform, d', write, mid) ensures PreconditionsInOrder(platform, mid, [move]) {
          var q' := var q' :| Holds(platform, d', q', o, seen) && mid == d'[q' := DiskFile(r.content, r.kind, d'[q'].identity)]; q';
          assert q' == o;
          assert mid.Keys == d'.Keys;
          assert MovableTo(platform, mid, o, o, r.path, r.content);
          OneEffect(platform, mid, move);
        }
        assert effects[1..] == [move];
      }
    }
  }

  // A bound document the apply leaves waiting for its name reads, in the
  // listing, as last seen.
  lemma HeldReadsSeen(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures HeldForName(document, ApplyRevision(platform, doc, document, r, input, bound, claims, rev), r) && document.binding.Some?
      ==> var read := ListedRead(platform, input.listing, document.binding.value.spelling);
          read.Some? && read.value.0 == document.binding.value.seen
  {}

  // Every disk effect of the rule has a precondition that holds, in order,
  // on the disk the round's listing was read from.
  lemma RulePreconditionsHold(device: Device, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires input.listing == ListingOf(device)
    requires ListingDistinct(device.platform, input.listing)
    ensures PreconditionsInOrder(device.platform, device.disk, PathRule(device.platform, documents, doc, r, input, revs).effects)
  {
    var platform := device.platform;
    var disk := device.disk;
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := AllClaims(documents);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var effects := PathRule(platform, documents, doc, r, input, revs).effects;
    if !HeldForName(document, applied, r) {
      AppliedPreconditionsHold(device, doc, document, r, input, bound, claims, revs[doc]);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) {
      OneEffect(platform, disk, effects[0]);
      return;
    }
    HeldReadsSeen(platform, doc, document, r, input, bound, claims, revs[doc]);
    var own := if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
               then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None;
    var way := InTheWay(platform, input.listing, r.path, own);
    var avoid := bound + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, claims, way, r.path);
    if r.deleted || (document.binding.Some? && own.None?)
       || (exists q | q in way :: UnsavedCollides(platform, input.unsaved, q))
       || (own.Some? && UnsavedCollides(platform, input.unsaved, own.value))
       || StillClaimed(platform, documents, doc, r.path) || aside.None? {
      OneEffect(platform, disk, effects[0]);
      return;
    }
    var keep := if own.Some? then {own.value} else {};
    var tail := Arrive(platform, doc, document, r, own);
    if own.Some? {
      assert ListedRead(platform, input.listing, document.binding.value.spelling) == Some(input.listing[own.value]);
    }
    forall d' | AsideLeaves(platform, disk, way, r.path, keep, d') ensures PreconditionsInOrder(platform, d', tail) {
      ArriveInOrder(platform, doc, document, r, own, disk, way, keep, d');
    }
    AsideInOrder(platform, documents, doc, input.listing, avoid, claims, way, r.path, disk, disk, way, keep, tail);
    assert effects == MoveEffects(platform, documents, doc, aside.value) + tail;
  }

  // ---------------------------------------------------------------------
  // The contract on a round step (PathRuleContract)
  // ---------------------------------------------------------------------

  // A round step of device d whose effects are the rule's for revision r of
  // document doc, with the round's input read from the step's state before
  // (RoundInputOf), and whose state after has the rule's rows and the disk
  // the effects left. (The other revisions of the round and the push are
  // #982's.)
  ghost predicate RuleStep(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs) {
    step.event.SyncRound?
    && RoundInputOf(step.pre, step.event.device, input)
    && var d := step.event.device;
    var device := step.pre.devices[d];
    doc in device.journal.documents && device.journal.documents.Keys <= revs.Keys
    && ListingDistinct(device.platform, input.listing)
    && var ruled := PathRule(device.platform, device.journal.documents, doc, r, input, revs);
    step.effects == ruled.effects && d in step.post.devices
    && step.post.devices[d] == device.(journal := device.journal.(documents := ruled.documents),
                                       disk := step.post.devices[d].disk)
  }

  // On such a step, from rows whose revisions waiting for a name wait for
  // unsaved text in their way (the state every earlier application of the
  // rule in the round leaves; #982 re-applies a revision stored outside the
  // round first), the rule meets PathRuleContract: it moves nothing
  // unsaved text collides with, every copy takes a free name, and every
  // revision left waiting for a name is one a user must act on.
  lemma RuleMeetsContract(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires RuleStep(step, doc, r, input, revs)
    requires var device := step.pre.devices[step.event.device];
      forall e | e in device.journal.documents && device.journal.documents[e].ahead.Some?
                 && device.journal.documents[e].ahead.value.blocker.PathHeld? ::
        exists editor :: editor in device.editors && editor.unsaved.Some?
          && CollideF(device.platform, editor.path, device.journal.documents[e].ahead.value.revision.path)
    ensures PathRuleContract(step, input)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var documents := device.journal.documents;
    var platform := device.platform;
    RuleNoMoveFromUnsaved(platform, documents, doc, r, input, revs);
    RuleCopiesTakeFreeNames(platform, documents, doc, r, input, revs);
    RuleHeldOnlyForUnsaved(platform, documents, doc, r, input, revs);
    var ruled := PathRule(platform, documents, doc, r, input, revs);
    var after := step.post.devices[d];
    assert input.unsaved == UnsavedPaths(device);
    forall i | 0 <= i < |step.effects| && step.effects[i].Move?
      ensures forall editor :: editor in device.editors && editor.unsaved.Some? ==>
                !CollideF(device.platform, editor.path, step.effects[i].from)
    {
      forall editor | editor in device.editors && editor.unsaved.Some?
        ensures !CollideF(device.platform, editor.path, step.effects[i].from)
      {
        assert editor.path in input.unsaved;
      }
    }
    forall e | e in after.journal.documents && after.journal.documents[e].ahead.Some?
               && after.journal.documents[e].ahead.value.blocker.PathHeld?
      ensures UserMustAct(after, e)
    {
      if e == doc && ruled.documents[doc].ahead != documents[doc].ahead {
        var u :| u in input.unsaved && CollideF(platform, u, r.path);
        var editor :| editor in device.editors && editor.unsaved.Some? && editor.path == u;
        assert after.editors == device.editors;
      } else {
        assert after.journal.documents[e].ahead == documents[e].ahead;
        assert after.editors == device.editors && after.platform == device.platform;
      }
    }
  }

  // ---------------------------------------------------------------------
  // The cases of the engine design the rule covers (PO-4, PO-11)
  // ---------------------------------------------------------------------

  // PO-4 W(a): a document a local change put in the way keeps its file,
  // moved, under its own id, and sends the new name (unless a commit is in
  // flight, which AcceptKeepsLaterChange follows).
  lemma WaKeepsIdentity(document: Document, to: Path, rev: RevId)
    requires document.binding.Some? && LocallyPlaced(document)
    ensures var row := MovedAside(document, to, rev);
      row.binding == Some(document.binding.value.(spelling := to)) && row.absence == document.absence
      && row.base == document.base && row.ahead == document.ahead
      && row.outbox.Some?
      && (!document.outbox.Some? || !document.outbox.value.sealed ==> row.outbox.value.path == to && !row.outbox.value.sealed)
  {}

  // PO-4 W(b) and PO-11: any other document in the way (its file at its
  // server name, whatever blocks its own newer revision) lets the file go:
  // the file is an untracked copy, and the document keeps its server
  // history and its waiting revision.
  lemma WbLetsGo(document: Document, to: Path, rev: RevId)
    requires document.binding.Some? && !LocallyPlaced(document)
    ensures var row := MovedAside(document, to, rev);
      row.binding.None? && row.absence == Released && row.base == document.base && row.ahead == document.ahead
  {}

  // The move of a file in the way is under its document's id exactly where
  // W(a) keeps it there.
  lemma MoverIsWa(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, i: nat)
    requires i < |moves|
    ensures var effects := MoveEffects(platform, documents, doc, moves);
      |effects| == |moves| && effects[i].Move?
      && (effects[i].mover.Some? <==>
            exists e | e in documents && e != doc :: FileOf(platform, documents, moves[i].0, e) && LocallyPlaced(documents[e]))
    decreases |moves|
  {
    MoveEffectsShape(platform, documents, doc, moves);
    var effects := MoveEffects(platform, documents, doc, moves);
    if i > 0 {
      MoverIsWa(platform, documents, doc, moves[1..], i - 1);
      assert effects[i] == MoveEffects(platform, documents, doc, moves[1..])[i - 1];
    } else {
      var q := moves[0].0;
      var keepers := set e | e in documents && e != doc && FileOf(platform, documents, q, e) && LocallyPlaced(documents[e]);
      if exists e | e in documents && e != doc :: FileOf(platform, documents, q, e) && LocallyPlaced(documents[e]) {
        var e :| e in documents && e != doc && FileOf(platform, documents, q, e) && LocallyPlaced(documents[e]);
        assert e in keepers;
      }
    }
  }

  // PO-4 W(c) and the F-alias case of design §4.5 step 3: where another
  // document's newest server claim still holds the name, the rule moves
  // nothing and the revision waits, reported, as a name this device cannot
  // hold.
  lemma StillClaimedDefers(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires StillClaimed(platform, documents, doc, r.path)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      |ruled.effects| == 1 && ruled.effects[0].Report?
      && ruled.documents == documents[doc := documents[doc].(ahead := Some(Ahead(r, Unmaterializable(ruled.documents[doc].ahead.value.blocker.alias), false)))]
  {}

  // ---------------------------------------------------------------------
  // One file per name (G7's device half) on the rule's disk
  // ---------------------------------------------------------------------

  // Every effect keeps one file per name: a create and a move land only
  // where no other file collides, an overwrite keeps the names, and a
  // remove only takes a name away.
  lemma EffectKeepsOneFilePerName(platform: Platform, disk: map<Path, DiskFile>, effect: Effect, disk': map<Path, DiskFile>)
    requires OneFilePerName(platform, disk) && EffectTakes(platform, disk, effect, disk')
    ensures OneFilePerName(platform, disk')
  {
    match effect
    case Move(_, from, to, expected) =>
      if exists q :: MovableTo(platform, disk, q, from, to, expected) {
        var q := var q :| MovableTo(platform, disk, q, from, to, expected) && disk' == (disk - {q})[to := disk[q]]; q;
        forall x, y | x in disk' && y in disk' && x != y ensures !CollideF(platform, x, y) {
          if x == to { assert y in disk - {q}; assert !CollideF(platform, y, to); CollideSymmetric(platform, y, to); }
          else if y == to { assert x in disk - {q}; }
        }
      }
    case Write(_, path, content, kind, precondition) =>
      if precondition.None? && FreeOn(platform, disk, path) {
        var identity: FileIdentity := var identity: FileIdentity :| (forall q :: q in disk ==> disk[q].identity != identity)
          && disk' == disk[path := DiskFile(content, kind, identity)]; identity;
        forall x, y | x in disk' && y in disk' && x != y ensures !CollideF(platform, x, y) {
          if x == path { assert !CollideF(platform, y, path); CollideSymmetric(platform, y, path); }
        }
      } else if precondition.Some? && exists q :: Holds(platform, disk, q, path, precondition.value) {
        var q := var q :| Holds(platform, disk, q, path, precondition.value) && disk' == disk[q := DiskFile(content, kind, disk[q].identity)]; q;
        assert disk'.Keys == disk.Keys;
      }
    case Remove(_, path, expected) =>
      if exists q :: Holds(platform, disk, q, path, expected) {
        var q := var q :| Holds(platform, disk, q, path, expected) && disk' == disk - {q}; q;
      }
    case _ =>
  }

  lemma CollideSymmetric(platform: Platform, p: Path, q: Path)
    ensures CollideF(platform, p, q) == CollideF(platform, q, p)
  {}

  lemma EffectsKeepOneFilePerName(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>)
    requires OneFilePerName(platform, disk) && EffectsTake(platform, disk, effects, disk')
    ensures OneFilePerName(platform, disk')
    decreases |effects|
  {
    if |effects| > 0 {
      var mid := var mid :| EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk'); mid;
      EffectKeepsOneFilePerName(platform, disk, effects[0], mid);
      EffectsKeepOneFilePerName(platform, mid, effects[1..], disk');
    }
  }

  // On a rule step from a disk with one file per name, the disk after has
  // one file per name.
  lemma RuleOneFilePerName(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires RuleStep(step, doc, r, input, revs)
    requires var device := step.pre.devices[step.event.device];
      OneFilePerName(device.platform, device.disk)
      && EffectsTake(device.platform, device.disk, step.effects, step.post.devices[step.event.device].disk)
    ensures var after := step.post.devices[step.event.device];
      OneFilePerName(after.platform, after.disk)
  {
    var device := step.pre.devices[step.event.device];
    EffectsKeepOneFilePerName(device.platform, device.disk, step.effects, step.post.devices[step.event.device].disk);
  }

  // ---------------------------------------------------------------------
  // G2: the rule writes and removes nothing an open editor holds unsaved
  // text at
  // ---------------------------------------------------------------------

  // Where the rule clears the way, no write or remove it requests names a
  // path an open editor holds unsaved text at (G2_UnsavedSafe for the
  // rule's own effects; the pull apply's are §3.9's AppliedG2).
  lemma ClearWayUnsavedSafe(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires !UnsavedCollides(platform, input.unsaved, r.path)
    ensures forall e | e in ClearWay(platform, documents, doc, r, input, revs).effects && (e.Write? || e.Remove?) ::
      forall u | u in input.unsaved :: !SameF(platform, u, e.path)
  {
    var document := documents[doc];
    var own := if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
               then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None;
    var way := InTheWay(platform, input.listing, r.path, own);
    var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    if aside.Some? {
      MoveEffectsShape(platform, documents, doc, aside.value);
    }
    forall e | e in ClearWay(platform, documents, doc, r, input, revs).effects && (e.Write? || e.Remove?)
      ensures forall u | u in input.unsaved :: !SameF(platform, u, e.path)
    {
      forall u | u in input.unsaved ensures !SameF(platform, u, e.path) {
        if e.Write? && e.path == r.path { assert !CollideF(platform, u, r.path); }
        else { assert own.Some? && e.path == own.value; assert !CollideF(platform, u, own.value); }
      }
    }
  }

  // G2_OnlyWhatItSaw and G2_NoUntrackedDelete for the rule's own effects:
  // the only overwrite and the only remove name the document's own bound
  // file, conditional on the content it last saw there.
  lemma ClearWayOnlyWhatItSaw(device: Device, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in device.journal.documents && device.journal.documents.Keys <= revs.Keys
    requires ListingDistinct(device.platform, input.listing)
    ensures var effects := ClearWay(device.platform, device.journal.documents, doc, r, input, revs).effects;
      forall e | e in effects ::
        (e.Write? && e.precondition.Some? ==>
           e.target == Some(doc) && BoundTo(device, doc, e.path)
           && e.precondition.value == device.journal.documents[doc].binding.value.seen)
        && (e.Remove? ==>
           e.doc == doc && BoundTo(device, doc, e.path)
           && e.expected == device.journal.documents[doc].binding.value.seen && Tracked(device, e.path))
  {
    var platform := device.platform;
    var documents := device.journal.documents;
    var document := documents[doc];
    var own := if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
               then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None;
    var way := InTheWay(platform, input.listing, r.path, own);
    var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    if aside.Some? {
      MoveEffectsShape(platform, documents, doc, aside.value);
    }
    if own.Some? {
      SameFIsEquivalence(platform, own.value, document.binding.value.spelling, own.value);
      assert BoundTo(device, doc, own.value);
    }
  }
}
