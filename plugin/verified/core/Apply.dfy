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
// effects take effect as the new row records (`AppliedTakesEffect`). On a
// round step whose effects are the apply's (`ApplyStep`) they prove G2's
// step predicates (`AppliedG2`), `G5_NeverMixedUp` (`AppliedG5`),
// `G6_Settle` (`AppliedG6`), G7 (`AppliedG7`), and that every other
// document keeps its bound file (`AppliedKeepsOtherFiles`).
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

  // A document is bound to `p` (under F): `bound` is every binding's name.
  predicate BoundName(platform: Platform, bound: set<Path>, p: Path) {
    exists t | t in bound :: SameF(platform, t, p)
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
  function PathConflictCopy(platform: Platform, listing: Listing, avoid: set<Path>, held: Path, wanted: Path): (copy: Path)
    ensures FreeIn(platform, listing, copy)
    ensures forall t | t in avoid :: !SameF(platform, t, copy)
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

  // The shell's line-level three-way merge of notes (SPEC.md §7): contract
  // only, it is the merge of the specification.
  function Merge(base: Hash, local: Hash, remote: Hash): (m: Option<Hash>)
    ensures m == Merge3(base, local, remote)

  // A live remote edit of a bound document with a change the server lacks
  // (G6): its file reads other than the base, or it has an unsealed outbox.
  // The remote keeps the document's name (it did not move it), so only the
  // contents are settled here; a remote move against a local change, and a
  // commit in flight, wait (#962, §3.5).
  predicate Concurrent(document: Document, read: Read, r: Revision) {
    document.binding.Some? && read.Some? && document.absence != UserDeleted
    && document.base.Some? && !document.base.value.deleted && !r.deleted
    && r.path == document.base.value.path && r.id != document.base.value.rev
    && (document.outbox.None? || !document.outbox.value.sealed)
    && (document.outbox.Some? || read.value.0 != document.base.value.content)
  }

  // The settled row: base r, the file holding `content`, and an outbox only
  // where the file differs from r (the local name, or content the server
  // lacks), carrying the file as it is (OutboxCurrent).
  function Settled(document: Document, r: Revision, content: Hash, rev: RevId): Document
    requires document.binding.Some?
  {
    var spelling := document.binding.value.spelling;
    var row := document.(base := Some(BaseOf(r)), ahead := None,
                         binding := Some(document.binding.value.(seen := content)));
    if spelling == r.path && content == r.content then row.(outbox := None)
    else row.(outbox := Some(Outbox(if document.outbox.Some? then document.outbox.value.rev else rev,
                                    Some(r.id), spelling, content, r.kind, false, false, false)))
  }

  // G6: a side that left the content as it was takes the other's; two
  // changed notes are merged when the merge combines them; otherwise the
  // remote stays in place and the content read here is saved next to it as
  // an untracked copy, at the name the path-conflict function picks. A file
  // that reads as the base but not as `seen` (changed back before its event
  // arrived) is also saved as a copy before the remote is written over it:
  // G2 lets the round overwrite only content it keeps.
  function Settle(platform: Platform, doc: DocId, document: Document, read: (Hash, Kind), r: Revision, input: RoundInput, bound: set<Path>, rev: RevId): Applied
    requires document.binding.Some? && document.base.Some?
  {
    var spelling := document.binding.value.spelling;
    var b := document.base.value.content;
    var l := read.0;
    if l == b && l == document.binding.value.seen then
      Applied(Settled(document, r, r.content, rev), [Write(Some(doc), spelling, r.content, r.kind, Some(l))])
    else if r.content == b then
      Applied(Settled(document, r, l, rev), [])
    else if l != b && read.1 == Note && r.kind == Note && Merge(b, l, r.content).Some? then
      var m := Merge(b, l, r.content).value;
      Applied(Settled(document, r, m, rev), [Write(Some(doc), spelling, m, Note, Some(l))])
    else
      var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, spelling, spelling);
      Applied(Settled(document, r, r.content, rev),
              [Write(None, copy, l, read.1, None), Write(Some(doc), spelling, r.content, r.kind, Some(l))])
  }

  // One pulled revision `r` of document `doc`, whose row is `document`,
  // against the round's input.
  function ApplyRevision(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId): Applied
    requires ListingDistinct(platform, input.listing)
  {
    if !Newer(document, r) then Applied(document, [])
    else if document.binding.Some? then
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) then Hold(document, r, LocalChanges)
      else if Concurrent(document, read, r) then Settle(platform, doc, document, read.value, r, input, bound, rev)
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
    else if UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path) then Hold(document, r, PathHeld)
    else if FreeIn(platform, input.listing, r.path) then
      // A document with no file here: created where no file collides.
      Applied(document.(base := Some(BaseOf(r)), ahead := None,
                        binding := Some(Binding(r.path, r.content, false, None)), absence := Never),
              [Write(Some(doc), r.path, r.content, r.kind, None)])
    else
      var held := Colliders(platform, input.listing, r.path);
      // Only an untracked file is moved aside here; a name another document
      // holds is the path rule's (#962).
      if |held| == 1 && !BoundName(platform, bound, LeastPath(held)) then
        var q := LeastPath(held);
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, q, r.path);
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
  lemma AppliedPreconditionsHold(device: Device, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId)
    requires input.listing == ListingOf(device)
    requires ListingDistinct(device.platform, input.listing)
    ensures PreconditionsInOrder(device.platform, device.disk,
                                 ApplyRevision(device.platform, doc, document, r, input, bound, rev).effects)
  {
    var platform := device.platform;
    var disk := device.disk;
    var applied := ApplyRevision(platform, doc, document, r, input, bound, rev);
    if |applied.effects| == 0 {
      return;
    }
    if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      ListedReadOnDisk(device, spelling);
      if |applied.effects| == 2 {
        var l := ListedRead(platform, input.listing, spelling).value;
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, spelling, spelling);
        var w1 := Write(None, copy, l.0, l.1, None);
        var w2 := Write(Some(doc), spelling, r.content, r.kind, Some(l.0));
        assert applied.effects == [w1, w2];
        assert FreeOn(platform, disk, copy);
        var q :| Holds(platform, disk, q, spelling, l.0);
        forall mid | EffectTakes(platform, disk, w1, mid)
          ensures PreconditionsInOrder(platform, mid, [w2])
        {
          assert q != copy by { assert !CollideF(platform, q, copy); }
          assert Holds(platform, mid, q, spelling, l.0);
          OneEffect(platform, mid, w2);
        }
        assert [w1, w2][1..] == [w2];
      } else {
        OneEffect(platform, disk, applied.effects[0]);
      }
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
    var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, q, r.path);
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

  // ---------------------------------------------------------------------
  // On the disk the listing was read from, the effects take effect as the
  // new row records (G7 on disk, the bound file)
  // ---------------------------------------------------------------------

  // No two files on the disk collide under F (G7_OneFilePerName's device
  // half).
  ghost predicate OneFilePerName(platform: Platform, disk: map<Path, DiskFile>) {
    forall p, q :: p in disk && q in disk && p != q ==> !CollideF(platform, p, q)
  }

  lemma Unroll1(platform: Platform, disk: map<Path, DiskFile>, e: Effect, disk': map<Path, DiskFile>)
    requires EffectsTake(platform, disk, [e], disk')
    ensures EffectTakes(platform, disk, e, disk')
  {
    var mid :| EffectTakes(platform, disk, e, mid) && EffectsTake(platform, mid, [e][1..], disk');
    assert [e][1..] == [];
  }

  lemma Unroll2(platform: Platform, disk: map<Path, DiskFile>, e1: Effect, e2: Effect, disk': map<Path, DiskFile>)
    requires EffectsTake(platform, disk, [e1, e2], disk')
    ensures exists mid :: EffectTakes(platform, disk, e1, mid) && EffectTakes(platform, mid, e2, disk')
  {
    var mid :| EffectTakes(platform, disk, e1, mid) && EffectsTake(platform, mid, [e1, e2][1..], disk');
    assert [e1, e2][1..] == [e2];
    Unroll1(platform, mid, e2, disk');
  }

  // On the disk the round read, with no two files colliding, the apply's
  // effects keep one file per name, and they take effect as the new row
  // records:
  // - nothing requested, nothing changes;
  // - the new binding names a file that holds the content it records as
  //   `seen` (an overwrite keeps the file, its identity, in place);
  // - a remote delete leaves no file at the binding's old name;
  // - a file moved aside by the path-conflict function keeps its contents
  //   (and identity) at its new name.
  lemma AppliedTakesEffect(device: Device, doc: DocId, document: Document, r: Revision, input: RoundInput,
                           bound: set<Path>, rev: RevId, disk': map<Path, DiskFile>)
    requires input.listing == ListingOf(device)
    requires OneFilePerName(device.platform, device.disk)
    requires EffectsTake(device.platform, device.disk,
                         ApplyRevision(device.platform, doc, document, r, input, bound, rev).effects, disk')
    ensures ListingDistinct(device.platform, input.listing)
    ensures OneFilePerName(device.platform, disk')
    ensures var applied := ApplyRevision(device.platform, doc, document, r, input, bound, rev);
      && (applied.effects == [] ==> disk' == device.disk)
      && (applied.effects != [] && applied.document.binding.Some? ==>
            exists p :: Holds(device.platform, disk', p, applied.document.binding.value.spelling,
                              applied.document.binding.value.seen))
      && (applied.effects != [] && document.binding.Some? && document.binding.value.spelling in device.disk ==>
            (applied.document.binding.Some? ==>
               document.binding.value.spelling in disk' && disk'[document.binding.value.spelling].identity == device.disk[document.binding.value.spelling].identity)
            && (applied.document.binding.None? ==> !HasFileOn(device.platform, disk', document.binding.value.spelling)))
      && (forall e :: e in applied.effects && e.Write? && e.target.None? ==>
            e.path in disk' && disk'[e.path].content == e.content && e.path !in device.disk)
      && (forall e :: e in applied.effects && e.Move? ==>
            e.to in disk' && e.from in device.disk && disk'[e.to] == device.disk[e.from])
      && (forall x :: x in disk' && !Arrives(applied.effects, x) ==>
            x in device.disk && disk'[x].identity == device.disk[x].identity)
      && (forall x :: x in device.disk && !Departs(device.platform, applied.effects, x) ==>
            x in disk' && disk'[x].identity == device.disk[x].identity)
  {
    DistinctDisk(device);
    var platform := device.platform;
    var disk := device.disk;
    var applied := ApplyRevision(platform, doc, document, r, input, bound, rev);
    AppliedPreconditionsHold(device, doc, document, r, input, bound, rev);
    if |applied.effects| == 0 {
      assert disk' == disk;
      return;
    }
    if document.binding.Some? && |applied.effects| == 2 {
      SettleConflictTakesEffect(device, doc, document, r, input, bound, rev, disk');
      return;
    }
    if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var e := applied.effects[0];
      assert applied.effects == [e];
      Unroll1(platform, disk, e, disk');
      var q :| Holds(platform, disk, q, spelling, ListedRead(platform, input.listing, spelling).value.0)
                && (if e.Remove? then disk' == disk - {q} else disk' == disk[q := DiskFile(e.content, e.kind, disk[q].identity)]);
      if spelling in disk {
        assert q == spelling;
      }
      if e.Remove? {
        forall x | x in disk' ensures !SameF(platform, x, spelling) {
          assert x in disk && x != q;
        }
      } else {
        assert Holds(platform, disk', q, spelling, applied.document.binding.value.seen);
      }
      return;
    }
    if FreeIn(platform, input.listing, r.path) {
      var e := applied.effects[0];
      assert applied.effects == [e];
      Unroll1(platform, disk, e, disk');
      assert FreeOn(platform, disk, r.path);
      var identity: FileIdentity :| (forall q :: q in disk ==> disk[q].identity != identity)
                      && disk' == disk[r.path := DiskFile(r.content, r.kind, identity)];
      assert r.path !in disk;
      assert Holds(platform, disk', r.path, r.path, r.content);
      return;
    }
    var held := Colliders(platform, input.listing, r.path);
    var q := LeastPath(held);
    assert held == {q} by {
      forall x | x in held ensures x == q {
        if x != q { SubsetCard({x, q}, held); }
      }
    }
    var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, q, r.path);
    var content := input.listing[q].0;
    var move := Move(None, q, copy, content);
    var write := Write(Some(doc), r.path, r.content, r.kind, None);
    assert applied.effects == [move, write];
    Unroll2(platform, disk, move, write, disk');
    var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, move, mid) && EffectTakes(platform, mid, write, disk');
    assert MovableTo(platform, disk, q, q, copy, content);
    var q' :| MovableTo(platform, disk, q', q, copy, content) && mid == (disk - {q'})[copy := disk[q']];
    assert q' == q;
    assert copy !in disk - {q};
    assert OneFilePerName(platform, mid) by {
      forall x, y | x in mid && y in mid && x != y ensures !CollideF(platform, x, y) {
        if x != copy && y != copy {
          assert x in disk && y in disk;
        }
      }
    }
    assert FreeOn(platform, mid, r.path) by {
      forall x | x in mid ensures !CollideF(platform, x, r.path) {
        if x != copy {
          assert x in disk && x != q;
          assert x !in held;
        }
      }
    }
    var identity: FileIdentity :| (forall x :: x in mid ==> mid[x].identity != identity)
                    && disk' == mid[r.path := DiskFile(r.content, r.kind, identity)];
    assert r.path !in mid;
    assert Holds(platform, disk', r.path, r.path, r.content);
    assert copy != r.path;
    assert disk'[copy] == disk[q];
  }

  lemma SettleConflictTakesEffect(device: Device, doc: DocId, document: Document, r: Revision, input: RoundInput,
                                  bound: set<Path>, rev: RevId, disk': map<Path, DiskFile>)
    requires input.listing == ListingOf(device)
    requires OneFilePerName(device.platform, device.disk)
    requires ListingDistinct(device.platform, input.listing)
    requires document.binding.Some?
    requires |ApplyRevision(device.platform, doc, document, r, input, bound, rev).effects| == 2
    requires EffectsTake(device.platform, device.disk,
                         ApplyRevision(device.platform, doc, document, r, input, bound, rev).effects, disk')
    ensures OneFilePerName(device.platform, disk')
    ensures var applied := ApplyRevision(device.platform, doc, document, r, input, bound, rev);
      var spelling := document.binding.value.spelling;
      && applied.document.binding.Some? && applied.document.binding.value.spelling == spelling
      && (exists p :: Holds(device.platform, disk', p, spelling, applied.document.binding.value.seen))
      && (spelling in device.disk ==> spelling in disk' && disk'[spelling].identity == device.disk[spelling].identity)
      && (forall e :: e in applied.effects && e.Write? && e.target.None? ==>
            e.path in disk' && disk'[e.path].content == e.content && e.path !in device.disk)
      && (forall e :: e in applied.effects ==> !e.Move?)
      && (forall x :: x in disk' && !Arrives(applied.effects, x) ==>
            x in device.disk && disk'[x].identity == device.disk[x].identity)
      && (forall x :: x in device.disk && !Departs(device.platform, applied.effects, x) ==>
            x in disk' && disk'[x].identity == device.disk[x].identity)
  {
    var platform := device.platform;
    var disk := device.disk;
    var applied := ApplyRevision(platform, doc, document, r, input, bound, rev);
    var spelling := document.binding.value.spelling;
    ListedReadOnDisk(device, spelling);
    var l := ListedRead(platform, input.listing, spelling).value;
    var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, spelling, spelling);
    var w1 := Write(None, copy, l.0, l.1, None);
    var w2 := Write(Some(doc), spelling, r.content, r.kind, Some(l.0));
    assert applied.effects == [w1, w2];
    assert applied.document.binding.value.seen == r.content;
    Unroll2(platform, disk, w1, w2, disk');
    var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, w1, mid) && EffectTakes(platform, mid, w2, disk');
    assert FreeOn(platform, disk, copy);
    var identity: FileIdentity :| (forall x :: x in disk ==> disk[x].identity != identity)
                                  && mid == disk[copy := DiskFile(l.0, l.1, identity)];
    assert copy !in disk;
    var q :| Holds(platform, disk, q, spelling, l.0);
    assert q != copy by { assert !CollideF(platform, q, copy); }
    assert Holds(platform, mid, q, spelling, l.0);
    var q2 :| Holds(platform, mid, q2, spelling, l.0) && disk' == mid[q2 := DiskFile(r.content, r.kind, mid[q2].identity)];
    assert q2 != copy by { assert !CollideF(platform, copy, spelling); }
    assert q2 in disk && SameF(platform, q2, q);
    assert q2 == q;
    if spelling in disk {
      assert q == spelling;
    }
    assert OneFilePerName(platform, mid) by {
      forall x, y | x in mid && y in mid && x != y ensures !CollideF(platform, x, y) {
        if x != copy && y != copy {
          assert x in disk && y in disk;
        }
      }
    }
    assert Holds(platform, disk', q, spelling, r.content);
    assert disk'[copy].content == l.0;
  }

  // A file arrives at name x by one of the effects: created there (a write
  // conditional on no file) or moved there.
  ghost predicate Arrives(effects: seq<Effect>, x: Path) {
    exists e :: e in effects && ((e.Write? && e.precondition.None? && e.path == x) || (e.Move? && e.to == x))
  }

  // A file leaves name x by one of the effects: removed or moved away.
  ghost predicate Departs(platform: Platform, effects: seq<Effect>, x: Path) {
    exists e :: e in effects && ((e.Remove? && SameF(platform, e.path, x)) || (e.Move? && SameF(platform, e.from, x)))
  }

  // A file is at `p` under F on `disk`.
  ghost predicate HasFileOn(platform: Platform, disk: map<Path, DiskFile>, p: Path) {
    exists q :: q in disk && SameF(platform, q, p)
  }

  // ---------------------------------------------------------------------
  // G2 on the step that requests the apply's effects
  // ---------------------------------------------------------------------

  // The state after the apply on device d: doc's row replaced, the disk
  // as the effects left it. (The round's other rows and the push are
  // #982's; the server does not change in a round.)
  ghost function ApplyAfter(pre: State, d: DeviceId, doc: DocId, row: Document, disk': map<Path, DiskFile>): State
    requires d in pre.devices
  {
    var device := pre.devices[d];
    pre.(devices := pre.devices[d := device.(journal := device.journal.(documents := device.journal.documents[doc := row]),
                                             disk := disk')])
  }

  // A round step of device d whose effects are the apply of revision r,
  // another device's revision the server accepted, to document doc, with
  // the round's input read from the step's state before (RoundInputOf) on a
  // disk with one file per name, `bound` every name a document is bound to,
  // and the step's state after as the effects leave it.
  ghost predicate ApplyStep(step: Step, doc: DocId, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId) {
    step.event.SyncRound?
    && RoundInputOf(step.pre, step.event.device, input)
    && var d := step.event.device;
    var device := step.pre.devices[d];
    OneFilePerName(device.platform, device.disk)
    && doc in device.journal.documents
    && ListingDistinct(device.platform, input.listing)
    && (forall other :: other in device.journal.documents && device.journal.documents[other].binding.Some? ==>
          device.journal.documents[other].binding.value.spelling in bound)
    && r.id in step.pre.server.accepted && step.pre.server.accepted[r.id] == r
    && r.doc == doc && r.device != d
    && var applied := ApplyRevision(device.platform, doc, device.journal.documents[doc], r, input, bound, rev);
    step.effects == applied.effects && d in step.post.devices
    && EffectsTake(device.platform, device.disk, applied.effects, step.post.devices[d].disk)
    && step.post == ApplyAfter(step.pre, d, doc, applied.document, step.post.devices[d].disk)
  }

  lemma UnsavedSeen(device: Device, unsaved: set<Path>, p: Path)
    requires unsaved == UnsavedPaths(device)
    ensures HasUnsavedEdits(device, p) ==> UnsavedAt(device.platform, unsaved, p)
  {
    if HasUnsavedEdits(device, p) {
      var editor :| editor in device.editors && editor.unsaved.Some? && SameF(device.platform, editor.path, p);
      assert editor.path in unsaved;
    }
  }

  // The apply's effects keep G2's step predicates: every overwrite and
  // delete names the document's bound file and is conditional on the
  // content the core last saw there (`seen`, which the round read there
  // too), only a tracked file is deleted, and no file with unsaved text is
  // written or deleted.
  // On a disk with one file per name, the file found at `p` is the one
  // whose spelling is p under F.
  lemma FileAtIs(device: Device, p: Path, q: Path)
    requires OneFilePerName(device.platform, device.disk)
    requires q in device.disk && SameF(device.platform, q, p)
    ensures HasFile(device, p) && FileAt(device, p) == device.disk[q]
  {
    var q' :| q' in device.disk && SameF(device.platform, q', p) && FileAt(device, p) == device.disk[q'];
    if q' != q { SameFIsEquivalence(device.platform, q', p, q); SameFIsEquivalence(device.platform, q, p, q); assert SameF(device.platform, q', q); assert CollideF(device.platform, q', q); }
  }

  // The apply's effects keep G2's step predicates: every overwrite and
  // delete names the document's bound file and is conditional on the
  // content the core last saw there: `seen`, or what the round read there
  // where the step keeps it (a merge of it is sent, or it is saved next to
  // the remote as an untracked copy). Only a tracked file is deleted, and
  // no file with unsaved text is written or deleted.
  lemma AppliedG2(step: Step, doc: DocId, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId)
    requires ApplyStep(step, doc, r, input, bound, rev)
    ensures G2_OnlyWhatItSaw(step) && G2_UnsavedSafe(step) && G2_NoUntrackedDelete(step)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var platform := device.platform;
    var document := device.journal.documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, bound, rev);
    var after := step.post.devices[d];
    assert input.listing == ListingOf(device);
    AppliedTakesEffect(device, doc, document, r, input, bound, rev, after.disk);
    if document.binding.None? {
      UnsavedSeen(device, input.unsaved, r.path);
      return;
    }
    var spelling := document.binding.value.spelling;
    UnsavedSeen(device, input.unsaved, spelling);
    assert BoundTo(device, doc, spelling);
    var read := ListedRead(platform, input.listing, spelling);
    if !(Newer(document, r) && !UnsavedAt(platform, input.unsaved, spelling) && Concurrent(document, read, r)) {
      return;
    }
    ListedReadOnDisk(device, spelling);
    var l := read.value;
    var q :| Holds(platform, device.disk, q, spelling, l.0);
    FileAtIs(device, spelling, q);
    assert RoundRead(step, spelling) == Some(l) by {
      assert ListedAt(platform, input.listing, spelling) == q by {
        var x := ListedAt(platform, input.listing, spelling);
        if x != q { assert CollideF(platform, x, q); }
      }
    }
    var b := document.base.value.content;
    if l.0 == b && l.0 == document.binding.value.seen {
      return;
    } else if r.content == b {
      return;
    } else if l.0 != b && l.1 == Note && r.kind == Note && Merge(b, l.0, r.content).Some? {
      var m := Merge(b, l.0, r.content).value;
      assert applied.document == Settled(document, r, m, rev);
      assert LocalChange(device, doc) by {
        if document.outbox.None? {
          assert BoundFile(device, doc) == Some(device.disk[q]);
        }
      }
      assert SettlesConcurrent(step, d, doc, r);
      assert Outgoing(after, doc) == Some(m) by {
        if applied.document.outbox.None? {
          var p :| Holds(platform, after.disk, p, spelling, m);
          FileAtIs(after, spelling, p);
          assert BoundFile(after, doc) == Some(after.disk[p]);
        }
      }
      assert MergedRead(step, d, doc, l.0, r);
      assert ReadKept(step, doc, l.0);
    } else {
      var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, spelling, spelling);
      var w1 := Write(None, copy, l.0, l.1, None);
      assert w1 in applied.effects;
      assert copy in after.disk && after.disk[copy].content == l.0;
      assert !Tracked(after, copy) by {
        forall other | BoundTo(after, other, copy) ensures false {
          if other == doc {
            assert spelling in bound;
          } else {
            assert after.journal.documents[other] == device.journal.documents[other];
            assert device.journal.documents[other].binding.value.spelling in bound;
          }
        }
      }
      assert SavedNextToIt(after, l.0);
      assert !HasUnsavedEdits(device, copy) by {
        if HasUnsavedEdits(device, copy) {
          var editor :| editor in device.editors && editor.unsaved.Some? && SameF(platform, editor.path, copy);
          assert editor.path in input.unsaved;
        }
      }
      assert ReadKept(step, doc, l.0);
    }
  }

  // ---------------------------------------------------------------------
  // G6 on the step that requests the apply's effects
  // ---------------------------------------------------------------------

  // Every concurrent change the apply settles satisfies G6_Settle: the
  // apply settles only a live remote edit against a bound file whose
  // contents it read (a remote delete, a user's delete and a commit in
  // flight wait), and keeps the side that changed, the merge, or the remote
  // with the local version saved next to it.
  lemma AppliedG6(step: Step, doc: DocId, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId)
    requires ApplyStep(step, doc, r, input, bound, rev)
    ensures forall d, doc', remote :: SettlesConcurrent(step, d, doc', remote) ==> G6_Settle(step, d, doc', remote)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var platform := device.platform;
    var document := device.journal.documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, bound, rev);
    var after := step.post.devices[d];
    assert input.listing == ListingOf(device);
    AppliedTakesEffect(device, doc, document, r, input, bound, rev, after.disk);
    forall d', doc', remote | SettlesConcurrent(step, d', doc', remote)
      ensures G6_Settle(step, d', doc', remote)
    {
      if d' != d || doc' != doc {
        assert step.post.devices[d'].journal.documents[doc'] == step.pre.devices[d'].journal.documents[doc'];
        assert false;
      }
      assert applied.document.base == Some(BaseOf(r));
      assert remote == r;
      SettledByApply(step, doc, r, input, bound, rev);
    }
  }

  lemma SettledByApply(step: Step, doc: DocId, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId)
    requires ApplyStep(step, doc, r, input, bound, rev)
    requires SettlesConcurrent(step, step.event.device, doc, r)
    ensures G6_Settle(step, step.event.device, doc, r)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var platform := device.platform;
    var document := device.journal.documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, bound, rev);
    var after := step.post.devices[d];
    assert input.listing == ListingOf(device);
    AppliedTakesEffect(device, doc, document, r, input, bound, rev, after.disk);
    assert Newer(document, r);
    if document.binding.None? {
      assert !LocalChange(device, doc);
      return;
    }
    var spelling := document.binding.value.spelling;
    var read := ListedRead(platform, input.listing, spelling);
    ListedReadOnDisk(device, spelling);
    assert !UnsavedAt(platform, input.unsaved, spelling);
    if !Concurrent(document, read, r) {
      assert Clean(platform, document, read);
      var q :| Holds(platform, device.disk, q, spelling, read.value.0);
      FileAtIs(device, spelling, q);
      assert BoundFile(device, doc) == Some(device.disk[q]);
      assert !LocalChange(device, doc);
      return;
    }
    var l := read.value;
    var q :| Holds(platform, device.disk, q, spelling, l.0);
    FileAtIs(device, spelling, q);
    assert BoundFile(device, doc) == Some(device.disk[q]);
    assert device.disk[q].content == l.0 && device.disk[q].kind == l.1 by {
      var x := ListedAt(platform, input.listing, spelling);
      if x != q { SameFIsEquivalence(platform, x, spelling, q); SameFIsEquivalence(platform, q, spelling, q); assert CollideF(platform, x, q); }
    }
    var b := document.base.value.content;
    var settledContent := applied.document.binding.value.seen;
    assert Outgoing(after, doc) == Some(settledContent) by {
      if applied.document.outbox.None? {
        if applied.effects == [] {
          assert after.disk == device.disk;
          FileAtIs(after, spelling, q);
          assert BoundFile(after, doc) == Some(after.disk[q]);
        } else {
          var p :| Holds(platform, after.disk, p, spelling, settledContent);
          FileAtIs(after, spelling, p);
          assert BoundFile(after, doc) == Some(after.disk[p]);
        }
      }
    }
    if !(l.0 == b && l.0 == document.binding.value.seen) && r.content != b
       && !(l.0 != b && l.1 == Note && r.kind == Note && Merge(b, l.0, r.content).Some?) {
      var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, spelling, spelling);
      var w1 := Write(None, copy, l.0, l.1, None);
      assert w1 in applied.effects;
      assert !Tracked(after, copy) by {
        forall other | BoundTo(after, other, copy) ensures false {
          if other == doc {
            assert spelling in bound;
          } else {
            assert after.journal.documents[other] == device.journal.documents[other];
            assert device.journal.documents[other].binding.value.spelling in bound;
          }
        }
      }
      assert SavedNextToIt(after, l.0);
    }
  }

  // ---------------------------------------------------------------------
  // G7 and G5 on the step that requests the apply's effects
  // ---------------------------------------------------------------------

  // One file per name stays true on the device, the server does not change,
  // and a file moved aside arrives at its new name with its contents.
  lemma AppliedG7(step: Step, doc: DocId, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId)
    requires ApplyStep(step, doc, r, input, bound, rev)
    requires G7_OneFilePerName(step.pre)
    ensures G7_OneFilePerName(step.post) && G7_MoveKeepsContents(step)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var document := device.journal.documents[doc];
    var applied := ApplyRevision(device.platform, doc, document, r, input, bound, rev);
    var after := step.post.devices[d];
    assert input.listing == ListingOf(device);
    AppliedTakesEffect(device, doc, document, r, input, bound, rev, after.disk);
    forall e | e in step.effects && e.Move?
      ensures HasFile(after, e.to) && FileAt(after, e.to).content == e.expected
    {
      FileAtIs(after, e.to, e.to);
      var q := e.from;
      assert e.expected == input.listing[q].0;
    }
  }

  // The identity of the file a document's binding names is kept, or the
  // file is gone, when no file arrived at a name that is the binding's under
  // F and every other file keeps its identity.
  lemma IdentityFrame(before: Device, after: Device, spelling: Path, effects: seq<Effect>)
    requires after.platform == before.platform
    requires OneFilePerName(before.platform, before.disk) && OneFilePerName(after.platform, after.disk)
    requires forall x :: x in after.disk && !Arrives(effects, x) ==>
      x in before.disk && after.disk[x].identity == before.disk[x].identity
    requires forall x :: Arrives(effects, x) ==> !SameF(before.platform, x, spelling)
    ensures HasFile(after, spelling) ==>
              (HasFile(before, spelling) && FileAt(after, spelling).identity == FileAt(before, spelling).identity)
  {
    if HasFile(after, spelling) {
      var x :| x in after.disk && SameF(after.platform, x, spelling);
      FileAtIs(after, spelling, x);
      FileAtIs(before, spelling, x);
    }
  }

  // G5: no document is mixed up with another file. A document whose bound
  // file is another file after the apply is the one the apply created for
  // it (clause (b)); every other binding keeps its file, because a file
  // arrives only at a name no document is bound to (the revision's name is
  // checked against `bound`, and the path-conflict function avoids it).
  lemma AppliedG5(step: Step, doc: DocId, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId)
    requires ApplyStep(step, doc, r, input, bound, rev)
    ensures G5_NeverMixedUp(step)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var platform := device.platform;
    var document := device.journal.documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, bound, rev);
    var after := step.post.devices[d];
    assert input.listing == ListingOf(device);
    AppliedTakesEffect(device, doc, document, r, input, bound, rev, after.disk);
    // Every name a file arrives at is no binding's name.
    assert forall x :: Arrives(applied.effects, x) ==> !BoundName(platform, bound, x) || (document.binding.None? && x == r.path);
    forall doc' | BoundIdentity(after, doc').Some? && BoundIdentity(after, doc') != BoundIdentity(device, doc')
      ensures exists effect :: (effect in step.effects
                && ((effect.Write? && effect.target == Some(doc')
                     && SameF(platform, effect.path, after.journal.documents[doc'].binding.value.spelling))
                    || (effect.Move? && effect.mover == Some(doc')
                        && SameF(platform, effect.to, after.journal.documents[doc'].binding.value.spelling))))
    {
      var spelling' := after.journal.documents[doc'].binding.value.spelling;
      if doc' != doc || document.binding.Some? {
        assert after.journal.documents[doc'].binding.Some?;
        assert device.journal.documents[doc'].binding.value.spelling == spelling';
        assert spelling' in bound;
        forall x | Arrives(applied.effects, x) ensures !SameF(platform, x, spelling') {
          if SameF(platform, x, spelling') { SameFIsEquivalence(platform, x, spelling', spelling'); assert BoundName(platform, bound, x); }
        }
        IdentityFrame(device, after, spelling', applied.effects);
        assert false;
      }
      var e := Write(Some(doc), r.path, r.content, r.kind, None);
      assert e in step.effects;
    }
  }

  // Every other document's bound file stays where it is, the same file: the
  // apply removes only the document's own file (no other document is bound
  // to its name, G5_NeverJoined) and moves aside only an untracked file.
  lemma AppliedKeepsOtherFiles(step: Step, doc: DocId, r: Revision, input: RoundInput, bound: set<Path>, rev: RevId)
    requires ApplyStep(step, doc, r, input, bound, rev)
    requires G5_NeverJoined(step.pre)
    ensures var d := step.event.device;
      forall other :: other != doc && BoundIdentity(step.pre.devices[d], other).Some? ==>
        BoundIdentity(step.post.devices[d], other) == BoundIdentity(step.pre.devices[d], other)
  {
    var d := step.event.device;
    var device := step.pre.devices[d];
    var platform := device.platform;
    var document := device.journal.documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, bound, rev);
    var after := step.post.devices[d];
    assert input.listing == ListingOf(device);
    AppliedTakesEffect(device, doc, document, r, input, bound, rev, after.disk);
    forall other | other != doc && BoundIdentity(device, other).Some?
      ensures BoundIdentity(after, other) == BoundIdentity(device, other)
    {
      var s' := device.journal.documents[other].binding.value.spelling;
      assert s' in bound;
      var x :| x in device.disk && SameF(platform, x, s');
      FileAtIs(device, s', x);
      assert !Departs(platform, applied.effects, x) by {
        forall e | e in applied.effects
          ensures !((e.Remove? && SameF(platform, e.path, x)) || (e.Move? && SameF(platform, e.from, x)))
        {
          if e.Remove? && SameF(platform, e.path, x) {
            assert e.path == document.binding.value.spelling;
            SameFIsEquivalence(platform, e.path, x, s');
          }
          if e.Move? && SameF(platform, e.from, x) {
            SameFIsEquivalence(platform, e.from, x, s');
            SameFIsEquivalence(platform, s', e.from, e.from);
            assert BoundName(platform, bound, e.from);
          }
        }
      }
      assert after.journal.documents[other] == device.journal.documents[other];
      FileAtIs(after, s', x);
    }
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
