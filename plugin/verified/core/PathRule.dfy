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
             :: documents[d].outbox.value.path,
           {})
  }

  // The claims a conflict copy the apply writes avoids: every row's (as
  // the round's earlier revisions left them) and the round's first ones,
  // `first` (RoundClaims). A name an earlier revision of the round freed
  // stays taken until the round ends, so every copy is free against the
  // listing and the journal the round started from (CopiesTakeFreeNames).
  opaque function ApplyClaims(documents: map<DocId, Document>, first: Claims): Claims {
    var all := AllClaims(documents);
    Claims(all.paths + first.paths, all.names + first.names, all.listed + first.listed)
  }

  // The round's first claims: the journal's, and under F every file the
  // round's listing holds and every bound name.
  function RoundClaims(platform: Platform, journal: Journal, input: RoundInput): Claims {
    var all := AllClaims(journal.documents);
    Claims(all.paths, all.names, input.listing.Keys + BoundNames(journal.documents))
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

  lemma InTheWayHas(platform: Platform, listing: Listing, p: Path, own: Option<Path>, x: Path)
    requires x in listing && CollideF(platform, x, p) && own != Some(x)
    ensures x in InTheWay(platform, listing, p, own)
  {}

  // The document's own listed file, if any.
  function OwnFile(platform: Platform, document: Document, input: RoundInput): Option<Path>
    requires ListingDistinct(platform, input.listing)
  {
    if document.binding.Some? && Listed(platform, input.listing, document.binding.value.spelling)
    then Some(ListedAt(platform, input.listing, document.binding.value.spelling)) else None
  }

  // The round's read of the document's file where `r` is a remote move
  // against a local change (MovedAgainstChange, verified-core.md §4.2).
  function MoveRead(platform: Platform, document: Document, r: Revision, input: RoundInput): (read: Option<(Hash, Kind)>)
    requires ListingDistinct(platform, input.listing)
    ensures read.Some? ==> document.binding.Some? && document.base.Some? && !r.deleted
  {
    if document.binding.Some? && document.base.Some?
       && MovedAgainstChange(document, ListedRead(platform, input.listing, document.binding.value.spelling), r)
    then ListedRead(platform, input.listing, document.binding.value.spelling) else None
  }

  // The file the head arrives from: the document's own file, except where a
  // remote move against a local change keeps the two versions apart
  // (MovedContent is None). That file then stays as the untracked copy of
  // the local version (moved aside with the rest of the way where it
  // collides with the name), and the head is created at its name.
  opaque function Keeps(platform: Platform, document: Document, r: Revision, input: RoundInput): (keep: Option<Path>)
    requires ListingDistinct(platform, input.listing)
    ensures keep.Some? ==> keep == OwnFile(platform, document, input) && !Revives(platform, document, r, input)
  {
    var read := MoveRead(platform, document, r, input);
    // A revived document has no file here: a bound file with no base is
    // let go untracked, and moves aside where it is in the way (#1068).
    if Revives(platform, document, r, input) then None
    else if read.Some? && MovedContent(document, read.value, r).None? then None else OwnFile(platform, document, input)
  }

  // The row the head arrives with: for a remote move against a local
  // change, the document's file is what the round read.
  opaque function ArrivingRow(platform: Platform, document: Document, r: Revision, input: RoundInput): (row: Document)
    requires ListingDistinct(platform, input.listing)
    ensures row.binding.Some? == document.binding.Some?
    ensures row.binding.Some? ==> row.binding.value.spelling == document.binding.value.spelling
  {
    var read := MoveRead(platform, document, r, input);
    if read.Some? then document.(binding := Some(document.binding.value.(seen := read.value.0))) else document
  }

  // The revision the head arrives as: for a remote move against a local
  // change, at the remote's name with the settled content.
  opaque function Arriving(platform: Platform, document: Document, r: Revision, input: RoundInput): (arriving: Revision)
    requires ListingDistinct(platform, input.listing)
    ensures arriving.path == r.path
  {
    var read := MoveRead(platform, document, r, input);
    if read.Some? && MovedContent(document, read.value, r).Some? then
      r.(content := MovedContent(document, read.value, r).value.0, kind := MovedContent(document, read.value, r).value.1)
    else r
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
  // journal's rows `documents`, the round's input, the revision ids of
  // §3.1, and the round's first claims `first` (RoundClaims), which every
  // conflict copy the apply writes also avoids (ApplyClaims).
  function PathRule(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims): Ruled
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
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
    var own := OwnFile(platform, document, input);
    var way := InTheWay(platform, input.listing, r.path, Keeps(platform, document, r, input));
    // A bound file missing from the listing is the user's delete, and the
    // head brings it back (Revives, verified-core.md §4.2); any other
    // missing file waits.
    if r.deleted || (document.binding.Some? && own.None? && !Revives(platform, document, r, input)) then Defer(documents, doc, r, false)
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
              MoveEffects(platform, documents, doc, moves) + ArriveOf(platform, doc, document, r, input))
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
    requires ListingDistinct(platform, input.listing)
  {
    RecordMissing(platform, input.listing, documents, doc, r.path, MoveRows(platform, documents, doc, moves, revs), revs)
      [doc := HeadRow(platform, documents[doc], r, input, revs[doc])]
  }

  // The head's row: the document's base, at its name. A revived document's
  // delete loses to the head (Revived). A remote move against a local
  // change (verified-core.md §4.2) is the settled row at the remote's name
  // (Settled, an outbox only where the file differs from the head), or,
  // where the two versions are kept apart, the head with nothing to send:
  // the local version is the untracked copy, which the push sends as a new
  // document.
  opaque function HeadRow(platform: Platform, document: Document, r: Revision, input: RoundInput, rev: RevId): (row: Document)
    requires ListingDistinct(platform, input.listing)
    ensures row.binding.Some? && row.binding.value.spelling == r.path
    ensures row.base == Some(BaseOf(r)) && row.ahead.None?
  {
    var read := MoveRead(platform, document, r, input);
    var row := (if Revives(platform, document, r, input) then Revived(document) else document)
      .(base := Some(BaseOf(r)), ahead := None,
        binding := Some(Binding(r.path, r.content, false, None)), absence := Never);
    if read.None? then row
    else match MovedContent(document, read.value, r)
      case None => row.(outbox := KeptOutbox(document, r, None))
      case Some(settled) =>
        Settled(document.(binding := Some(document.binding.value.(spelling := r.path)), absence := Never), r, settled.0, rev)
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

  // The head's arrival for document `doc` where the rule clears the way.
  function ArriveOf(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput): seq<Effect>
    requires ListingDistinct(platform, input.listing)
  {
    Arrive(platform, doc, ArrivingRow(platform, document, r, input), Arriving(platform, document, r, input), Keeps(platform, document, r, input))
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
              && (forall s | s in claims.names :: !SameK(s, e.path))
              && (forall s | s in claims.listed :: !CollideF(platform, s, e.path)))
  {}

  // NoMoveFromUnsaved, on the rule: no file that collides with a path an
  // open editor holds unsaved text at is moved.
  lemma RuleNoMoveFromUnsaved(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var effects := PathRule(platform, documents, doc, r, input, revs, first).effects;
      forall i | 0 <= i < |effects| && effects[i].Move? :: !UnsavedCollides(platform, input.unsaved, effects[i].from)
  {
    var document := documents[doc];
    AppliedMovesAndCopies(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
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
    var own := OwnFile(platform, document, input);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var claims := AllClaims(documents);
    var aside := Aside(platform, input.listing, avoid, claims, way, r.path);
    AsideFrom(platform, input.listing, avoid, claims, way, r.path);
    if !r.deleted && !(document.binding.Some? && own.None? && !Revives(platform, document, r, input))
       && !((exists q | q in way :: UnsavedCollides(platform, input.unsaved, q))
            || (own.Some? && UnsavedCollides(platform, input.unsaved, own.value)))
       && !StillClaimed(platform, documents, doc, r.path) && aside.Some? {
      var moves := aside.value;
      MoveEffectsShape(platform, documents, doc, moves);
      var front := MoveEffects(platform, documents, doc, moves);
      var back := ArriveOf(platform, doc, document, r, input);
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
  lemma RuleHeldOnlyForUnsaved(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      ruled.documents.Keys == documents.Keys
      && (forall e | e in documents && e != doc :: ruled.documents[e].ahead == documents[e].ahead)
      && (ruled.documents[doc].ahead != documents[doc].ahead && ruled.documents[doc].ahead.Some?
          && ruled.documents[doc].ahead.value.blocker.PathHeld?
          ==> ruled.documents[doc].ahead.value.revision == r && UnsavedCollides(platform, input.unsaved, r.path))
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var own := OwnFile(platform, document, input);
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
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
  lemma RuleCopiesTakeFreeNames(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var effects := PathRule(platform, documents, doc, r, input, revs, first).effects;
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
    reveal ApplyClaims();
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    AppliedMovesAndCopies(platform, doc, document, r, input, bound, claims, revs[doc]);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      ClearWayWritesNoCopy(platform, documents, doc, r, input, revs);
    }
    forall e | e in PathRule(platform, documents, doc, r, input, revs, first).effects && e.Write? && e.target.None?
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
    var own := OwnFile(platform, document, input);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    if aside.Some? {
      MoveEffectsShape(platform, documents, doc, aside.value);
    }
  }

  // ---------------------------------------------------------------------
  // The rule keeps every row's invariant (CoreInv one row at a time)
  // ---------------------------------------------------------------------

  // The apply leaves a revision waiting for its name only for a document
  // with no change the server lacks, other than a commit in flight (which
  // the rule keeps as sealed, #1023).
  lemma HeldHasNoChange(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures HeldForName(document, ApplyRevision(platform, doc, document, r, input, bound, claims, rev), r)
            ==> !JournalChange(document) || Revives(platform, document, r, input) || MoveRead(platform, document, r, input).Some?
                || InFlight(document)
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
  lemma {:isolate_assertions} RuleKeepsRowInv(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires forall e | e in documents :: RowInv(documents[e])
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      ruled.documents.Keys == documents.Keys && forall e | e in ruled.documents :: RowInv(ruled.documents[e])
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    AppliedKeepsRowInv(platform, doc, document, r, input, bound, claims, revs[doc]);
    HeldHasNoChange(platform, doc, document, r, input, bound, claims, revs[doc]);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      ClearWayKeepsRowInv(platform, documents, doc, r, input, revs);
    }
  }

  // The rule proper keeps RowInv in every row, for a revision the apply
  // held for its name (so the row has no change but a revive, a move
  // against a change or a commit in flight, HeldHasNoChange).
  lemma {:isolate_assertions} ClearWayKeepsRowInv(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires forall e | e in documents :: RowInv(documents[e])
    requires Newer(documents[doc], r)
    requires var document := documents[doc];
      !JournalChange(document) || Revives(platform, document, r, input) || MoveRead(platform, document, r, input).Some?
      || InFlight(document)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      ruled.documents.Keys == documents.Keys && forall e | e in ruled.documents :: RowInv(ruled.documents[e])
  {
    reveal Keeps(), ArrivingRow(), Arriving();
    reveal HeadRow();
    var document := documents[doc];
    var own := OwnFile(platform, document, input);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    if aside.Some? {
      MoveRowsKeepRowInv(platform, documents, doc, aside.value, revs);
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
    requires own.Some? ==> document.binding.Some?
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
            && !Revives(platform, document, r, input)
      ==> var read := ListedRead(platform, input.listing, document.binding.value.spelling);
          read.Some? && read.value.0 == ArrivingRow(platform, document, r, input).binding.value.seen
          && ArrivingRow(platform, document, r, input).binding.value.spelling == document.binding.value.spelling
  {
    reveal Keeps(), ArrivingRow(), Arriving();
  }

  // Every disk effect of the rule has a precondition that holds, in order,
  // on the disk the round's listing was read from.
  lemma RulePreconditionsHold(device: Device, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires input.listing == ListingOf(device)
    requires ListingDistinct(device.platform, input.listing)
    ensures PreconditionsInOrder(device.platform, device.disk, PathRule(device.platform, documents, doc, r, input, revs, first).effects)
  {
    var platform := device.platform;
    var disk := device.disk;
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var effects := PathRule(platform, documents, doc, r, input, revs, first).effects;
    if !HeldForName(document, applied, r) {
      AppliedPreconditionsHold(device, doc, document, r, input, bound, claims, revs[doc]);
      return;
    }
    if UnsavedCollides(platform, input.unsaved, r.path) {
      OneEffect(platform, disk, effects[0]);
      return;
    }
    HeldReadsSeen(platform, doc, document, r, input, bound, claims, revs[doc]);
    var own := OwnFile(platform, document, input);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := bound + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if r.deleted || (document.binding.Some? && own.None? && !Revives(platform, document, r, input))
       || (exists q | q in way :: UnsavedCollides(platform, input.unsaved, q))
       || (own.Some? && UnsavedCollides(platform, input.unsaved, own.value))
       || StillClaimed(platform, documents, doc, r.path) || aside.None? {
      OneEffect(platform, disk, effects[0]);
      return;
    }
    var kept := if keep.Some? then {keep.value} else {};
    var tail := ArriveOf(platform, doc, document, r, input);
    var arow := ArrivingRow(platform, document, r, input);
    var ar := Arriving(platform, document, r, input);
    assert ar.path == r.path;
    if own.Some? {
      assert ListedRead(platform, input.listing, document.binding.value.spelling) == Some(input.listing[own.value]);
    }
    forall d' | AsideLeaves(platform, disk, way, r.path, kept, d') ensures PreconditionsInOrder(platform, d', tail) {
      ArriveInOrder(platform, doc, arow, ar, keep, disk, way, kept, d');
    }
    AsideInOrder(platform, documents, doc, input.listing, avoid, AllClaims(documents), way, r.path, disk, disk, way, kept, tail);
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
  ghost predicate RuleStep(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims) {
    step.event.SyncRound?
    && RoundInputOf(step.pre, step.event.device, input)
    && var d := step.event.device;
    var device := step.pre.devices[d];
    doc in device.journal.documents && device.journal.documents.Keys <= revs.Keys
    && ListingDistinct(device.platform, input.listing)
    && var ruled := PathRule(device.platform, device.journal.documents, doc, r, input, revs, first);
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
  lemma RuleMeetsContract(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RuleStep(step, doc, r, input, revs, first)
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
    RuleNoMoveFromUnsaved(platform, documents, doc, r, input, revs, first);
    RuleCopiesTakeFreeNames(platform, documents, doc, r, input, revs, first);
    RuleHeldOnlyForUnsaved(platform, documents, doc, r, input, revs, first);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
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
        var u := var u :| u in input.unsaved && CollideF(platform, u, r.path); u;
        var editor := var editor :| editor in device.editors && editor.unsaved.Some? && editor.path == u; editor;
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
  lemma RuleAcknowledges(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires Newer(documents[doc], r) && Acknowledges(documents[doc], r)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      && ruled.documents == documents[doc := if SettlesIdentical(platform, documents[doc], r, input)
                                             then IdenticalRow(documents[doc], r)
                                             else AcceptOn(documents[doc], BaseOf(r), revs[doc])]
      && ruled.effects == []
  {
    AcknowledgementSettles(platform, doc, documents[doc], r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
  }

  // The user's delete, or a bound file missing from the listing (the
  // user's delete, G3_DeleteSeen), against a live remote revision brings the
  // file back (ApplySettlesContract, verified-core.md §4.2, SPEC.md §6.3):
  // on the row after the rule, the file is bound at the revision's name,
  // holding its content, the revision is the base, and the user's delete is
  // dropped. The revision waits only where the device cannot hold it
  // (CannotHold) or unsaved text collides with its name (a user must act).
  // The outbox's own revision is its acknowledgement instead
  // (RuleAcknowledges), and a commit in flight stays as sealed (#1023).
  lemma RuleRevivesDeletedFile(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires forall e | e in documents :: RowInv(documents[e])
    requires Newer(documents[doc], r) && !Acknowledges(documents[doc], r) && Revives(platform, documents[doc], r, input)
    ensures var after := PathRule(platform, documents, doc, r, input, revs, first).documents[doc];
      && RowInv(after)
      && (after.ahead.None? ==>
            after.binding == Some(Binding(r.path, r.content, false, None))
            && after.base == Some(Base(r.id, r.position, r.path, r.content, r.kind, r.deleted))
            && after.outbox == KeptOutbox(documents[doc], r, None) && after.absence == Never)
      && (after.ahead.Some? ==>
            after.ahead.value.revision == r
            && (CannotHold(after.ahead.value.blocker)
                || (after.ahead.value.blocker.PathHeld? && UnsavedCollides(platform, input.unsaved, r.path))))
      // Where nothing is in the way (no listed file collides with the name,
      // no unsaved text at it or at a file let go untracked, no other
      // document's server claim), it comes back.
      && ((FreeIn(platform, input.listing, r.path) && !UnsavedCollides(platform, input.unsaved, r.path)
           && !(OwnFile(platform, documents[doc], input).Some?
                && UnsavedCollides(platform, input.unsaved, OwnFile(platform, documents[doc], input).value))
           && !StillClaimed(platform, documents, doc, r.path)) ==> after.ahead.None?)
      // ApplySettlesContract's clause, with a user's need to act being
      // unsaved text in the revision's way.
      && ((after.ahead.None? || !CannotHold(after.ahead.value.blocker)) && !UnsavedCollides(platform, input.unsaved, r.path)
          ==> after.binding.Some? && after.base == Some(Base(r.id, r.position, r.path, r.content, r.kind, r.deleted)))
  {
    reveal HeadRow();
    RuleKeepsRowInv(platform, documents, doc, r, input, revs, first);
  }

  // A remote move against a local change (ApplySettlesContract,
  // verified-core.md §4.2, SPEC.md §7: path and content merged apart): on
  // the row after the rule, the file takes the remote's name, the revision
  // is the base, and the content is settled as for an edit (MovedContent).
  // A side that left the content as it was takes the other's, two notes
  // the merge combines are merged, and the settled row (Settled) sends what
  // the file holds where it differs from the revision. Otherwise the file
  // read here stays as an untracked copy and the head is created at its
  // name, with nothing to send (a commit in flight stays as sealed, #1023).
  // The revision waits only where the device cannot hold it (CannotHold) or unsaved text collides with its name (a
  // user must act); where nothing is in the way it is settled.
  lemma RuleSettlesMoveAgainstChange(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires forall e | e in documents :: RowInv(documents[e])
    requires Newer(documents[doc], r) && !Acknowledges(documents[doc], r) && documents[doc].binding.Some?
    requires !UnsavedAt(platform, input.unsaved, documents[doc].binding.value.spelling)
    requires MovedAgainstChange(documents[doc], ListedRead(platform, input.listing, documents[doc].binding.value.spelling), r)
    ensures var document := documents[doc];
      var read := ListedRead(platform, input.listing, document.binding.value.spelling).value;
      var after := PathRule(platform, documents, doc, r, input, revs, first).documents[doc];
      && RowInv(after)
      && (after.ahead.None? ==>
            after.base == Some(Base(r.id, r.position, r.path, r.content, r.kind, r.deleted))
            && after.binding.Some? && after.binding.value.spelling == r.path
            && match MovedContent(document, read, r)
               case Some(settled) =>
                 after == Settled(document.(binding := Some(document.binding.value.(spelling := r.path)), absence := Never), r, settled.0, revs[doc])
               case None => after.binding == Some(Binding(r.path, r.content, false, None))
                            && after.outbox == KeptOutbox(document, r, None))
      && (after.ahead.Some? ==>
            after.ahead.value.revision == r
            && (CannotHold(after.ahead.value.blocker)
                || (after.ahead.value.blocker.PathHeld? && UnsavedCollides(platform, input.unsaved, r.path))))
      // Where nothing is in the way (no listed file other than its own
      // collides with the name, no unsaved text at the name or the file, no
      // other document's server claim), it is settled.
      && ((forall q | q in input.listing && CollideF(platform, q, r.path) :: SameF(platform, q, document.binding.value.spelling))
          && !UnsavedCollides(platform, input.unsaved, r.path)
          && !UnsavedCollides(platform, input.unsaved, ListedAt(platform, input.listing, document.binding.value.spelling))
          && !StillClaimed(platform, documents, doc, r.path) && MovedContent(document, read, r).Some?
          ==> after.ahead.None?)
  {
    reveal Keeps(), ArrivingRow(), Arriving();
    reveal HeadRow();
    RuleKeepsRowInv(platform, documents, doc, r, input, revs, first);
    var document := documents[doc];
    var read := ListedRead(platform, input.listing, document.binding.value.spelling);
    assert !Revives(platform, document, r, input);
    assert MoveRead(platform, document, r, input) == read;
    var own := OwnFile(platform, document, input);
    var spelling := document.binding.value.spelling;
    assert own == Some(ListedAt(platform, input.listing, spelling));
    if (forall q | q in input.listing && CollideF(platform, q, r.path) :: SameF(platform, q, spelling))
       && MovedContent(document, read.value, r).Some? {
      assert Keeps(platform, document, r, input) == own;
      var way := InTheWay(platform, input.listing, r.path, own);
      forall q | q in way ensures false {
        SameFIsEquivalence(platform, q, spelling, own.value);
      }
      assert way == {};
    }
  }

  // A commit in flight that the pulled revision does not answer stays as it
  // was sealed on the row after the rule too (ApplySettlesContract, #1061,
  // #1023): the rule settles a revision the apply hands it (a remote move, a
  // revived file, a held name) with the commit kept, and defers it with the
  // row as it was.
  lemma RuleKeepsCommitInFlight(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires InFlight(documents[doc]) && !Acknowledges(documents[doc], r)
    ensures PathRule(platform, documents, doc, r, input, revs, first).documents[doc].outbox == documents[doc].outbox
  {
    reveal HeadRow();
    AppliedKeepsCommitInFlight(platform, doc, documents[doc], r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
  }

  // ---------------------------------------------------------------------
  // ApplySettlesContract on the rule's row (#1024)
  // ---------------------------------------------------------------------

  // A user must act on the row (UserMustAct, on the round's input): unsaved
  // text at its bound name, a rejected commit, or a revision waiting for a
  // name that unsaved text is in the way of. `RuleMustActIsUserMustAct`
  // ties it to the step's state after.
  predicate MustActOn(platform: Platform, unsaved: set<Path>, row: Document) {
    (row.binding.Some? && UnsavedAt(platform, unsaved, row.binding.value.spelling))
    || (row.outbox.Some? && row.outbox.value.rejected)
    || (row.ahead.Some? && row.ahead.value.blocker.PathHeld? && UnsavedCollides(platform, unsaved, row.ahead.value.revision.path))
  }

  // The listing's read at the row's bound name, and whether an open editor
  // holds unsaved text there: ApplySettlesContract's `read` and `unsaved`.
  function ReadOf(platform: Platform, input: RoundInput, document: Document): Option<(Hash, Kind)>
    requires ListingDistinct(platform, input.listing)
  {
    if document.binding.Some? then ListedRead(platform, input.listing, document.binding.value.spelling) else None
  }

  predicate UnsavedOf(platform: Platform, input: RoundInput, document: Document) {
    document.binding.Some? && UnsavedAt(platform, input.unsaved, document.binding.value.spelling)
  }

  // The pull apply settles every pulled revision by what the row has here
  // (ApplySettlesContract, verified-core.md §4.2, #1068): on the row the
  // rule leaves, for every revision, row, listing and unsaved paths.
  lemma {:isolate_assertions} RuleSettlesContract(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision,
                                                  input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires forall e | e in documents :: RowInv(documents[e])
    ensures var after := PathRule(platform, documents, doc, r, input, revs, first).documents[doc];
      ApplySettlesContract(documents[doc], after, r, ReadOf(platform, input, documents[doc]),
                           UnsavedOf(platform, input, documents[doc]), MustActOn(platform, input.unsaved, after))
  {
    reveal HeadRow();
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var after := PathRule(platform, documents, doc, r, input, revs, first).documents[doc];
    RuleKeepsRowInv(platform, documents, doc, r, input, revs, first);
    if !Newer(document, r) {
      assert after == document;
      return;
    }
    if Acknowledges(document, r) {
      RuleAcknowledges(platform, documents, doc, r, input, revs, first);
      return;
    }
    if InFlight(document) {
      RuleKeepsCommitInFlight(platform, documents, doc, r, input, revs, first);
    }
    if Revives(platform, document, r, input) {
      RuleRevivesDeletedFile(platform, documents, doc, r, input, revs, first);
      return;
    }
    if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
        assert applied == Hold(document, r, LocalChanges);
        assert after == applied.document;
        return;
      }
      if MovedAgainstChange(document, read, r) && !SettlesIdentical(platform, document, r, input) && !Concurrent(document, read, r) {
        RuleSettlesMoveAgainstChange(platform, documents, doc, r, input, revs, first);
        return;
      }
    }
    if !HeldForName(document, applied, r) {
      assert after == applied.document;
      return;
    }
    assert !r.deleted;
    if UnsavedCollides(platform, input.unsaved, r.path) {
      assert after == applied.document;
      return;
    }
    assert after == ClearWay(platform, documents, doc, r, input, revs).documents[doc];
  }

  // MustActOn is UserMustAct on the rule's step: the step keeps the
  // device's editors and platform, and the round's unsaved paths are the
  // editors' (RoundInputOf).
  lemma RuleMustActIsUserMustAct(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RuleStep(step, doc, r, input, revs, first)
    ensures var d := step.event.device;
      var device := step.pre.devices[d];
      var after := PathRule(device.platform, device.journal.documents, doc, r, input, revs, first).documents[doc];
      UserMustAct(step.post.devices[d], doc) <==> MustActOn(device.platform, input.unsaved, after)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var post := step.post.devices[d];
    var platform := device.platform;
    var ruled := PathRule(platform, device.journal.documents, doc, r, input, revs, first);
    var after := ruled.documents[doc];
    assert input.unsaved == UnsavedPaths(device);
    assert post.editors == device.editors && post.platform == platform;
    assert post.journal.documents[doc] == after;
    forall p ensures HasUnsavedEdits(post, p) <==> UnsavedAt(platform, input.unsaved, p) {
      UnsavedSeen(device, input.unsaved, p);
      if UnsavedAt(platform, input.unsaved, p) {
        var u := var u :| u in input.unsaved && SameF(platform, u, p); u;
        var editor := var editor :| editor in device.editors && editor.unsaved.Some? && editor.path == u; editor;
      }
    }
    forall p ensures (exists editor :: editor in post.editors && editor.unsaved.Some? && CollideF(platform, editor.path, p))
                     <==> UnsavedCollides(platform, input.unsaved, p) {
      if UnsavedCollides(platform, input.unsaved, p) {
        var u := var u :| u in input.unsaved && CollideF(platform, u, p); u;
        var editor := var editor :| editor in device.editors && editor.unsaved.Some? && editor.path == u; editor;
      }
      if exists editor :: editor in post.editors && editor.unsaved.Some? && CollideF(platform, editor.path, p) {
        var editor := var editor :| editor in post.editors && editor.unsaved.Some? && CollideF(platform, editor.path, p); editor;
        assert editor.path in input.unsaved;
      }
    }
  }

  // On a round step whose effects are the rule's, from the core's rows
  // (CoreInv), the row the rule
  // leaves meets ApplySettlesContract, with `mustAct` UserMustAct in the
  // step's state after (Contracts.dfy).
  lemma RuleStepSettlesContract(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RuleStep(step, doc, r, input, revs, first)
    requires var device := step.pre.devices[step.event.device];
      (forall e | e in device.journal.documents :: RowInv(device.journal.documents[e]))
    ensures var d := step.event.device;
      var device := step.pre.devices[d];
      ApplySettlesContract(device.journal.documents[doc], step.post.devices[d].journal.documents[doc], r,
                           ReadOf(device.platform, input, device.journal.documents[doc]),
                           UnsavedOf(device.platform, input, device.journal.documents[doc]),
                           UserMustAct(step.post.devices[d], doc))
  {
    var device := step.pre.devices[step.event.device];
    RuleSettlesContract(device.platform, device.journal.documents, doc, r, input, revs, first);
    RuleMustActIsUserMustAct(step, doc, r, input, revs, first);
  }

  // Where the apply leaves nothing waiting for a name, the rule's step is the
  // pull apply's step (§3.9's `ApplyStep`, with every binding's name and
  // every row's claims), so the apply's guarantees hold for it: G2's step
  // predicates, G5_NeverMixedUp, G6_Settle and G7.
  lemma RulePassThroughGuarantees(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RuleStep(step, doc, r, input, revs, first)
    requires var d := step.event.device;
      step.post == step.pre.(devices := step.pre.devices[d := step.post.devices[d]])
    requires var device := step.pre.devices[step.event.device];
      OneFilePerName(device.platform, device.disk)
      && EffectsTake(device.platform, device.disk, step.effects, step.post.devices[step.event.device].disk)
    requires r.id in step.pre.server.accepted && step.pre.server.accepted[r.id] == r
    requires r.doc == doc && PulledBy(step.pre.devices[step.event.device].journal.documents[doc], r, step.event.device)
    requires NotBuiltOn(step.pre.devices[step.event.device].journal.documents[doc], r)
    requires var device := step.pre.devices[step.event.device];
      var documents := device.journal.documents;
      !HeldForName(documents[doc], ApplyRevision(device.platform, doc, documents[doc], r, input, BoundNames(documents),
                                                 ApplyClaims(documents, first), revs[doc]), r)
    ensures var device := step.pre.devices[step.event.device];
      ApplyStep(step, doc, r, input, BoundNames(device.journal.documents), ApplyClaims(device.journal.documents, first), revs[doc])
    ensures G2_OnlyWhatItSaw(step) && G2_UnsavedSafe(step) && G2_NoUntrackedDelete(step)
    ensures G5_NeverMixedUp(step)
    ensures forall d, doc', remote :: SettlesConcurrent(step, d, doc', remote) ==> G6_Settle(step, d, doc', remote)
    ensures G7_OneFilePerName(step.pre) ==> G7_OneFilePerName(step.post) && G7_MoveKeepsContents(step)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var documents := device.journal.documents;
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
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
        var e := var e :| e in documents && e != doc && FileOf(platform, documents, q, e) && LocallyPlaced(documents[e]); e;
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
  lemma RuleOneFilePerName(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RuleStep(step, doc, r, input, revs, first)
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
    var own := OwnFile(platform, document, input);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
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
           && e.precondition.value == ArrivingRow(device.platform, device.journal.documents[doc], r, input).binding.value.seen)
        && (e.Remove? ==>
           e.doc == doc && BoundTo(device, doc, e.path)
           && e.expected == ArrivingRow(device.platform, device.journal.documents[doc], r, input).binding.value.seen
           && Tracked(device, e.path))
  {
    reveal Keeps(), ArrivingRow(), Arriving();
    var platform := device.platform;
    var documents := device.journal.documents;
    var document := documents[doc];
    var own := OwnFile(platform, document, input);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
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
        var k := var k :| 0 <= k < |rest| && rest[k].0 == q'; k;
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
    var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk'); mid;
    assert c !in disk by { assert CollideF(platform, c, c); }
    assert MovableTo(platform, disk, q, q, c, content);
    var q': Path := var q': Path :| MovableTo(platform, disk, q', q, c, content) && mid == (disk - {q'})[c := disk[q']]; q';
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
        var k := var k :| 0 <= k < |rest| && x == rest[k].1; k;
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
    requires own.Some? ==> document.binding.Some?
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
      var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, remove, mid) && EffectTakes(platform, mid, write, disk'); mid;
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
        var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, write, mid) && EffectTakes(platform, mid, move, disk'); mid;
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
      var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, (a + b)[0], mid) && EffectsTake(platform, mid, (a + b)[1..], disk'); mid;
      assert (a + b)[0] == a[0];
      assert (a + b)[1..] == a[1..] + b;
      EffectsTakeSplit(platform, mid, a[1..], b, disk');
      var mid2: map<Path, DiskFile> := var mid2: map<Path, DiskFile> :| EffectsTake(platform, mid, a[1..], mid2) && EffectsTake(platform, mid2, b, disk'); mid2;
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
    var file := OwnFile(platform, document, input);
    own == Keeps(platform, document, r, input)
    && var way := InTheWay(platform, input.listing, r.path, own);
    !r.deleted && !(document.binding.Some? && file.None? && !Revives(platform, document, r, input))
    && !(exists q | q in way :: UnsavedCollides(platform, input.unsaved, q))
    && !(file.Some? && UnsavedCollides(platform, input.unsaved, file.value))
    && !StillClaimed(platform, documents, doc, r.path)
    && Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path) == Some(moves)
  }

  // On the disk the listing was read from, the rule's moves and the head's
  // arrival leave: each copy holding the file it moved, the head at its
  // name with its content, every file not in the way and not the
  // document's own as it was, and nothing else.
  lemma {:isolate_assertions} ClearWayDisk(device: Device, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                     own: Option<Path>, moves: seq<(Path, Path, Hash)>, disk': map<Path, DiskFile>)
    requires doc in documents && input.listing == ListingOf(device)
    requires OneFilePerName(device.platform, device.disk) && ListingDistinct(device.platform, input.listing)
    requires ClearsWith(device.platform, documents, doc, r, input, own, moves)
    requires documents[doc].binding.Some? && own.Some? ==>
      var read := ListedRead(device.platform, input.listing, documents[doc].binding.value.spelling);
      read.Some? && read.value.0 == ArrivingRow(device.platform, documents[doc], r, input).binding.value.seen
      && ArrivingRow(device.platform, documents[doc], r, input).binding.value.spelling == documents[doc].binding.value.spelling
    requires EffectsTake(device.platform, device.disk,
                         MoveEffects(device.platform, documents, doc, moves) + ArriveOf(device.platform, doc, documents[doc], r, input), disk')
    ensures OneFilePerName(device.platform, disk')
    ensures forall i | 0 <= i < |moves| ::
      moves[i].0 in device.disk && moves[i].1 in disk' && disk'[moves[i].1] == device.disk[moves[i].0]
      && device.disk[moves[i].0].content == moves[i].2 && moves[i].1 !in device.disk && !CollideF(device.platform, moves[i].1, r.path)
      && forall t | t in BoundNames(documents) :: !SameF(device.platform, t, moves[i].1)
    ensures r.path in disk' && disk'[r.path].content == Arriving(device.platform, documents[doc], r, input).content
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
    var back := ArriveOf(platform, doc, document, r, input);
    var arow := ArrivingRow(platform, document, r, input);
    var ar := Arriving(platform, document, r, input);
    assert back == Arrive(platform, doc, arow, ar, own);
    assert ar.path == r.path;
    EffectsTakeSplit(platform, disk, front, back, disk');
    var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :| EffectsTake(platform, disk, front, mid) && EffectsTake(platform, mid, back, disk'); mid;
    forall i | 0 <= i < |moves|
      ensures moves[i].0 in disk && disk[moves[i].0].content == moves[i].2 && FreeOn(platform, disk, moves[i].1)
      ensures moves[i].1 !in disk
    {
      assert moves[i].0 in way;
      assert CollideF(platform, moves[i].1, moves[i].1);
    }
    MovesTake(platform, documents, doc, moves, disk, mid);
    if own.Some? {
      assert own == OwnFile(platform, document, input);
      assert own.value in listing;
      assert ListedRead(platform, listing, document.binding.value.spelling) == Some(listing[own.value]);
      forall i | 0 <= i < |moves| ensures own.value != moves[i].0 { assert moves[i].0 in way; }
    }
    forall x | x in mid && Some(x) != own ensures !CollideF(platform, x, r.path) {
      if !(exists i | 0 <= i < |moves| :: x == moves[i].1) {
        assert x in disk && forall i | 0 <= i < |moves| :: x != moves[i].0;
        if CollideF(platform, x, r.path) {
          assert x in listing;
          InTheWayHas(platform, listing, r.path, own, x);
        }
      }
    }
    ArriveTakes(platform, doc, arow, ar, own, mid, disk');
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
    requires documents[doc].binding.Some? && own.Some? ==>
      var read := ListedRead(device.platform, input.listing, documents[doc].binding.value.spelling);
      read.Some? && read.value.0 == ArrivingRow(device.platform, documents[doc], r, input).binding.value.seen
      && ArrivingRow(device.platform, documents[doc], r, input).binding.value.spelling == documents[doc].binding.value.spelling
    requires EffectsTake(device.platform, device.disk,
                         MoveEffects(device.platform, documents, doc, moves) + ArriveOf(device.platform, doc, documents[doc], r, input), after.disk)
    ensures forall e | e in MoveEffects(device.platform, documents, doc, moves) + ArriveOf(device.platform, doc, documents[doc], r, input) && e.Move? ::
      HasFile(after, e.to) && FileAt(after, e.to).content == e.expected
  {
    var platform := device.platform;
    ClearWayDisk(device, documents, doc, r, input, own, moves, after.disk);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var back := ArriveOf(platform, doc, documents[doc], r, input);
    var effects := front + back;
    forall e: Effect | e in effects && e.Move?
      ensures HasFile(after, e.to) && FileAt(after, e.to).content == e.expected
    {
      var k := var k :| 0 <= k < |effects| && effects[k] == e; k;
      if k < |front| {
        assert e == front[k];
        FileAtIs(after, e.to, e.to);
      } else {
        assert e == back[k - |front|];
        assert back == Arrive(platform, doc, ArrivingRow(platform, documents[doc], r, input), Arriving(platform, documents[doc], r, input), own);
        assert e.to == r.path && e.expected == Arriving(platform, documents[doc], r, input).content;
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

  // The head's own binding after the rule clears the way: its row is at the
  // head's name, and the arrival's last effect writes or moves its file
  // there. Kept apart from ClearG5Doc so the case is proved in a small
  // context.
  lemma ClearG5Head(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                    moves: seq<(Path, Path, Hash)>, revs: FreshRevs, rows: map<DocId, Document>)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires rows == ClearRows(platform, documents, doc, r, input, moves, revs)
    ensures doc in rows && rows[doc].binding.Some? && rows[doc].binding.value.spelling == r.path
    ensures EngineBrought(MoveEffects(platform, documents, doc, moves) + ArriveOf(platform, doc, documents[doc], r, input),
                          platform, doc, rows[doc].binding.value.spelling)
  {
    var front := MoveEffects(platform, documents, doc, moves);
    var back := ArriveOf(platform, doc, documents[doc], r, input);
    assert rows[doc] == HeadRow(platform, documents[doc], r, input, revs[doc]);
    var arriving := Arriving(platform, documents[doc], r, input);
    assert arriving.path == r.path;
    var arrival := back[|back| - 1];
    assert arrival.Write? || arrival.Move?;
    assert (arrival.Write? && arrival.target == Some(doc) && arrival.path == r.path)
        || (arrival.Move? && arrival.mover == Some(doc) && arrival.to == r.path);
    assert (front + back)[|front| + |back| - 1] == arrival;
  }

  // A document whose file moves aside: it is bound after the rule only where
  // W(a) keeps it, and then the move to the copy's name is under its id.
  // Kept apart from ClearG5Doc so the case is proved in a small context.
  lemma ClearG5Aside(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput,
                     moves: seq<(Path, Path, Hash)>, revs: FreshRevs, rows: map<DocId, Document>, i: nat, doc': DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires rows == ClearRows(platform, documents, doc, r, input, moves, revs)
    requires i < |moves| && doc' in documents && doc' != doc && FileOf(platform, documents, moves[i].0, doc')
    requires doc' in MoveRows(platform, documents, doc, moves, revs)
    requires MoveRows(platform, documents, doc, moves, revs)[doc'] == MovedAside(documents[doc'], moves[i].1, revs[doc'])
    requires !MissingInTheWay(platform, input.listing, documents, doc, doc', r.path)
    requires doc' in rows && rows[doc'].binding.Some?
    ensures EngineBrought(MoveEffects(platform, documents, doc, moves) + ArriveOf(platform, doc, documents[doc], r, input),
                          platform, doc', rows[doc'].binding.value.spelling)
  {
    var front := MoveEffects(platform, documents, doc, moves);
    var back := ArriveOf(platform, doc, documents[doc], r, input);
    assert rows[doc'] == MovedAside(documents[doc'], moves[i].1, revs[doc']);
    if LocallyPlaced(documents[doc']) {
      assert rows[doc'].binding.value.spelling == moves[i].1;
      MoveEffectsMover(platform, documents, doc, moves, i, doc');
      assert (front + back)[i] == front[i];
    } else {
      assert rows[doc'].binding.None?;
    }
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
      documents[doc].binding.Some? && own.Some? ==>
        var read := ListedRead(device.platform, input.listing, documents[doc].binding.value.spelling);
        read.Some? && read.value.0 == ArrivingRow(device.platform, documents[doc], r, input).binding.value.seen
        && ArrivingRow(device.platform, documents[doc], r, input).binding.value.spelling == documents[doc].binding.value.spelling
    requires EffectsTake(device.platform, device.disk,
                         MoveEffects(device.platform, device.journal.documents, doc, moves)
                         + ArriveOf(device.platform, doc, device.journal.documents[doc], r, input), after.disk)
    requires after.journal.documents == ClearRows(device.platform, device.journal.documents, doc, r, input, moves, revs)
    requires BoundIdentity(after, doc').Some? && BoundIdentity(after, doc') != BoundIdentity(device, doc')
    ensures EngineBrought(MoveEffects(device.platform, device.journal.documents, doc, moves)
                          + ArriveOf(device.platform, doc, device.journal.documents[doc], r, input),
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
    var back := ArriveOf(platform, doc, document, r, input);
    var effects := front + back;
    var way := InTheWay(platform, listing, r.path, own);
    AsideFacts(platform, listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    var moved := MoveRows(platform, documents, doc, moves, revs);
    MoveRowsAheads(platform, documents, doc, moves, revs);
    assert own.Some? ==> own == OwnFile(platform, document, input);
    if doc' == doc {
      ClearG5Head(platform, documents, doc, r, input, moves, revs, after.journal.documents);
      return;
    }
    assert doc' in documents;
    forall i | 0 <= i < |moves| ensures moves[i].0 in listing { assert moves[i].0 in way; }
    MoveRowsRow(platform, documents, doc, moves, revs, listing, doc');
    if i :| 0 <= i < |moves| && FileOf(platform, documents, moves[i].0, doc') {
      assert moves[i].0 in listing;
      assert Listed(platform, listing, documents[doc'].binding.value.spelling);
      assert !MissingInTheWay(platform, listing, documents, doc, doc', r.path);
      assert after.journal.documents[doc'].binding.Some?;
      ClearG5Aside(platform, documents, doc, r, input, moves, revs, after.journal.documents, i, doc');
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
      var x := var x :| x in disk && SameF(platform, x, spelling); x;
      FileAtIs(device, spelling, x);
      forall i | 0 <= i < |moves| ensures x != moves[i].0 {
        if x == moves[i].0 { assert FileOf(platform, documents, moves[i].0, doc'); }
      }
      if own.Some? && own.value == x {
        assert own == OwnFile(platform, document, input);
        assert SameF(platform, document.binding.value.spelling, spelling);
      }
      assert Some(x) != own;
      assert x in after.disk && after.disk[x] == disk[x];
      FileAtIs(after, spelling, x);
      assert false;
    } else {
      var y := var y :| y in after.disk && SameF(platform, y, spelling); y;
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
  lemma ClearWayG5G7(step: Step, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires RuleStep(step, doc, r, input, revs, first)
    requires var device := step.pre.devices[step.event.device];
      OneFilePerName(device.platform, device.disk)
      && EffectsTake(device.platform, device.disk, step.effects, step.post.devices[step.event.device].disk)
    requires G5_NeverJoined(step.pre)
    requires var device := step.pre.devices[step.event.device];
      var documents := device.journal.documents;
      HeldForName(documents[doc], ApplyRevision(device.platform, doc, documents[doc], r, input, BoundNames(documents),
                                                ApplyClaims(documents, first), revs[doc]), r)
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
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    assert ruled == ClearWay(platform, documents, doc, r, input, revs);
    var own := OwnFile(platform, document, input);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, listing, r.path, keep);
    var aside := Aside(platform, listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      // The rule defers: one report, nothing on disk changes, and no binding.
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      Unroll1(platform, disk, ruled.effects[0], after.disk);
      assert after.disk == disk;
      assert forall e | e in after.journal.documents :: e in documents && after.journal.documents[e].binding == documents[e].binding;
      assert forall e :: BoundIdentity(after, e) == BoundIdentity(device, e);
      return;
    }
    var moves := aside.value;
    HeldReadsSeen(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    assert step.effects == MoveEffects(platform, documents, doc, moves) + ArriveOf(platform, doc, document, r, input);
    assert after.journal.documents == ClearRows(platform, documents, doc, r, input, moves, revs);
    ClearG7(device, after, documents, doc, r, input, keep, moves);
    forall doc' | BoundIdentity(after, doc').Some? && BoundIdentity(after, doc') != BoundIdentity(device, doc')
      ensures EngineBrought(step.effects, platform, doc', after.journal.documents[doc'].binding.value.spelling)
    {
      ClearG5Doc(device, after, doc, r, input, revs, keep, moves, doc');
    }
  }

  // ---------------------------------------------------------------------
  // The sync round (#982, #1033, docs/design/verified-core.md §3.14)
  // ---------------------------------------------------------------------
  //
  // The round's body lives here, in the module of the path rule it calls:
  // Dafny 4.11's resolver crashes on a module refining PathRuleCore, as on
  // one refining ApplyCore (Contracts.dfy).

  // The shell's intent ids (§4.4): any ids, one per intent of a round. A
  // contract-only function like CopyCandidate; the compiled core numbers
  // them.
  function IntentIdOf(n: nat): IntentId

  // A disk effect (IsDiskEffect, compiled).
  predicate IsDisk(effect: Effect) {
    effect.Write? || effect.Remove? || effect.Move?
  }

  // The intent recorded before a disk effect of the rule for revision `r`
  // of document `doc` (Covers): a write or a remove of a document is
  // applying a revision to it, a write of no document is a conflict copy
  // of the merge, and a move is a displacement of the file it moves.
  function CoverOf(doc: DocId, r: Revision, effect: Effect): IntentKind {
    match effect
    case Write(target, path, content, _, _) =>
      if target.Some? then ApplyIntent(target.value, r) else MergeIntent(doc, r, path, content, None)
    case Remove(target, _, _) => ApplyIntent(target, r)
    case Move(_, from, to, expected) => DisplaceIntent(doc, from, to, expected)
    case _ => ApplyIntent(doc, r)
  }

  // One intent per disk effect, numbered from `n`.
  function IntentsFor(doc: DocId, r: Revision, effects: seq<Effect>, n: nat): seq<Intent>
    decreases |effects|
  {
    if |effects| == 0 then []
    else (if IsDisk(effects[0]) then [Intent(IntentIdOf(n), CoverOf(doc, r, effects[0]))] else [])
         + IntentsFor(doc, r, effects[1..], n + 1)
  }

  // ListingDistinct, compiled: the round checks it of the listing it
  // keeps up to date before each revision (the path rule's precondition).
  predicate Distinct(platform: Platform, listing: Listing)
    ensures Distinct(platform, listing) == ListingDistinct(platform, listing)
  {
    forall p, q | p in listing && q in listing :: p != q ==> !SameF(platform, p, q)
  }

  // The listing after one effect took effect: the round reads no disk
  // between revisions, so it keeps its listing as its own effects leave
  // the disk. A write conditional on content overwrites the listed file in
  // place, one conditional on no file creates one, a remove drops the
  // file and a move renames it.
  function ListingAfterEffect(platform: Platform, listing: Listing, effect: Effect): Listing {
    if !Distinct(platform, listing) then listing
    else match effect
      case Write(_, path, content, kind, precondition) =>
        if Listed(platform, listing, path) then
          if precondition.Some? then listing[ListedAt(platform, listing, path) := (content, kind)] else listing
        else if precondition.None? then listing[path := (content, kind)] else listing
      case Remove(_, path, _) =>
        if Listed(platform, listing, path) then listing - {ListedAt(platform, listing, path)} else listing
      case Move(_, from, to, _) =>
        if Listed(platform, listing, from) then
          var q := ListedAt(platform, listing, from);
          (listing - {q})[to := listing[q]]
        else listing
      case _ => listing
  }

  function ListingAfter(platform: Platform, listing: Listing, effects: seq<Effect>): Listing
    decreases |effects|
  {
    if |effects| == 0 then listing
    else ListingAfter(platform, ListingAfterEffect(platform, listing, effects[0]), effects[1..])
  }

  // The row of a document the journal does not know yet: another device
  // created it.
  function NoRow(): Document {
    Document(None, None, None, Never, None)
  }

  // The round's state between revisions: the journal (its documents
  // replaced as each revision is settled, no open intent), the listing as
  // the round's effects leave the disk, the effects so far, and the next
  // intent number.
  datatype RoundPass = RoundPass(journal: Journal, listing: Listing, effects: seq<Effect>, n: nat)

  // The revision ids of §3.1 for every row the rule may touch. A row the
  // round itself added (another device's new document) has none in
  // `revs` (RevsCover is about the journal before the round); the rule
  // opens no outbox on a row with no binding and no base (#1034 proves
  // it), so its revision's own id stands in.
  function RevsFor(documents: map<DocId, Document>, revs: FreshRevs, r: Revision): (revs': FreshRevs)
    ensures documents.Keys <= revs'.Keys
  {
    map doc | doc in documents.Keys + revs.Keys :: if doc in revs then revs[doc] else r.id
  }

  // One revision `r` in the round: out of scope it waits (OutOfScope, a
  // CannotHold blocker, §2.3); otherwise the path rule settles it against
  // the listing as the round's earlier effects left it. Its disk effects
  // come after a PersistJournal whose intents cover them (§4.3,
  // IntentsCoverDiskEffects).
  function SettleRevision(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims): RoundPass {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if !Distinct(platform, pass.listing) then pass
    else if r.path in input.outOfScope then
      if Newer(row, r) then
        pass.(journal := pass.journal.(documents := documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))]))
      else pass
    else
      var rows := documents[doc := row];
      var ruled := PathRule(platform, rows, doc, r, input.(listing := pass.listing), RevsFor(rows, revs, r), first);
      var intents := IntentsFor(doc, r, ruled.effects, pass.n);
      var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
      RoundPass(pass.journal.(documents := ruled.documents), ListingAfter(platform, pass.listing, ruled.effects),
           pass.effects + guard + ruled.effects, pass.n + |ruled.effects|)
  }

  function SettlePulled(platform: Platform, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims): RoundPass
    decreases |revisions|
  {
    if |revisions| == 0 then pass
    else SettlePulled(platform, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first)
  }

  // The rows waiting since an earlier round (an `ahead`), in order. The
  // round retries each: it clears the ahead, which makes its revision
  // newer again, and settles it as a pulled one (ApplySettlesContract,
  // #1071).
  function WaitingRows(documents: map<DocId, Document>): seq<DocId> {
    DocsInOrder(set doc | doc in documents && documents[doc].ahead.Some?)
  }

  function RetryWaiting(platform: Platform, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims): RoundPass
    decreases |docs|
  {
    if |docs| == 0 then pass
    else
      var documents := pass.journal.documents;
      var pass' :=
        if docs[0] in documents && documents[docs[0]].ahead.Some? then
          var row := documents[docs[0]];
          var r := row.ahead.value.revision;
          SettleRevision(platform, pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)])), docs[0], r, input, revs, first)
        else pass;
      RetryWaiting(platform, pass', docs[1..], input, revs, first)
  }

  // The listing the push reads: the files in the device's scope (#1006,
  // §2.3), so an untracked file at an out-of-scope path gets no document.
  function InScope(listing: Listing, outOfScope: set<Path>): Listing {
    map p | p in listing && p !in outOfScope :: listing[p]
  }

  // The sync round (verified-core.md §3.14): the pull from the cursor
  // (`Pull`), the retry of the waiting rows, then every pulled revision in
  // feed order, settled by the apply and the path rule; the cursor moves
  // past the feed read (`cursor'`, and `anchor'` to its last entry), and
  // the push half (§3.8) creates the documents of the untracked in-scope
  // files left and sends every outbox. `pulled` are the revisions the pull
  // read, in feed order.
  function OnRound(platform: Platform, journal: Journal, pulled: seq<Revision>, cursor': nat, ghost anchor': Option<RevId>,
                   input: RoundInput, revs: FreshRevs): (Journal, seq<Effect>)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
  {
    // A round starts from a journal with no open intent: the restart's
    // recovery settles them first (§4.3).
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var push := OnPush(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
    (push.0, settled.effects + push.1)
  }

  // The revisions the pull reads: the feed's entries `ids` the server
  // holds, in feed order.
  ghost function Revisions(server: Server, ids: seq<RevId>): seq<Revision>
    decreases |ids|
  {
    if |ids| == 0 then []
    else (if ids[0] in server.revisions then [server.revisions[ids[0]]] else []) + Revisions(server, ids[1..])
  }

  // The disk after the round's effects (DisksFollowEffects), where they
  // can take effect.
  ghost function DiskAfter(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>): map<Path, DiskFile> {
    if exists disk' :: EffectsTake(platform, disk, effects, disk')
    then var disk' :| EffectsTake(platform, disk, effects, disk'); disk'
    else disk
  }

  ghost function RoundStepOf(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs): Step
  {
    var device := pre.devices[d];
    var journal := device.journal;
    var feed := pre.server.feed;
    var behind := journal.cursor < |feed|;
    var pulled := if behind then Revisions(pre.server, feed[journal.cursor..]) else [];
    var cursor' := if behind then |feed| else journal.cursor;
    var anchor' := if behind then Some(feed[|feed| - 1]) else journal.anchor;
    var answer := if forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
                  then OnRound(device.platform, journal, pulled, cursor', anchor', input, revs)
                  else (journal, []);
    var device' := device.(journal := answer.0, disk := DiskAfter(device.platform, device.disk, answer.1));
    Step(pre, SyncRound(d), answer.1, pre.(devices := pre.devices[d := device']))
  }

  // ---------------------------------------------------------------------
  // The round's contract (RoundContract, #1033): the effects
  // ---------------------------------------------------------------------

  // The apply's and the rule's effects are disk effects and reports: no
  // journal is persisted and nothing is committed before the push.
  predicate RuleShaped(effects: seq<Effect>) {
    forall i | 0 <= i < |effects| :: IsDisk(effects[i]) || effects[i].Report?
  }

  lemma ApplyShaped(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures RuleShaped(ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects)
  {}

  lemma RuleShapedEffects(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures RuleShaped(PathRule(platform, documents, doc, r, input, revs, first).effects)
  {
    var document := documents[doc];
    ApplyShaped(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var way := InTheWay(platform, input.listing, r.path, Keeps(platform, document, r, input));
      var avoid := BoundNames(documents) + input.unsaved;
      var claims := AllClaims(documents);
      var aside := Aside(platform, input.listing, avoid, claims, way, r.path);
      if aside.Some? {
        MoveEffectsShape(platform, documents, doc, aside.value);
      }
    }
  }

  // Every intent IntentsFor records covers its disk effect.
  lemma IntentsForCover(doc: DocId, r: Revision, effects: seq<Effect>, n: nat)
    ensures forall i | 0 <= i < |effects| && IsDiskEffect(effects[i]) ::
      exists intent :: intent in IntentsFor(doc, r, effects, n) && Covers(intent.kind, effects[i])
    decreases |effects|
  {
    if |effects| > 0 {
      IntentsForCover(doc, r, effects[1..], n + 1);
      var intents := IntentsFor(doc, r, effects, n);
      var rest := IntentsFor(doc, r, effects[1..], n + 1);
      forall i | 0 <= i < |effects| && IsDiskEffect(effects[i])
        ensures exists intent :: intent in intents && Covers(intent.kind, effects[i])
      {
        if i == 0 {
          var intent := Intent(IntentIdOf(n), CoverOf(doc, r, effects[0]));
          assert intent in intents;
        } else {
          assert effects[i] == effects[1..][i - 1];
          var intent := var intent :| intent in rest && Covers(intent.kind, effects[1..][i - 1]); intent;
          assert intent in intents;
        }
      }
    }
  }

  // The round's effects so far: every disk effect comes after a persisted
  // intent that covers it, nothing is committed yet, no move takes a file
  // unsaved text collides with, and the journal the round carries has no
  // open intent.
  ghost predicate Guarded(platform: Platform, unsaved: set<Path>, pass: RoundPass) {
    pass.journal.intents == []
    && (forall i :: 0 <= i < |pass.effects| && pass.effects[i].Move? ==> !UnsavedCollides(platform, unsaved, pass.effects[i].from))
    && (forall i :: 0 <= i < |pass.effects| ==> !pass.effects[i].Commit?)
    && (forall i :: 0 <= i < |pass.effects| && IsDiskEffect(pass.effects[i]) ==>
          exists j :: 0 <= j < i && pass.effects[j].PersistJournal?
            && exists intent :: intent in pass.effects[j].journal.intents && Covers(intent.kind, pass.effects[i]))
  }

  lemma {:isolate_assertions} SettleGuarded(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires Guarded(platform, input.unsaved, pass)
    ensures Guarded(platform, input.unsaved, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
      var rows := documents[doc := row];
      var revs' := RevsFor(rows, revs, r);
      var ruled := PathRule(platform, rows, doc, r, input.(listing := pass.listing), revs', first);
      RuleShapedEffects(platform, rows, doc, r, input.(listing := pass.listing), revs', first);
      RuleNoMoveFromUnsaved(platform, rows, doc, r, input.(listing := pass.listing), revs', first);
      var intents := IntentsFor(doc, r, ruled.effects, pass.n);
      IntentsForCover(doc, r, ruled.effects, pass.n);
      var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
      var after := SettleRevision(platform, pass, doc, r, input, revs, first);
      assert after.effects == pass.effects + guard + ruled.effects;
      var k := |pass.effects|;
      forall i | 0 <= i < |after.effects| && IsDiskEffect(after.effects[i])
        ensures exists j :: 0 <= j < i && after.effects[j].PersistJournal?
                  && exists intent :: intent in after.effects[j].journal.intents && Covers(intent.kind, after.effects[i])
      {
        if i < k {
          assert after.effects[i] == pass.effects[i];
          var j := var j :| 0 <= j < i && pass.effects[j].PersistJournal?
            && exists intent :: intent in pass.effects[j].journal.intents && Covers(intent.kind, pass.effects[i]); j;
          assert after.effects[j] == pass.effects[j];
        } else {
          var e := after.effects[i];
          assert e == ruled.effects[i - k - |guard|];
          var intent := var intent :| intent in intents && Covers(intent.kind, e); intent;
          assert |guard| == 1;
          assert after.effects[k] == guard[0];
        }
      }
      forall i | 0 <= i < |after.effects|
        ensures !after.effects[i].Commit?
        ensures after.effects[i].Move? ==> !UnsavedCollides(platform, input.unsaved, after.effects[i].from)
      {
        if i >= k + |guard| { assert after.effects[i] == ruled.effects[i - k - |guard|]; }
        else if i >= k { assert after.effects[i] == guard[i - k]; }
        else { assert after.effects[i] == pass.effects[i]; }
      }
    }
  }

  lemma SettleAllGuarded(platform: Platform, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires Guarded(platform, input.unsaved, pass)
    ensures Guarded(platform, input.unsaved, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleGuarded(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleAllGuarded(platform, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryGuarded(platform: Platform, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires Guarded(platform, input.unsaved, pass)
    ensures Guarded(platform, input.unsaved, RetryWaiting(platform, pass, docs, input, revs, first))
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        SettleGuarded(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryGuarded(platform, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryGuarded(platform, pass, docs[1..], input, revs, first);
      }
    }
  }

  // ---------------------------------------------------------------------
  // CopiesTakeFreeNames over the round
  // ---------------------------------------------------------------------

  // A copy name is free against the round's first claims `first` (its
  // listing and bound names under F, its rows' server claims under K) and
  // collides with no unsaved path.
  ghost predicate CopyAvoids(platform: Platform, unsaved: set<Path>, first: Claims, c: Path) {
    (forall s | s in first.listed :: !CollideF(platform, s, c))
    && (forall s | s in first.paths :: !CollideK(s, c))
    && (forall s | s in first.names :: !SameK(s, c))
    && (forall u | u in unsaved :: !SameF(platform, u, c))
  }

  ghost predicate CopiesAvoid(platform: Platform, unsaved: set<Path>, first: Claims, effects: seq<Effect>) {
    forall i :: 0 <= i < |effects| && effects[i].Write? && effects[i].target.None?
      ==> CopyAvoids(platform, unsaved, first, effects[i].path)
  }

  // Every copy the rule writes avoids `first`: the apply names it against
  // ApplyClaims, which holds `first`, and clearing the way writes none.
  lemma RuleCopiesAvoidFirst(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures CopiesAvoid(platform, input.unsaved, first, PathRule(platform, documents, doc, r, input, revs, first).effects)
  {
    reveal ApplyClaims();
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    AppliedMovesAndCopies(platform, doc, document, r, input, bound, claims, revs[doc]);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      ClearWayWritesNoCopy(platform, documents, doc, r, input, revs);
    }
    var effects := PathRule(platform, documents, doc, r, input, revs, first).effects;
    forall i | 0 <= i < |effects| && effects[i].Write? && effects[i].target.None?
      ensures CopyAvoids(platform, input.unsaved, first, effects[i].path)
    {
      assert effects[i] in effects;
    }
  }

  lemma {:isolate_assertions} SettleCopiesAvoid(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires CopiesAvoid(platform, input.unsaved, first, pass.effects)
    ensures CopiesAvoid(platform, input.unsaved, first, SettleRevision(platform, pass, doc, r, input, revs, first).effects)
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
      var rows := documents[doc := row];
      var revs' := RevsFor(rows, revs, r);
      var ruled := PathRule(platform, rows, doc, r, input.(listing := pass.listing), revs', first);
      RuleCopiesAvoidFirst(platform, rows, doc, r, input.(listing := pass.listing), revs', first);
      var intents := IntentsFor(doc, r, ruled.effects, pass.n);
      var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
      var after := SettleRevision(platform, pass, doc, r, input, revs, first);
      assert after.effects == pass.effects + guard + ruled.effects;
      var k := |pass.effects|;
      forall i | 0 <= i < |after.effects| && after.effects[i].Write? && after.effects[i].target.None?
        ensures CopyAvoids(platform, input.unsaved, first, after.effects[i].path)
      {
        if i >= k + |guard| { assert after.effects[i] == ruled.effects[i - k - |guard|]; }
        else if i >= k { assert after.effects[i] == guard[i - k]; }
        else { assert after.effects[i] == pass.effects[i]; }
      }
    }
  }

  lemma SettleAllCopiesAvoid(platform: Platform, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires CopiesAvoid(platform, input.unsaved, first, pass.effects)
    ensures CopiesAvoid(platform, input.unsaved, first, SettlePulled(platform, pass, revisions, input, revs, first).effects)
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleCopiesAvoid(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettleAllCopiesAvoid(platform, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryCopiesAvoid(platform: Platform, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires CopiesAvoid(platform, input.unsaved, first, pass.effects)
    ensures CopiesAvoid(platform, input.unsaved, first, RetryWaiting(platform, pass, docs, input, revs, first).effects)
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        SettleCopiesAvoid(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryCopiesAvoid(platform, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryCopiesAvoid(platform, pass, docs[1..], input, revs, first);
      }
    }
  }

  // The push writes nothing: it persists the journal and commits.
  lemma PushWritesNothing(platform: Platform, journal: Journal, input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures forall e | e in OnPush(platform, journal, input, revs).1 :: !e.Write?
  {}

  // Every copy the round writes avoids its first claims.
  lemma OnRoundCopies(platform: Platform, journal: Journal, pulled: seq<Revision>, cursor': nat, anchor': Option<RevId>,
                      input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures CopiesAvoid(platform, input.unsaved, RoundClaims(platform, journal, input),
                        OnRound(platform, journal, pulled, cursor', anchor', input, revs).1)
  {
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    RetryCopiesAvoid(platform, start, WaitingRows(journal.documents), input, revs, first);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    SettleAllCopiesAvoid(platform, retried, pulled, input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    var push := OnPush(platform, read, input', revs);
    PushWritesNothing(platform, read, input', revs);
    var effects := settled.effects + push.1;
    var k := |settled.effects|;
    forall i | 0 <= i < |effects| && effects[i].Write? && effects[i].target.None?
      ensures CopyAvoids(platform, input.unsaved, first, effects[i].path)
    {
      if i >= k { assert effects[i] == push.1[i - k]; assert push.1[i - k] in push.1; }
    }
  }

  // The round's effects: crash-safe (IntentsCoverDiskEffects) and every
  // commit persisted first (CommitsPersistedFirst, #977); the round moves
  // the cursor past the feed it read and sets the anchor to its last entry.
  lemma OnRoundEffects(platform: Platform, journal: Journal, pulled: seq<Revision>, cursor': nat, anchor': Option<RevId>,
                       input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures var answer := OnRound(platform, journal, pulled, cursor', anchor', input, revs);
      IntentsCoverDiskEffects(answer.1) && CommitsPersistedFirst(answer.1)
      && answer.0.cursor == cursor' && answer.0.anchor == anchor'
      && forall i | 0 <= i < |answer.1| && answer.1[i].Move? :: !UnsavedCollides(platform, input.unsaved, answer.1[i].from)
  {
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    RetryGuarded(platform, start, WaitingRows(journal.documents), input, revs, first);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    SettleAllGuarded(platform, retried, pulled, input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    var push := OnPush(platform, read, input', revs);
    PushCommitsSealedPersisted(platform, read, input', revs);
    PushKeepsReadPosition(platform, read, input', revs);
    var effects := settled.effects + push.1;
    var k := |settled.effects|;
    assert push.1[0] == PersistJournal(push.0);
    assert push.0.intents == [];
    assert forall i | 1 <= i < |push.1| :: push.1[i].Commit?;
    forall i | 0 <= i < |effects| && IsDiskEffect(effects[i])
      ensures i < k
    {
      if i >= k { assert effects[i] == push.1[i - k]; }
    }
    forall i | 0 <= i < |effects| && IsDiskEffect(effects[i])
      ensures exists j :: 0 <= j < i && effects[j].PersistJournal?
                && exists intent :: intent in effects[j].journal.intents && Covers(intent.kind, effects[i])
    {
      assert effects[i] == settled.effects[i];
      var j := var j :| 0 <= j < i && settled.effects[j].PersistJournal?
        && exists intent :: intent in settled.effects[j].journal.intents && Covers(intent.kind, settled.effects[i]); j;
      assert effects[j] == settled.effects[j];
    }
    forall i | 0 <= i < |effects| && effects[i].Move? ensures !UnsavedCollides(platform, input.unsaved, effects[i].from) {
      if i >= k { assert effects[i] == push.1[i - k]; }
      else { assert effects[i] == settled.effects[i]; }
    }
    assert effects[k] == push.1[0];
    forall i | k < i < |effects| ensures !IsDiskEffect(effects[i]) && !effects[i].PersistJournal? {
      assert effects[i] == push.1[i - k];
    }
    forall i | 0 <= i < |effects| && effects[i].Commit?
      ensures effects[i].outbox.sealed
      ensures exists j :: 0 <= j < i && effects[j].PersistJournal?
                && effects[i].doc in effects[j].journal.documents
                && effects[j].journal.documents[effects[i].doc].outbox == Some(effects[i].outbox)
    {
      assert i >= k;
      assert effects[i] == push.1[i - k];
      var j := var j :| 0 <= j < i - k && push.1[j].PersistJournal?
        && push.1[i - k].doc in push.1[j].journal.documents
        && push.1[j].journal.documents[push.1[i - k].doc].outbox == Some(push.1[i - k].outbox); j;
      assert effects[j + k] == push.1[j];
    }
  }

  // ---------------------------------------------------------------------
  // The round's contract (RoundContract, #1033): held names
  // ---------------------------------------------------------------------

  // Every row outside `except` held for its name (PathHeld) is held by
  // unsaved text that collides with the name.
  ghost predicate HeldForUnsaved(platform: Platform, unsaved: set<Path>, documents: map<DocId, Document>, except: set<DocId>) {
    forall e | e in documents && e !in except && documents[e].ahead.Some? && documents[e].ahead.value.blocker.PathHeld? ::
      UnsavedCollides(platform, unsaved, documents[e].ahead.value.revision.path)
  }

  lemma SettleKeepsHeld(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, except: set<DocId>, first: Claims)
    requires HeldForUnsaved(platform, input.unsaved, pass.journal.documents, except)
    requires doc in except && doc in pass.journal.documents ==> pass.journal.documents[doc].ahead.None?
    ensures HeldForUnsaved(platform, input.unsaved, SettleRevision(platform, pass, doc, r, input, revs, first).journal.documents, except - {doc})
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
      var rows := documents[doc := row];
      var revs' := RevsFor(rows, revs, r);
      RuleHeldOnlyForUnsaved(platform, rows, doc, r, input.(listing := pass.listing), revs', first);
    }
  }

  lemma SettlePulledKeepsHeld(platform: Platform, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires HeldForUnsaved(platform, input.unsaved, pass.journal.documents, {})
    ensures HeldForUnsaved(platform, input.unsaved, SettlePulled(platform, pass, revisions, input, revs, first).journal.documents, {})
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsHeld(platform, pass, revisions[0].doc, revisions[0], input, revs, {}, first);
      SettlePulledKeepsHeld(platform, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  // A row still to retry is excepted; a retried one is held only by
  // unsaved text.
  lemma RetryKeepsHeld(platform: Platform, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires HeldForUnsaved(platform, input.unsaved, pass.journal.documents, set i | 0 <= i < |docs| :: docs[i])
    ensures HeldForUnsaved(platform, input.unsaved, RetryWaiting(platform, pass, docs, input, revs, first).journal.documents, {})
    decreases |docs|
  {
    if |docs| > 0 {
      var all := set i | 0 <= i < |docs| :: docs[i];
      var rest := set i | 0 <= i < |docs[1..]| :: docs[1..][i];
      assert all - {docs[0]} <= rest by {
        forall x | x in all - {docs[0]} ensures x in rest {
          var i := var i :| 0 <= i < |docs| && docs[i] == x; i;
          assert i > 0 && docs[1..][i - 1] == x;
        }
      }
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        SettleKeepsHeld(platform, cleared, docs[0], row.ahead.value.revision, input, revs, all, first);
        RetryKeepsHeld(platform, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsHeld(platform, pass, docs[1..], input, revs, first);
      }
    }
  }

  // The push changes no row's ahead and creates rows with none.
  lemma PushKeepsAheads(platform: Platform, journal: Journal, input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures var journal' := OnPush(platform, journal, input, revs).0;
      forall doc | doc in journal'.documents ::
        journal'.documents[doc].ahead == (if doc in journal.documents then journal.documents[doc].ahead else None)
  {}

  // PathRuleContract's last clause, on the round's handler: after it, a
  // row is held for its name only by unsaved text.
  lemma OnRoundHeld(platform: Platform, journal: Journal, pulled: seq<Revision>, cursor': nat, anchor': Option<RevId>,
                    input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures HeldForUnsaved(platform, input.unsaved, OnRound(platform, journal, pulled, cursor', anchor', input, revs).0.documents, {})
  {
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    var waiting := WaitingRows(journal.documents);
    assert HeldForUnsaved(platform, input.unsaved, start.journal.documents, set i | 0 <= i < |waiting| :: waiting[i]) by {
      forall e | e in journal.documents && journal.documents[e].ahead.Some?
        ensures e in set i | 0 <= i < |waiting| :: waiting[i]
      {
        assert e in waiting;
      }
    }
    RetryKeepsHeld(platform, start, waiting, input, revs, first);
    var retried := RetryWaiting(platform, start, waiting, input, revs, first);
    SettlePulledKeepsHeld(platform, retried, pulled, input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    PushKeepsAheads(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
  }

  // RoundContract's cursor, CommitsPersistedFirst and
  // IntentsCoverDiskEffects, of the round's step.
  lemma RoundStepEffects(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures var step := RoundStepOf(pre, d, input, revs);
      step.pre == pre && step.event == SyncRound(d) && d in step.post.devices
      && step.post.server == pre.server
      && IntentsCoverDiskEffects(step.effects) && CommitsPersistedFirst(step.effects)
    ensures (pre.devices[d].journal.cursor <= |pre.server.feed|
             && forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs)
            ==> RoundStepOf(pre, d, input, revs).post.devices[d].journal.cursor == |pre.server.feed|
    ensures RoundInputOf(pre, d, input) ==> NoMoveFromUnsaved(RoundStepOf(pre, d, input, revs))
    ensures RoundInputOf(pre, d, input) ==> CopiesTakeFreeNames(RoundStepOf(pre, d, input, revs), input)
    ensures (RoundInputOf(pre, d, input) && forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs)
            ==> var device' := RoundStepOf(pre, d, input, revs).post.devices[d];
                forall doc :: (doc in device'.journal.documents && device'.journal.documents[doc].ahead.Some?
                               && device'.journal.documents[doc].ahead.value.blocker.PathHeld?) ==> UserMustAct(device', doc)
  {
    var device := pre.devices[d];
    var journal := device.journal;
    var feed := pre.server.feed;
    var behind := journal.cursor < |feed|;
    var pulled := if behind then Revisions(pre.server, feed[journal.cursor..]) else [];
    var cursor' := if behind then |feed| else journal.cursor;
    var anchor' := if behind then Some(feed[|feed| - 1]) else journal.anchor;
    if forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs {
      OnRoundEffects(device.platform, journal, pulled, cursor', anchor', input, revs);
      OnRoundHeld(device.platform, journal, pulled, cursor', anchor', input, revs);
      OnRoundCopies(device.platform, journal, pulled, cursor', anchor', input, revs);
    }
    var step := RoundStepOf(pre, d, input, revs);
    if RoundInputOf(pre, d, input) && forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs {
      var device' := step.post.devices[d];
      assert device'.editors == device.editors && device'.platform == device.platform;
      forall doc | doc in device'.journal.documents && device'.journal.documents[doc].ahead.Some?
                   && device'.journal.documents[doc].ahead.value.blocker.PathHeld?
        ensures UserMustAct(device', doc)
      {
        var path := device'.journal.documents[doc].ahead.value.revision.path;
        var u := var u :| u in input.unsaved && CollideF(device.platform, u, path); u;
        var editor := var editor :| editor in device.editors && editor.unsaved.Some? && editor.path == u; editor;
      }
    }
    if RoundInputOf(pre, d, input) {
      forall i, editor | 0 <= i < |step.effects| && step.effects[i].Move? && editor in device.editors && editor.unsaved.Some?
        ensures !CollideF(device.platform, editor.path, step.effects[i].from)
      {
        assert editor.path in input.unsaved;
      }
      RoundCopiesTakeFreeNames(pre, d, input, revs);
    }
  }

  // CopiesTakeFreeNames from OnRoundCopies: the round's first claims are
  // the listing, the journal's bound names and its rows' server claims.
  lemma {:isolate_assertions} RoundCopiesTakeFreeNames(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input)
    requires var device := pre.devices[d];
      var step := RoundStepOf(pre, d, input, revs);
      CopiesAvoid(device.platform, input.unsaved, RoundClaims(device.platform, device.journal, input), step.effects)
    ensures CopiesTakeFreeNames(RoundStepOf(pre, d, input, revs), input)
  {
    var device := pre.devices[d];
    var platform := device.platform;
    var documents := device.journal.documents;
    var first := RoundClaims(platform, device.journal, input);
    var step := RoundStepOf(pre, d, input, revs);
    forall i | 0 <= i < |step.effects| && step.effects[i].Write? && step.effects[i].target.None?
      ensures var copy := step.effects[i].path;
        (forall q :: q in input.listing ==> !CollideF(platform, q, copy))
        && (forall u :: u in input.unsaved ==> !SameF(platform, u, copy))
        && (forall doc :: doc in documents ==>
              var document := documents[doc];
              (document.binding.Some? ==> !SameF(platform, document.binding.value.spelling, copy))
              && (document.base.Some? && !document.base.value.deleted ==> !CollideK(document.base.value.path, copy))
              && (document.ahead.Some? && !document.ahead.value.revision.deleted
                  ==> !CollideK(document.ahead.value.revision.path, copy))
              && (document.outbox.Some? && !document.outbox.value.deleted
                  ==> !SameK(document.outbox.value.path, copy)))
    {
      var copy := step.effects[i].path;
      assert CopyAvoids(platform, input.unsaved, first, copy);
      forall q | q in input.listing ensures !CollideF(platform, q, copy) {
        assert q in first.listed;
      }
      forall doc | doc in documents
        ensures var document := documents[doc];
              (document.binding.Some? ==> !SameF(platform, document.binding.value.spelling, copy))
              && (document.base.Some? && !document.base.value.deleted ==> !CollideK(document.base.value.path, copy))
              && (document.ahead.Some? && !document.ahead.value.revision.deleted
                  ==> !CollideK(document.ahead.value.revision.path, copy))
              && (document.outbox.Some? && !document.outbox.value.deleted
                  ==> !SameK(document.outbox.value.path, copy))
      {
        var document := documents[doc];
        if document.binding.Some? {
          assert document.binding.value.spelling in first.listed;
          assert !CollideF(platform, document.binding.value.spelling, copy);
        }
        if document.base.Some? && !document.base.value.deleted { assert document.base.value.path in first.paths; }
        if document.ahead.Some? && !document.ahead.value.revision.deleted { assert document.ahead.value.revision.path in first.paths; }
        if document.outbox.Some? && !document.outbox.value.deleted { assert document.outbox.value.path in first.names; }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Toward OwnRevisionsAcknowledged (#1081 composes it over the round): the apply
  // and the rule never move a base back and keep a commit in flight, and
  // the outbox's own revision becomes the base.
  // ---------------------------------------------------------------------

  lemma ApplyBaseGrows(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    requires document.ahead.Some? && document.base.Some? ==> document.base.value.position <= document.ahead.value.revision.position
    ensures var after := ApplyRevision(platform, doc, document, r, input, bound, claims, rev).document;
      (document.base.Some? ==> after.base.Some? && document.base.value.position <= after.base.value.position)
      && (document.outbox.Some? && document.outbox.value.sealed && !Acknowledges(document, r) ==> after.outbox == document.outbox)
      && (Newer(document, r) && Acknowledges(document, r) ==> after.base.Some? && after.base.value.position == r.position)
  {}

  // A row's base never moves back, and a commit in flight stays as sealed,
  // in every row the rule may change (W(a), W(b), a recorded delete).
  ghost predicate KeepsBaseAndFlight(before: Document, after: Document) {
    (before.base.Some? ==> after.base.Some? && before.base.value.position <= after.base.value.position)
    && (before.outbox.Some? && before.outbox.value.sealed ==> after.outbox == before.outbox)
  }

  lemma MoveRowsKeepBase(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs)
    requires documents.Keys <= revs.Keys
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      rows.Keys == documents.Keys && forall e | e in documents :: KeepsBaseAndFlight(documents[e], rows[e])
    decreases |moves|
  {
    if moves != [] { MoveRowsKeepBase(platform, documents, doc, moves[1..], revs); }
  }

  lemma RuleKeepsBase(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires var document := documents[doc];
      document.ahead.Some? && document.base.Some? ==> document.base.value.position <= document.ahead.value.revision.position
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      ruled.documents.Keys == documents.Keys
      && (forall e | e in documents && e != doc :: KeepsBaseAndFlight(documents[e], ruled.documents[e]))
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? {
        MoveRowsKeepBase(platform, documents, doc, aside.value, revs);
      }
    }
  }

  lemma RuleOwnRowKeepsBase(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires var document := documents[doc];
      document.ahead.Some? && document.base.Some? ==> document.base.value.position <= document.ahead.value.revision.position
    ensures var before := documents[doc];
      var after := PathRule(platform, documents, doc, r, input, revs, first).documents[doc];
      (before.base.Some? ==> after.base.Some? && before.base.value.position <= after.base.value.position)
      && (Newer(before, r) && Acknowledges(before, r) ==> after.base.Some? && after.base.value.position == r.position)
  {
    var document := documents[doc];
    ApplyBaseGrows(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if Newer(document, r) && Acknowledges(document, r) {
      RuleAcknowledges(platform, documents, doc, r, input, revs, first);
    }
  }

  // A row's waiting revision is never older than its base (the
  // hypothesis of RuleKeepsBase and RuleOwnRowKeepsBase), and the rule
  // keeps that for every row.
  ghost predicate AheadAboveBase(document: Document) {
    document.ahead.Some? && document.base.Some? ==> document.base.value.position <= document.ahead.value.revision.position
  }

  lemma MoveRowsKeepAheadAboveBase(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs)
    requires documents.Keys <= revs.Keys
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      rows.Keys == documents.Keys
      && forall e | e in documents :: rows[e].base == documents[e].base && rows[e].ahead == documents[e].ahead
    decreases |moves|
  {
    if moves != [] { MoveRowsKeepAheadAboveBase(platform, documents, doc, moves[1..], revs); }
  }

  lemma RuleKeepsAheadAboveBase(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires forall e | e in documents :: AheadAboveBase(documents[e])
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      forall e | e in ruled.documents :: AheadAboveBase(ruled.documents[e])
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? {
        MoveRowsKeepAheadAboveBase(platform, documents, doc, aside.value, revs);
        var rows := ClearRows(platform, documents, doc, r, input, aside.value, revs);
        forall e | e in rows ensures AheadAboveBase(rows[e]) {
          if e != doc {
            var moved := MoveRows(platform, documents, doc, aside.value, revs);
            assert rows[e] == RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs)[e];
          }
        }
      }
    }
  }

  // CommitsOnBase's row condition (#1080) for the rule: every row keeps
  // its outbox's parent or takes its base's id as the parent.
  lemma MoveRowsKeepParent(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs)
    requires documents.Keys <= revs.Keys
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      rows.Keys == documents.Keys && forall e | e in documents :: ParentKeptOrBase(documents[e], rows[e])
    decreases |moves|
  {
    MoveRowsKeepAheadAboveBase(platform, documents, doc, moves, revs);
    if moves != [] {
      MoveRowsKeepParent(platform, documents, doc, moves[1..], revs);
      MoveRowsKeepAheadAboveBase(platform, documents, doc, moves[1..], revs);
    }
  }

  lemma {:isolate_assertions} RuleKeepsParent(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      ruled.documents.Keys == documents.Keys
      && forall e | e in documents :: ParentKeptOrBase(documents[e], ruled.documents[e])
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    ApplyKeepsParent(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? {
        MoveRowsKeepParent(platform, documents, doc, aside.value, revs);
        reveal HeadRow();
      }
    }
  }
}
