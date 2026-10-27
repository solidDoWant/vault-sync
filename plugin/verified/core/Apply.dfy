// The pull apply of the sync round (#990, docs/design/verified-core.md
// §3.9): one pulled revision of one document, applied and merged to disk
// against the round's reads (`RoundInput`, verified-core.md §2.3). The step
// theorem of the whole round, which composes this with the push half
// (Push.dfy, #991), is #982's.
//
// The function decides from the round's listing and unsaved paths only. Every
// disk effect it requests is conditional on what the listing read: an
// overwrite or a delete on the content the listing holds at the document's
// file, a create on the name being free in the listing. The lemmas prove, on
// the function itself, that each precondition holds on the disk the listing
// was read from (`AppliedPreconditionsHold`), and that on that disk the
// effects take effect as the new row records (`AppliedTakesEffect`).
//
// A path conflict (the revision's name is held by an untracked file) is
// resolved only by `PathConflictCopy`, whose contract is stated here as its
// postcondition; its body and proof are #962's.
include "Push.dfy"

abstract module ApplyCore refines PushCore {

  // ---------------------------------------------------------------------
  // Reads (compiled)
  // ---------------------------------------------------------------------

  // What the round's listing holds at `p` under F.
  function ListedRead(platform: Platform, listing: Listing, p: Path): Read
    requires ListingDistinct(platform, listing)
  {
    if Listed(platform, listing, p) then Some(listing[ListedAt(platform, listing, p)]) else None
  }

  // No listed file collides with `p` under F (design §3.2).
  predicate FreeIn(platform: Platform, listing: Listing, p: Path) {
    forall q | q in listing :: !CollideF(platform, q, p)
  }

  // An open editor holds unsaved text at `p` (under F).
  predicate UnsavedAt(platform: Platform, unsaved: set<Path>, p: Path) {
    exists u | u in unsaved :: SameF(platform, u, p)
  }

  // ---------------------------------------------------------------------
  // The path-conflict function: contract only (#962)
  // ---------------------------------------------------------------------

  // The one place a path conflict is resolved: the server's head keeps the
  // name, and the untracked file `held` that holds it moves aside, with its
  // contents, to the name this function picks (SPEC.md §7 "Who keeps a
  // path", a conflict copy's name). Its contract: the name is free on the
  // listed disk, and it collides with neither the wanted name nor any of its
  // folders. Its body, the copy-name rule and its proof are #962's.
  function PathConflictCopy(platform: Platform, listing: Listing, held: Path, wanted: Path): (copy: Path)
    ensures FreeIn(platform, listing, copy)
    ensures !CollideF(platform, copy, wanted)

  // The listed files that collide with `p`.
  function Colliders(platform: Platform, listing: Listing, p: Path): set<Path> {
    set q | q in listing && CollideF(platform, q, p)
  }

  // ---------------------------------------------------------------------
  // The apply (compiled)
  // ---------------------------------------------------------------------

  datatype Applied = Applied(document: Document, effects: seq<Effect>)

  function BaseOf(r: Revision): Base {
    Base(r.id, r.position, r.path, r.content, r.kind, r.deleted)
  }

  // The revision waits, with its blocker: the row records it as `ahead`
  // and nothing touches the disk.
  function Hold(document: Document, r: Revision, blocker: Blocker): Applied {
    Applied(document.(ahead := Some(Ahead(r, blocker, false))), [])
  }

  // The bound file is exactly what the server's base has and the core last
  // saw: no change the server lacks, and the listing reads the same.
  predicate Clean(platform: Platform, document: Document, read: Read) {
    document.binding.Some? && document.outbox.None? && document.absence != UserDeleted
    && document.base.Some? && !document.base.value.deleted
    && document.base.value.path == document.binding.value.spelling
    && document.base.value.content == document.binding.value.seen
    && read.Some? && read.value.0 == document.binding.value.seen
  }

  // One pulled revision `r` of document `doc`, whose row is `document`,
  // against the round's input.
  function ApplyRevision(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput): Applied
    requires ListingDistinct(platform, input.listing)
  {
    if !Newer(document, r) then Applied(document, [])
    else if document.binding.Some? then
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) then Hold(document, r, LocalChanges)
      else if !Clean(platform, document, read) then
        Hold(document, r, if JournalChange(document) || read.None? || read.value.0 != document.binding.value.seen
                          then LocalChanges else PathHeld)
      else if r.deleted then
        // A remote delete of a file nobody changed here: the file goes.
        Applied(document.(base := Some(BaseOf(r)), ahead := None, binding := None, absence := Released),
                [Remove(doc, spelling, read.value.0)])
      else if r.path == spelling then
        // A remote edit in place: written over the content the round read.
        Applied(document.(base := Some(BaseOf(r)), ahead := None,
                          binding := Some(document.binding.value.(seen := r.content))),
                [Write(Some(doc), spelling, r.content, r.kind, Some(read.value.0))])
      else Hold(document, r, PathHeld)
    else if JournalChange(document) || r.deleted then
      // A user's delete against a remote revision, or a tombstone of a
      // document with no file here: recorded, nothing on disk.
      if r.deleted && !JournalChange(document) then
        Applied(document.(base := Some(BaseOf(r)), ahead := None), [])
      else Hold(document, r, LocalChanges)
    else if UnsavedAt(platform, input.unsaved, r.path) then Hold(document, r, PathHeld)
    else if FreeIn(platform, input.listing, r.path) then
      // A document with no file here: created where no file collides.
      Applied(document.(base := Some(BaseOf(r)), ahead := None,
                        binding := Some(Binding(r.path, r.content, false, None)), absence := Never),
              [Write(Some(doc), r.path, r.content, r.kind, None)])
    else
      var held := Colliders(platform, input.listing, r.path);
      if |held| == 1 then
        var q := LeastPath(held);
        var copy := PathConflictCopy(platform, input.listing, q, r.path);
        // The untracked file holding the name moves aside with its contents;
        // the head takes the name.
        Applied(document.(base := Some(BaseOf(r)), ahead := None,
                          binding := Some(Binding(r.path, r.content, false, None)), absence := Never),
                [Move(None, q, copy, input.listing[q].0), Write(Some(doc), r.path, r.content, r.kind, None)])
      else Hold(document, r, PathHeld)
  }

  // ---------------------------------------------------------------------
  // Every precondition holds on the disk the listing was read from
  // ---------------------------------------------------------------------

  // A disk effect's precondition holds on `disk`: the file the effect names
  // holds the expected content, or (a create) no file collides with the name.
  ghost predicate PreconditionHolds(platform: Platform, disk: map<Path, DiskFile>, effect: Effect) {
    match effect
    case Write(_, path, _, _, precondition) =>
      if precondition.Some? then exists q :: Holds(platform, disk, q, path, precondition.value)
      else FreeOn(platform, disk, path)
    case Remove(_, path, expected) => exists q :: Holds(platform, disk, q, path, expected)
    case Move(_, from, to, expected) => exists q :: MovableTo(platform, disk, q, from, to, expected)
    case _ => true
  }

  // The effects' preconditions hold in order: the first on `disk`, and each
  // later one on every disk the earlier ones can leave.
  ghost predicate PreconditionsInOrder(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>)
    decreases |effects|
  {
    |effects| == 0
    || (PreconditionHolds(platform, disk, effects[0])
        && forall mid :: EffectTakes(platform, disk, effects[0], mid) ==> PreconditionsInOrder(platform, mid, effects[1..]))
  }

  lemma ListedReadOnDisk(device: Device, p: Path)
    requires ListingDistinct(device.platform, ListingOf(device))
    ensures ListedRead(device.platform, ListingOf(device), p).Some? ==>
      exists q :: Holds(device.platform, device.disk, q, p, ListedRead(device.platform, ListingOf(device), p).value.0)
  {
    var listing := ListingOf(device);
    if Listed(device.platform, listing, p) {
      var q := ListedAt(device.platform, listing, p);
      assert Holds(device.platform, device.disk, q, p, listing[q].0);
    }
  }

  lemma OneEffect(platform: Platform, disk: map<Path, DiskFile>, effect: Effect)
    requires PreconditionHolds(platform, disk, effect)
    ensures PreconditionsInOrder(platform, disk, [effect])
  {
    assert [effect][1..] == [];
  }

  // Every disk effect of the apply has a precondition that holds on the
  // disk the round's listing was read from (RoundInputOf: the listing is the
  // device's DiskListing), the second effect of a path conflict on the disk
  // the first leaves. So a disk effect of the apply that does not take effect
  // means the disk changed after the round read it.
  lemma AppliedPreconditionsHold(device: Device, doc: DocId, document: Document, r: Revision, input: RoundInput)
    requires input.listing == ListingOf(device)
    requires ListingDistinct(device.platform, input.listing)
    ensures PreconditionsInOrder(device.platform, device.disk,
                                 ApplyRevision(device.platform, doc, document, r, input).effects)
  {
    var platform := device.platform;
    var disk := device.disk;
    var applied := ApplyRevision(platform, doc, document, r, input);
    if |applied.effects| == 0 {
      return;
    }
    if document.binding.Some? {
      ListedReadOnDisk(device, document.binding.value.spelling);
      OneEffect(platform, disk, applied.effects[0]);
      return;
    }
    if FreeIn(platform, input.listing, r.path) {
      assert FreeOn(platform, disk, r.path);
      OneEffect(platform, disk, applied.effects[0]);
      return;
    }
    var held := Colliders(platform, input.listing, r.path);
    assert |held| == 1;
    var q := LeastPath(held);
    assert held == {q} by {
      forall x | x in held ensures x == q {
        if x != q { SubsetCard({x, q}, held); }
      }
    }
    var copy := PathConflictCopy(platform, input.listing, q, r.path);
    var content := input.listing[q].0;
    var move := Move(None, q, copy, content);
    var write := Write(Some(doc), r.path, r.content, r.kind, None);
    assert applied.effects == [move, write];
    assert Holds(platform, disk, q, q, content);
    assert MovableTo(platform, disk, q, q, copy, content);
    forall mid | EffectTakes(platform, disk, move, mid)
      ensures PreconditionsInOrder(platform, mid, [write])
    {
      var q' :| MovableTo(platform, disk, q', q, copy, content) && mid == (disk - {q'})[copy := disk[q']];
      assert q' == q;
      forall x | x in mid ensures !CollideF(platform, x, r.path) {
        if x != copy {
          assert x in disk && x != q;
          assert x !in held;
        }
      }
      OneEffect(platform, mid, write);
    }
    assert [move, write][1..] == [write];
  }

  lemma SubsetCard<T>(a: set<T>, b: set<T>)
    requires a <= b
    ensures |a| <= |b|
  {
    if a != {} {
      var x :| x in a;
      SubsetCard(a - {x}, b - {x});
    }
  }
}
