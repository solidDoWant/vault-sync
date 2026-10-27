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
//   A document bound in the way whose file is missing (the user removed it,
//   and its local event has not arrived) records the user's delete (#1032).
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
        Ruled(ClearRows(platform, documents, doc, r, input, moves, revs),
              MoveEffects(platform, documents, doc, moves) + Arrive(platform, doc, document, r, own))
  }

  // Another document bound at a name in the way of `p` whose file is not
  // listed: the user removed or moved the file, and its local event has not
  // reached the core yet. No file of it is in the way, so nothing moves;
  // its binding would otherwise name the head's file (G5_NeverMixedUp).
  predicate MissingInTheWay(platform: Platform, listing: Listing, documents: map<DocId, Document>, doc: DocId, e: DocId, p: Path) {
    e in documents && e != doc && MissingIn(platform, listing, documents[e])
    && CollideF(platform, documents[e].binding.value.spelling, p)
  }

  // Each such document records the user's delete (`Unbind`, as the local
  // delete does), as rule W's intents do for a file gone from both names
  // (engine-path-ownership.md §4.4, `displace` and `detach`: "user deleted
  // it"). G3_DeleteSeen allows it: no file is at the binding's name.
  function RecordMissing(platform: Platform, listing: Listing, documents: map<DocId, Document>, doc: DocId, p: Path,
                         rows: map<DocId, Document>, revs: FreshRevs): map<DocId, Document>
  {
    map e | e in rows :: if MissingInTheWay(platform, listing, documents, doc, e, p) && rows[e].binding.Some? && e in revs
                         then Unbind(rows[e], revs[e]) else rows[e]
  }

  // The rows where the rule clears the way with `moves`: each document in
  // the way moves aside (MoveRows), each missing one in the way records the
  // user's delete (RecordMissing), and the head is the document's base, at
  // its name.
  function ClearRows(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                     moves: seq<(Path, Path, Hash)>, revs: FreshRevs): map<DocId, Document>
    requires doc in documents && documents.Keys <= revs.Keys
  {
    RecordMissing(platform, input.listing, documents, doc, r.path, MoveRows(platform, documents, doc, moves, revs), revs)
      [doc := documents[doc].(base := Some(BaseOf(r)), ahead := None,
                              binding := Some(Binding(r.path, r.content, false, None)), absence := Never)]
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
      && forall i | 0 <= i < |effects| ::
           effects[i].Move? && effects[i].from == moves[i].0 && effects[i].to == moves[i].1 && effects[i].expected == moves[i].2
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

  // The rule is the pull apply on the outbox's own revision: its
  // acknowledgement leaves nothing waiting for a name, so the rule's row is
  // the accept of it (or, where the file already holds the revision, the
  // identical row) and it requests no effect (ApplySettlesContract).
  lemma RuleAcknowledges(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires Newer(documents[doc], r) && Acknowledges(documents[doc], r)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs);
      && ruled.documents == documents[doc := if SettlesIdentical(platform, documents[doc], r, input)
                                             then IdenticalRow(documents[doc], r)
                                             else Accept(documents[doc], r, revs[doc])]
      && ruled.effects == []
  {
    AcknowledgementSettles(platform, doc, documents[doc], r, input, BoundNames(documents), AllClaims(documents), revs[doc]);
  }

  // Where the apply leaves nothing waiting for a name, the rule's step is the
  // pull apply's step (§3.9's `ApplyStep`, with every binding's name and
  // every row's claims), so the apply's guarantees hold for it: G2's step
  // predicates, G5_NeverMixedUp, G6_Settle and G7.
  lemma RulePassThroughGuarantees(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires RuleStep(step, doc, r, input, revs)
    requires var d := step.event.device;
      step.post == step.pre.(devices := step.pre.devices[d := step.post.devices[d]])
    requires var device := step.pre.devices[step.event.device];
      OneFilePerName(device.platform, device.disk)
      && EffectsTake(device.platform, device.disk, step.effects, step.post.devices[step.event.device].disk)
    requires r.id in step.pre.server.accepted && step.pre.server.accepted[r.id] == r
    requires r.doc == doc && PulledBy(step.pre.devices[step.event.device].journal.documents[doc], r, step.event.device)
    requires var device := step.pre.devices[step.event.device];
      var documents := device.journal.documents;
      !HeldForName(documents[doc], ApplyRevision(device.platform, doc, documents[doc], r, input, BoundNames(documents),
                                                 AllClaims(documents), revs[doc]), r)
    ensures var device := step.pre.devices[step.event.device];
      ApplyStep(step, doc, r, input, BoundNames(device.journal.documents), AllClaims(device.journal.documents), revs[doc])
    ensures G2_OnlyWhatItSaw(step) && G2_UnsavedSafe(step) && G2_NoUntrackedDelete(step)
    ensures G5_NeverMixedUp(step)
    ensures forall d, doc', remote :: SettlesConcurrent(step, d, doc', remote) ==> G6_Settle(step, d, doc', remote)
    ensures G7_OneFilePerName(step.pre) ==> G7_OneFilePerName(step.post) && G7_MoveKeepsContents(step)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var documents := device.journal.documents;
    var bound := BoundNames(documents);
    var claims := AllClaims(documents);
    forall other | other in documents && documents[other].binding.Some?
      ensures documents[other].binding.value.spelling in bound
    {}
    assert ApplyStep(step, doc, r, input, bound, claims, revs[doc]);
    AppliedG2(step, doc, r, input, bound, claims, revs[doc]);
    AppliedG5(step, doc, r, input, bound, claims, revs[doc]);
    AppliedG6(step, doc, r, input, bound, claims, revs[doc]);
    if G7_OneFilePerName(step.pre) { AppliedG7(step, doc, r, input, bound, claims, revs[doc]); }
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

  // ---------------------------------------------------------------------
  // G5 and G7 where the rule clears the way (#1032): the disk after the
  // whole sequence of moves
  // ---------------------------------------------------------------------

  // The moves Aside picks: each takes a distinct file in the way, with its
  // listed content, to a name free in the listing, the same under F as no
  // name to avoid, out of the wanted name's way, and colliding with no
  // other copy.
  lemma AsideFacts(platform: Platform, listing: Listing, avoid: set<Path>, claims: Claims, way: set<Path>, wanted: Path)
    requires way <= listing.Keys
    ensures var moves := Aside(platform, listing, avoid, claims, way, wanted);
      moves.Some? ==>
        (forall i | 0 <= i < |moves.value| ::
           moves.value[i].0 in way && moves.value[i].2 == listing[moves.value[i].0].0
           && FreeIn(platform, listing, moves.value[i].1)
           && (forall t | t in avoid :: !SameF(platform, t, moves.value[i].1))
           && !CollideF(platform, moves.value[i].1, wanted))
        && (forall i, j | 0 <= i < j < |moves.value| ::
              moves.value[i].0 != moves.value[j].0 && !CollideF(platform, moves.value[i].1, moves.value[j].1))
    decreases |way|
  {
    var moves := Aside(platform, listing, avoid, claims, way, wanted);
    if way == {} || moves.None? { return; }
    var q := LeastPath(way);
    var c := PathConflictCopy(platform, listing, avoid, claims, q, wanted).value;
    var listing' := listing[c := listing[q]];
    assert c !in listing by { assert CollideF(platform, c, c); }
    AsideFacts(platform, listing', avoid, claims, way - {q}, wanted);
    var rest := Aside(platform, listing', avoid, claims, way - {q}, wanted).value;
    var all := moves.value;
    assert all == [(q, c, listing[q].0)] + rest;
    forall i | 0 <= i < |all|
      ensures all[i].0 in way && all[i].2 == listing[all[i].0].0
           && FreeIn(platform, listing, all[i].1)
           && (forall t | t in avoid :: !SameF(platform, t, all[i].1))
           && !CollideF(platform, all[i].1, wanted)
    {
      if i > 0 {
        assert all[i] == rest[i - 1];
        assert all[i].0 in listing && all[i].0 != c;
      }
    }
    forall i, j | 0 <= i < j < |all|
      ensures all[i].0 != all[j].0 && !CollideF(platform, all[i].1, all[j].1)
    {
      assert all[j] == rest[j - 1];
      if i == 0 {
        assert c in listing';
      } else {
        assert all[i] == rest[i - 1];
      }
    }
  }

  // Every file in the way moves.
  lemma AsideCovers(platform: Platform, listing: Listing, avoid: set<Path>, claims: Claims, way: set<Path>, wanted: Path)
    requires way <= listing.Keys
    ensures var moves := Aside(platform, listing, avoid, claims, way, wanted);
      moves.Some? ==> forall q | q in way :: exists i | 0 <= i < |moves.value| :: moves.value[i].0 == q
    decreases |way|
  {
    var moves := Aside(platform, listing, avoid, claims, way, wanted);
    if way == {} || moves.None? { return; }
    var q := LeastPath(way);
    var c := PathConflictCopy(platform, listing, avoid, claims, q, wanted).value;
    var listing' := listing[c := listing[q]];
    AsideCovers(platform, listing', avoid, claims, way - {q}, wanted);
    assert Aside(platform, listing', avoid, claims, way - {q}, wanted).Some?;
    var rest := Aside(platform, listing', avoid, claims, way - {q}, wanted).value;
    var all := moves.value;
    assert all == [(q, c, listing[q].0)] + rest;
    forall q' | q' in way ensures exists i | 0 <= i < |all| :: all[i].0 == q' {
      if q' == q { assert all[0].0 == q; }
      else {
        assert q' in way - {q};
        assert exists k | 0 <= k < |rest| :: rest[k].0 == q';
        var k :| 0 <= k < |rest| && rest[k].0 == q';
        assert all[k + 1] == rest[k];
      }
    }
  }

  // The moves aside take effect in order on a disk with one file per name
  // where each file to move holds the move's content and each copy name is
  // free: each copy then holds the file it moved, and every other file stays
  // as it was.
  lemma {:isolate_assertions} MovesTake(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>,
                  disk: map<Path, DiskFile>, disk': map<Path, DiskFile>)
    requires OneFilePerName(platform, disk)
    requires forall i | 0 <= i < |moves| ::
      moves[i].0 in disk && disk[moves[i].0].content == moves[i].2 && FreeOn(platform, disk, moves[i].1)
    requires forall i, j | 0 <= i < j < |moves| :: moves[i].0 != moves[j].0 && !CollideF(platform, moves[i].1, moves[j].1)
    requires EffectsTake(platform, disk, MoveEffects(platform, documents, doc, moves), disk')
    ensures OneFilePerName(platform, disk')
    ensures forall i | 0 <= i < |moves| :: moves[i].1 in disk' && disk'[moves[i].1] == disk[moves[i].0]
    ensures forall x | x in disk' ::
      (x in disk && disk'[x] == disk[x] && forall i | 0 <= i < |moves| :: x != moves[i].0)
      || exists i | 0 <= i < |moves| :: x == moves[i].1
    ensures forall x | x in disk && (forall i | 0 <= i < |moves| :: x != moves[i].0) :: x in disk' && disk'[x] == disk[x]
    decreases |moves|
  {
    if moves == [] { return; }
    MoveEffectsShape(platform, documents, doc, moves);
    var effects := MoveEffects(platform, documents, doc, moves);
    var q := moves[0].0;
    var c := moves[0].1;
    var content := moves[0].2;
    assert effects[1..] == MoveEffects(platform, documents, doc, moves[1..]);
    var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk');
    assert c !in disk by { assert CollideF(platform, c, c); }
    assert MovableTo(platform, disk, q, q, c, content);
    var q': Path :| MovableTo(platform, disk, q', q, c, content) && mid == (disk - {q'})[c := disk[q']];
    if q' != q { assert CollideF(platform, q', q); }
    EffectKeepsOneFilePerName(platform, disk, effects[0], mid);
    var rest := moves[1..];
    forall i | 0 <= i < |rest|
      ensures rest[i].0 in mid && mid[rest[i].0].content == rest[i].2 && FreeOn(platform, mid, rest[i].1)
    {
      assert rest[i] == moves[i + 1];
      forall x | x in mid ensures !CollideF(platform, x, rest[i].1) {
        if x == c { assert !CollideF(platform, moves[0].1, moves[i + 1].1); }
      }
    }
    forall i, j | 0 <= i < j < |rest| ensures rest[i].0 != rest[j].0 && !CollideF(platform, rest[i].1, rest[j].1) {
      assert rest[i] == moves[i + 1] && rest[j] == moves[j + 1];
    }
    MovesTake(platform, documents, doc, rest, mid, disk');
    forall i | 0 <= i < |moves| ensures moves[i].1 in disk' && disk'[moves[i].1] == disk[moves[i].0] {
      if i == 0 {
        forall k | 0 <= k < |rest| ensures c != rest[k].0 {
          assert rest[k] == moves[k + 1];
        }
      } else {
        assert moves[i] == rest[i - 1];
      }
    }
    forall x | x in disk'
      ensures (x in disk && disk'[x] == disk[x] && forall i | 0 <= i < |moves| :: x != moves[i].0)
           || exists i | 0 <= i < |moves| :: x == moves[i].1
    {
      if exists k | 0 <= k < |rest| :: x == rest[k].1 {
        var k :| 0 <= k < |rest| && x == rest[k].1;
        assert x == moves[k + 1].1;
      } else if x == c {
        assert x == moves[0].1;
      } else {
        forall i | 0 <= i < |moves| ensures x != moves[i].0 {
          if i > 0 { assert moves[i] == rest[i - 1]; }
        }
      }
    }
    forall x | x in disk && (forall i | 0 <= i < |moves| :: x != moves[i].0) ensures x in disk' && disk'[x] == disk[x] {
      forall k | 0 <= k < |rest| ensures x != rest[k].0 { assert rest[k] == moves[k + 1]; }
    }
  }

  // The head then arrives at its name, on a disk where the document's own
  // file (if any) holds what it last saw and no other file is in the way:
  // the head is at its name with its content, and every other file stays as
  // it was.
  lemma ArriveTakes(platform: Platform, doc: DocId, document: Document, r: Revision, own: Option<Path>,
                    disk: map<Path, DiskFile>, disk': map<Path, DiskFile>)
    requires OneFilePerName(platform, disk)
    requires document.binding.Some? <==> own.Some?
    requires own.Some? ==> own.value in disk && disk[own.value].content == document.binding.value.seen
    requires forall x | x in disk && Some(x) != own :: !CollideF(platform, x, r.path)
    requires EffectsTake(platform, disk, Arrive(platform, doc, document, r, own), disk')
    ensures OneFilePerName(platform, disk')
    ensures r.path in disk' && disk'[r.path].content == r.content
    ensures forall x | x in disk' :: x == r.path || (x in disk && Some(x) != own && disk'[x] == disk[x])
    ensures forall x | x in disk && Some(x) != own :: x in disk' && disk'[x] == disk[x]
  {
    var effects := Arrive(platform, doc, document, r, own);
    if own.None? {
      var write := Write(Some(doc), r.path, r.content, r.kind, None);
      assert effects == [write];
      Unroll1(platform, disk, write, disk');
      EffectKeepsOneFilePerName(platform, disk, write, disk');
      return;
    }
    var o := own.value;
    var seen := document.binding.value.seen;
    // The file found at `o` under F is `o` itself.
    forall q' | q' in disk && SameF(platform, q', o) ensures q' == o {
      if q' != o { assert CollideF(platform, q', o); }
    }
    if CollideF(platform, o, r.path) && !SameF(platform, o, r.path) {
      var remove := Remove(doc, o, seen);
      var write := Write(Some(doc), r.path, r.content, r.kind, None);
      assert effects == [remove, write];
      Unroll2(platform, disk, remove, write, disk');
      var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, remove, mid) && EffectTakes(platform, mid, write, disk');
      assert Holds(platform, disk, o, o, seen);
      assert mid == disk - {o};
      assert FreeOn(platform, mid, r.path);
      EffectKeepsOneFilePerName(platform, disk, remove, mid);
      EffectKeepsOneFilePerName(platform, mid, write, disk');
    } else {
      var move := Move(Some(doc), o, r.path, r.content);
      assert FreeOn(platform, disk - {o}, r.path);
      if r.content == seen {
        assert effects == [move];
        Unroll1(platform, disk, move, disk');
        assert MovableTo(platform, disk, o, o, r.path, seen);
        assert disk' == (disk - {o})[r.path := disk[o]];
        EffectKeepsOneFilePerName(platform, disk, move, disk');
      } else {
        var write := Write(Some(doc), o, r.content, r.kind, Some(seen));
        assert effects == [write, move];
        Unroll2(platform, disk, write, move, disk');
        var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, write, mid) && EffectTakes(platform, mid, move, disk');
        assert Holds(platform, disk, o, o, seen);
        assert mid == disk[o := DiskFile(r.content, r.kind, disk[o].identity)];
        EffectKeepsOneFilePerName(platform, disk, write, mid);
        forall q' | q' in mid && SameF(platform, q', o) ensures q' == o {
          if q' != o { assert CollideF(platform, q', o); }
        }
        assert MovableTo(platform, mid, o, o, r.path, r.content);
        assert disk' == (mid - {o})[r.path := mid[o]];
        EffectKeepsOneFilePerName(platform, mid, move, disk');
      }
    }
  }

  lemma EffectsTakeSplit(platform: Platform, disk: map<Path, DiskFile>, a: seq<Effect>, b: seq<Effect>, disk': map<Path, DiskFile>)
    requires EffectsTake(platform, disk, a + b, disk')
    ensures exists mid :: EffectsTake(platform, disk, a, mid) && EffectsTake(platform, mid, b, disk')
    decreases |a|
  {
    if |a| == 0 {
      assert a + b == b;
      assert EffectsTake(platform, disk, a, disk);
    } else {
      var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, (a + b)[0], mid) && EffectsTake(platform, mid, (a + b)[1..], disk');
      assert (a + b)[0] == a[0];
      assert (a + b)[1..] == a[1..] + b;
      EffectsTakeSplit(platform, mid, a[1..], b, disk');
      var mid2: map<Path, DiskFile> :| EffectsTake(platform, mid, a[1..], mid2) && EffectsTake(platform, mid2, b, disk');
      assert EffectsTake(platform, disk, a, mid2);
    }
  }

  // No two rows are bound to one file (G5_NeverJoined on one journal).
  ghost predicate NeverJoinedRows(platform: Platform, documents: map<DocId, Document>) {
    forall e1, e2 | e1 in documents && e2 in documents && e1 != e2
                    && documents[e1].binding.Some? && documents[e2].binding.Some? ::
      !SameF(platform, documents[e1].binding.value.spelling, documents[e2].binding.value.spelling)
  }

  // Each document bound to a file that moves aside gets the row MovedAside
  // gives it for that file's copy, and every other row stays as it was.
  lemma MoveRowsRow(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>,
                    revs: FreshRevs, listing: Listing, e: DocId)
    requires documents.Keys <= revs.Keys
    requires ListingDistinct(platform, listing) && NeverJoinedRows(platform, documents)
    requires forall i | 0 <= i < |moves| :: moves[i].0 in listing
    requires forall i, j | 0 <= i < j < |moves| :: moves[i].0 != moves[j].0
    requires e in documents
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      e in rows
      && (forall i | 0 <= i < |moves| && e != doc && FileOf(platform, documents, moves[i].0, e) ::
            rows[e] == MovedAside(documents[e], moves[i].1, revs[e]))
      && ((forall i | 0 <= i < |moves| :: !(e != doc && FileOf(platform, documents, moves[i].0, e))) ==> rows[e] == documents[e])
    decreases |moves|
  {
    MoveRowsAheads(platform, documents, doc, moves, revs);
    if moves == [] { return; }
    var rest := moves[1..];
    forall i | 0 <= i < |rest| ensures rest[i].0 in listing { assert rest[i] == moves[i + 1]; }
    forall i, j | 0 <= i < j < |rest| ensures rest[i].0 != rest[j].0 { assert rest[i] == moves[i + 1] && rest[j] == moves[j + 1]; }
    MoveRowsRow(platform, documents, doc, rest, revs, listing, e);
    MoveRowsAheads(platform, documents, doc, rest, revs);
    var q := moves[0].0;
    var c := moves[0].1;
    var restRows := MoveRows(platform, documents, doc, rest, revs);
    var rows := MoveRows(platform, documents, doc, moves, revs);
    var holders := set e' | e' in documents && e' != doc && FileOf(platform, documents, q, e');
    if e != doc && FileOf(platform, documents, q, e) {
      assert holders == {e} by {
        forall e' | e' in holders ensures e' == e {
          if e' != e {
            assert SameF(platform, documents[e'].binding.value.spelling, documents[e].binding.value.spelling);
          }
        }
      }
      assert LeastDoc(holders) == e;
      forall k | 0 <= k < |rest| ensures !(e != doc && FileOf(platform, documents, rest[k].0, e)) {
        assert rest[k] == moves[k + 1];
        if FileOf(platform, documents, rest[k].0, e) {
          assert SameF(platform, q, rest[k].0);
        }
      }
      assert restRows[e] == documents[e];
      assert rows[e] == MovedAside(documents[e], c, revs[e]);
      forall i | 0 <= i < |moves| && e != doc && FileOf(platform, documents, moves[i].0, e)
        ensures rows[e] == MovedAside(documents[e], moves[i].1, revs[e])
      {
        if i > 0 { assert moves[i] == rest[i - 1]; }
      }
    } else {
      if holders != {} {
        var e0 := LeastDoc(holders);
        assert e0 != e;
      }
      assert rows[e] == restRows[e];
      forall i | 0 <= i < |moves| && e != doc && FileOf(platform, documents, moves[i].0, e)
        ensures rows[e] == MovedAside(documents[e], moves[i].1, revs[e])
      {
        assert i > 0;
        assert moves[i] == rest[i - 1];
      }
      if forall i | 0 <= i < |moves| :: !(e != doc && FileOf(platform, documents, moves[i].0, e)) {
        forall k | 0 <= k < |rest| ensures !(e != doc && FileOf(platform, documents, rest[k].0, e)) {
          assert rest[k] == moves[k + 1];
        }
      }
    }
  }

  // The move of a file in the way is under the id of the document a local
  // change put there (rule W(a)), the one document bound to it.
  lemma MoveEffectsMover(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, i: nat, e: DocId)
    requires i < |moves| && NeverJoinedRows(platform, documents)
    requires e in documents && e != doc && FileOf(platform, documents, moves[i].0, e) && LocallyPlaced(documents[e])
    ensures var effects := MoveEffects(platform, documents, doc, moves);
      |effects| == |moves| && effects[i] == Move(Some(e), moves[i].0, moves[i].1, moves[i].2)
    decreases |moves|
  {
    MoveEffectsShape(platform, documents, doc, moves);
    if i > 0 {
      MoveEffectsMover(platform, documents, doc, moves[1..], i - 1, e);
      assert MoveEffects(platform, documents, doc, moves)[i] == MoveEffects(platform, documents, doc, moves[1..])[i - 1];
    } else {
      var q := moves[0].0;
      var keepers := set e' | e' in documents && e' != doc && FileOf(platform, documents, q, e') && LocallyPlaced(documents[e']);
      assert keepers == {e} by {
        forall e' | e' in keepers ensures e' == e {
          if e' != e {
            assert SameF(platform, documents[e'].binding.value.spelling, documents[e].binding.value.spelling);
          }
        }
      }
      assert LeastDoc(keepers) == e;
    }
  }

  // The rule clears the way for `r` with `moves`: ClearWay's conditions
  // for moving hold, and Aside picked `moves`.
  ghost predicate ClearsWith(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                             own: Option<Path>, moves: seq<(Path, Path, Hash)>)
    requires doc in documents && ListingDistinct(platform, input.listing)
  {
    var document := documents[doc];
    own == (if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
            then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None)
    && var way := InTheWay(platform, input.listing, r.path, own);
    !r.deleted && !(document.binding.Some? && own.None?)
    && !(exists q | q in way :: UnsavedCollides(platform, input.unsaved, q))
    && !(own.Some? && UnsavedCollides(platform, input.unsaved, own.value))
    && !StillClaimed(platform, documents, doc, r.path)
    && Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path) == Some(moves)
  }

  // On the disk the listing was read from, the rule's moves and the head's
  // arrival leave: each copy holding the file it moved, the head at its
  // name with its content, every file not in the way and not the
  // document's own as it was, and nothing else.
  lemma ClearWayDisk(device: Device, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                     own: Option<Path>, moves: seq<(Path, Path, Hash)>, disk': map<Path, DiskFile>)
    requires doc in documents && input.listing == ListingOf(device)
    requires OneFilePerName(device.platform, device.disk) && ListingDistinct(device.platform, input.listing)
    requires ClearsWith(device.platform, documents, doc, r, input, own, moves)
    requires documents[doc].binding.Some? ==>
      var read := ListedRead(device.platform, input.listing, documents[doc].binding.value.spelling);
      read.Some? && read.value.0 == documents[doc].binding.value.seen
    requires EffectsTake(device.platform, device.disk,
                         MoveEffects(device.platform, documents, doc, moves) + Arrive(device.platform, doc, documents[doc], r, own), disk')
    ensures OneFilePerName(device.platform, disk')
    ensures forall i | 0 <= i < |moves| ::
      moves[i].0 in device.disk && moves[i].1 in disk' && disk'[moves[i].1] == device.disk[moves[i].0]
      && device.disk[moves[i].0].content == moves[i].2 && moves[i].1 !in device.disk && !CollideF(device.platform, moves[i].1, r.path)
      && forall t | t in BoundNames(documents) :: !SameF(device.platform, t, moves[i].1)
    ensures r.path in disk' && disk'[r.path].content == r.content
    ensures forall x | x in disk' ::
      x == r.path || (exists i | 0 <= i < |moves| :: x == moves[i].1)
      || (x in device.disk && Some(x) != own && disk'[x] == device.disk[x] && (forall i | 0 <= i < |moves| :: x != moves[i].0))
    ensures forall x | x in device.disk && Some(x) != own && (forall i | 0 <= i < |moves| :: x != moves[i].0) ::
      x in disk' && disk'[x] == device.disk[x]
    ensures forall x | x in device.disk && Some(x) != own && CollideF(device.platform, x, r.path) ::
      exists i | 0 <= i < |moves| :: x == moves[i].0
  {
    var platform := device.platform;
    var disk := device.disk;
    var listing := input.listing;
    var document := documents[doc];
    var way := InTheWay(platform, listing, r.path, own);
    var avoid := BoundNames(documents) + input.unsaved;
    var claims := AllClaims(documents);
    AsideFacts(platform, listing, avoid, claims, way, r.path);
    AsideCovers(platform, listing, avoid, claims, way, r.path);
    var front := MoveEffects(platform, documents, doc, moves);
    var back := Arrive(platform, doc, document, r, own);
    EffectsTakeSplit(platform, disk, front, back, disk');
    var mid: map<Path, DiskFile> :| EffectsTake(platform, disk, front, mid) && EffectsTake(platform, mid, back, disk');
    forall i | 0 <= i < |moves|
      ensures moves[i].0 in disk && disk[moves[i].0].content == moves[i].2 && FreeOn(platform, disk, moves[i].1)
      ensures moves[i].1 !in disk
    {
      assert moves[i].0 in way;
      assert CollideF(platform, moves[i].1, moves[i].1);
    }
    MovesTake(platform, documents, doc, moves, disk, mid);
    if own.Some? {
      assert own.value in listing;
      assert ListedRead(platform, listing, document.binding.value.spelling) == Some(listing[own.value]);
      forall i | 0 <= i < |moves| ensures own.value != moves[i].0 { assert moves[i].0 in way; }
    }
    forall x | x in mid && Some(x) != own ensures !CollideF(platform, x, r.path) {
      if !(exists i | 0 <= i < |moves| :: x == moves[i].1) {
        assert x in disk && forall i | 0 <= i < |moves| :: x != moves[i].0;
        if CollideF(platform, x, r.path) { assert x in way; }
      }
    }
    ArriveTakes(platform, doc, document, r, own, mid, disk');
    forall x | x in disk && Some(x) != own && CollideF(platform, x, r.path)
      ensures exists i | 0 <= i < |moves| :: x == moves[i].0
    {
      assert x in way;
    }
    forall i | 0 <= i < |moves| ensures moves[i].1 in disk' && disk'[moves[i].1] == disk[moves[i].0] {
      assert own.Some? ==> own.value in disk;
    }
  }

  // G7 on the device: every file moved aside arrives at its copy with its
  // contents, and the document's own file at the head's name with the
  // head's.
  lemma ClearG7(device: Device, after: Device, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                own: Option<Path>, moves: seq<(Path, Path, Hash)>)
    requires doc in documents && input.listing == ListingOf(device) && after.platform == device.platform
    requires OneFilePerName(device.platform, device.disk) && ListingDistinct(device.platform, input.listing)
    requires ClearsWith(device.platform, documents, doc, r, input, own, moves)
    requires documents[doc].binding.Some? ==>
      var read := ListedRead(device.platform, input.listing, documents[doc].binding.value.spelling);
      read.Some? && read.value.0 == documents[doc].binding.value.seen
    requires EffectsTake(device.platform, device.disk,
                         MoveEffects(device.platform, documents, doc, moves) + Arrive(device.platform, doc, documents[doc], r, own), after.disk)
    ensures forall e | e in MoveEffects(device.platform, documents, doc, moves) + Arrive(device.platform, doc, documents[doc], r, own) && e.Move? ::
      HasFile(after, e.to) && FileAt(after, e.to).content == e.expected
  {
    var platform := device.platform;
    ClearWayDisk(device, documents, doc, r, input, own, moves, after.disk);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var back := Arrive(platform, doc, documents[doc], r, own);
    var effects := front + back;
    forall e: Effect | e in effects && e.Move?
      ensures HasFile(after, e.to) && FileAt(after, e.to).content == e.expected
    {
      var k :| 0 <= k < |effects| && effects[k] == e;
      if k < |front| {
        assert e == front[k];
        FileAtIs(after, e.to, e.to);
      } else {
        assert e == back[k - |front|];
        assert e.to == r.path && e.expected == r.content;
        FileAtIs(after, r.path, r.path);
      }
    }
  }

  // The engine's own write or move of `doc'`'s file to its name after the
  // step (clause (b) of G5_NeverMixedUp).
  ghost predicate EngineBrought(effects: seq<Effect>, platform: Platform, doc': DocId, spelling: Path) {
    exists effect :: effect in effects
      && ((effect.Write? && effect.target == Some(doc') && SameF(platform, effect.path, spelling))
          || (effect.Move? && effect.mover == Some(doc') && SameF(platform, effect.to, spelling)))
  }

  // G5 for one document: a document whose bound file changes is the one the
  // head arrives for, or one rule W(a) moved under its own id. A document
  // that lets its file go (W(b)), or whose binding names a file the user
  // removed in the head's way, is bound to nothing after the step. Every
  // other binding names the same file, or none: a copy takes no bound name,
  // and no other document is bound to the head's name after the step.
  lemma {:isolate_assertions} ClearG5Doc(device: Device, after: Device, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs,
                   own: Option<Path>, moves: seq<(Path, Path, Hash)>, doc': DocId)
    requires doc in device.journal.documents && device.journal.documents.Keys <= revs.Keys
    requires input.listing == ListingOf(device) && after.platform == device.platform
    requires OneFilePerName(device.platform, device.disk) && ListingDistinct(device.platform, input.listing)
    requires NeverJoinedRows(device.platform, device.journal.documents)
    requires ClearsWith(device.platform, device.journal.documents, doc, r, input, own, moves)
    requires var documents := device.journal.documents;
      documents[doc].binding.Some? ==>
        var read := ListedRead(device.platform, input.listing, documents[doc].binding.value.spelling);
        read.Some? && read.value.0 == documents[doc].binding.value.seen
    requires EffectsTake(device.platform, device.disk,
                         MoveEffects(device.platform, device.journal.documents, doc, moves)
                         + Arrive(device.platform, doc, device.journal.documents[doc], r, own), after.disk)
    requires after.journal.documents == ClearRows(device.platform, device.journal.documents, doc, r, input, moves, revs)
    requires BoundIdentity(after, doc').Some? && BoundIdentity(after, doc') != BoundIdentity(device, doc')
    ensures EngineBrought(MoveEffects(device.platform, device.journal.documents, doc, moves)
                          + Arrive(device.platform, doc, device.journal.documents[doc], r, own),
                          device.platform, doc', after.journal.documents[doc'].binding.value.spelling)
  {
    var platform := device.platform;
    var disk := device.disk;
    var documents := device.journal.documents;
    var document := documents[doc];
    var listing := input.listing;
    ClearWayDisk(device, documents, doc, r, input, own, moves, after.disk);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var back := Arrive(platform, doc, document, r, own);
    var effects := front + back;
    var way := InTheWay(platform, listing, r.path, own);
    AsideFacts(platform, listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    var moved := MoveRows(platform, documents, doc, moves, revs);
    MoveRowsAheads(platform, documents, doc, moves, revs);
    if doc' == doc {
      var arrival := back[|back| - 1];
      assert effects[|front| + |back| - 1] == arrival;
      assert after.journal.documents[doc].binding.value.spelling == r.path;
      return;
    }
    assert doc' in documents;
    forall i | 0 <= i < |moves| ensures moves[i].0 in listing { assert moves[i].0 in way; }
    MoveRowsRow(platform, documents, doc, moves, revs, listing, doc');
    if i :| 0 <= i < |moves| && FileOf(platform, documents, moves[i].0, doc') {
      assert moves[i].0 in listing;
      assert Listed(platform, listing, documents[doc'].binding.value.spelling);
      assert !MissingInTheWay(platform, listing, documents, doc, doc', r.path);
      if LocallyPlaced(documents[doc']) {
        assert after.journal.documents[doc'].binding.value.spelling == moves[i].1;
        MoveEffectsMover(platform, documents, doc, moves, i, doc');
        assert effects[i] == front[i];
      } else {
        assert after.journal.documents[doc'].binding.None?;
      }
      return;
    }
    assert moved[doc'] == documents[doc'];
    if MissingInTheWay(platform, listing, documents, doc, doc', r.path) {
      assert after.journal.documents[doc'].binding.None?;
      return;
    }
    var row := documents[doc'];
    assert after.journal.documents[doc'] == row;
    var spelling := row.binding.value.spelling;
    assert spelling in BoundNames(documents);
    if HasFile(device, spelling) {
      var x :| x in disk && SameF(platform, x, spelling);
      FileAtIs(device, spelling, x);
      forall i | 0 <= i < |moves| ensures x != moves[i].0 {
        if x == moves[i].0 { assert FileOf(platform, documents, moves[i].0, doc'); }
      }
      if own.Some? && own.value == x {
        assert SameF(platform, document.binding.value.spelling, spelling);
      }
      FileAtIs(after, spelling, x);
      assert false;
    } else {
      var y :| y in after.disk && SameF(platform, y, spelling);
      if y == r.path {
        assert !Listed(platform, listing, spelling);
        assert CollideF(platform, spelling, r.path);
        assert MissingInTheWay(platform, listing, documents, doc, doc', r.path);
      } else if i :| 0 <= i < |moves| && y == moves[i].1 {
        assert !SameF(platform, spelling, moves[i].1);
      } else {
        assert y in disk;
      }
      assert false;
    }
  }

  // G5_NeverMixedUp and G7_MoveKeepsContents where the rule clears the way
  // (#1032), on a round step whose effects are the rule's, from a disk with
  // one file per name and a journal in which no two rows are bound to one
  // file (G5_NeverJoined). Where the rule defers instead, it changes no
  // binding and nothing on disk.
  lemma ClearWayG5G7(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires RuleStep(step, doc, r, input, revs)
    requires var device := step.pre.devices[step.event.device];
      OneFilePerName(device.platform, device.disk)
      && EffectsTake(device.platform, device.disk, step.effects, step.post.devices[step.event.device].disk)
    requires G5_NeverJoined(step.pre)
    requires var device := step.pre.devices[step.event.device];
      var documents := device.journal.documents;
      HeldForName(documents[doc], ApplyRevision(device.platform, doc, documents[doc], r, input, BoundNames(documents),
                                                AllClaims(documents), revs[doc]), r)
      && !UnsavedCollides(device.platform, input.unsaved, r.path)
    ensures G5_NeverMixedUp(step) && G7_MoveKeepsContents(step)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var platform := device.platform;
    var disk := device.disk;
    var documents := device.journal.documents;
    var document := documents[doc];
    var after := step.post.devices[d];
    var listing := input.listing;
    assert listing == ListingOf(device);
    assert NeverJoinedRows(platform, documents);
    var ruled := PathRule(platform, documents, doc, r, input, revs);
    assert ruled == ClearWay(platform, documents, doc, r, input, revs);
    var own := if document.binding.Some? && Listed(platform, listing, document.binding.value.spelling)
               then Some(ListedAt(platform, listing, document.binding.value.spelling)) else None;
    var way := InTheWay(platform, listing, r.path, own);
    var aside := Aside(platform, listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, own, aside.value) {
      // The rule defers: one report, nothing on disk changes, and no binding.
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      Unroll1(platform, disk, ruled.effects[0], after.disk);
      assert after.disk == disk;
      assert forall e | e in after.journal.documents :: e in documents && after.journal.documents[e].binding == documents[e].binding;
      assert forall e :: BoundIdentity(after, e) == BoundIdentity(device, e);
      return;
    }
    var moves := aside.value;
    HeldReadsSeen(platform, doc, document, r, input, BoundNames(documents), AllClaims(documents), revs[doc]);
    assert step.effects == MoveEffects(platform, documents, doc, moves) + Arrive(platform, doc, document, r, own);
    assert after.journal.documents == ClearRows(platform, documents, doc, r, input, moves, revs);
    ClearG7(device, after, documents, doc, r, input, own, moves);
    forall doc' | BoundIdentity(after, doc').Some? && BoundIdentity(after, doc') != BoundIdentity(device, doc')
      ensures EngineBrought(step.effects, platform, doc', after.journal.documents[doc'].binding.value.spelling)
    {
      ClearG5Doc(device, after, doc, r, input, revs, own, moves, doc');
    }
  }
}
