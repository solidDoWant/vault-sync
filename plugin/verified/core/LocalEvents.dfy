// The verified core's handling of local file events and the start-up scan
// (#948, docs/design/verified-core.md §3). The core is a set of non-ghost
// functions over what the shell hands it: the device's platform and journal,
// the event, and the event's input (verified-core.md §2.3: the reads of the
// paths a local event names, or the scan's listing). The lemmas prove that a
// step of the core keeps every state invariant of Guarantees.dfy and the
// core's own invariant CoreInv, and satisfies every step predicate.
//
// A local event or the scan reports a change the user already made on disk,
// so the core requests no disk effect for them: it only records the change in
// the journal (bindings, absences, outboxes) and asks for the journal to be
// persisted. New files stay untracked until a push creates their document
// (#949); `PendingPush` counts them.
include "../spec/Guarantees.dfy"

abstract module LocalCore refines Guarantees {

  // ---------------------------------------------------------------------
  // The core (compiled)
  // ---------------------------------------------------------------------

  // What the shell read at a path: the file's content and kind under F, or
  // None when no file is there.
  type Read = Option<(Hash, Kind)>

  // The revision id the shell assigns to a document's next outbox.
  type FreshRevs = map<DocId, RevId>

  predicate BoundAt(platform: Platform, document: Document, p: Path) {
    document.binding.Some? && SameF(platform, document.binding.value.spelling, p)
  }

  function ReadOf(input: map<Path, Read>, p: Path): Read {
    if p in input then input[p] else None
  }

  function KindOf(document: Document): Kind {
    if document.outbox.Some? then document.outbox.value.kind
    else if document.base.Some? then document.base.value.kind
    else Note
  }

  // The document's outbox after a local change: a sealed outbox (a commit in
  // flight) is never edited; an unsealed one now carries the change (and is
  // no longer rejected: the user acted); otherwise a new outbox is opened.
  function Send(document: Document, path: Path, content: Hash, kind: Kind, deleted: bool, rev: RevId): Option<Outbox> {
    if document.outbox.Some? && document.outbox.value.sealed then document.outbox
    else if document.outbox.Some? then
      Some(document.outbox.value.(path := path, content := content, kind := kind, deleted := deleted, rejected := false))
    else
      Some(Outbox(rev, if document.base.Some? then Some(document.base.value.rev) else None,
                  path, content, kind, deleted, false, false))
  }

  // The document's file is at `spelling` with `content`.
  function Rebind(document: Document, spelling: Path, content: Hash, kind: Kind, rev: RevId): Document
    requires document.binding.Some?
  {
    document.(binding := Some(document.binding.value.(spelling := spelling, seen := content)),
              outbox := Send(document, spelling, content, kind, false, rev))
  }

  // The document's file was removed by the user: the delete is sent.
  function Unbind(document: Document, rev: RevId): Document
    requires document.binding.Some?
  {
    document.(binding := None, absence := UserDeleted,
              outbox := Send(document, document.binding.value.spelling, document.binding.value.seen,
                             KindOf(document), true, rev))
  }

  // One document's row after a local event, given the reads.
  function LocalDoc(platform: Platform, document: Document, local: LocalEvent, input: map<Path, Read>, rev: RevId): Document {
    match local
    case Created(p) => Saved(platform, document, p, ReadOf(input, p), rev)
    case Modified(p) => Saved(platform, document, p, ReadOf(input, p), rev)
    case Deleted(p) =>
      if ReadOf(input, p).None? && BoundAt(platform, document, p) then Unbind(document, rev) else document
    case Renamed(from, to) =>
      if BoundAt(platform, document, from) then
        var r := ReadOf(input, to);
        if r.Some? then Rebind(document, to, r.value.0, r.value.1, rev)
        else Rebind(document, to, document.binding.value.seen, KindOf(document), rev)
      // Another file was renamed over this document's file: the user
      // replaced it, so this document's file is gone.
      else if BoundAt(platform, document, to) then Unbind(document, rev)
      else document
  }

  // A create or a modify of the file at `p`: a bound file whose content
  // changed carries the change.
  function Saved(platform: Platform, document: Document, p: Path, r: Read, rev: RevId): Document {
    if r.Some? && BoundAt(platform, document, p) && document.binding.value.seen != r.value.0
    then Rebind(document, document.binding.value.spelling, r.value.0, r.value.1, rev)
    else document
  }

  function LocalJournal(platform: Platform, journal: Journal, local: LocalEvent, input: map<Path, Read>, revs: FreshRevs): Journal
    requires journal.documents.Keys <= revs.Keys
  {
    journal.(documents := map doc | doc in journal.documents ::
      LocalDoc(platform, journal.documents[doc], local, input, revs[doc]))
  }

  // The core's answer to a local event: the new journal, and the effects.
  function OnLocal(platform: Platform, journal: Journal, local: LocalEvent, input: map<Path, Read>, revs: FreshRevs): (Journal, seq<Effect>)
    requires journal.documents.Keys <= revs.Keys
  {
    var journal' := LocalJournal(platform, journal, local, input, revs);
    (journal', [PersistJournal(journal')])
  }

  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // The start-up scan (compiled)
  // ---------------------------------------------------------------------

  type Listing = map<Path, (Hash, Kind)>

  // A listing of a real disk: no two listed names are one file under F.
  ghost predicate ListingDistinct(platform: Platform, listing: Listing) {
    forall p, q :: p in listing && q in listing && p != q ==> !SameF(platform, p, q)
  }

  predicate Listed(platform: Platform, listing: Listing, s: Path) {
    exists q | q in listing :: SameF(platform, q, s)
  }

  function ListedAt(platform: Platform, listing: Listing, s: Path): Path
    requires ListingDistinct(platform, listing) && Listed(platform, listing, s)
  {
    var q :| q in listing && SameF(platform, q, s); q
  }

  predicate TrackedIn(platform: Platform, docs: map<DocId, Document>, q: Path) {
    exists doc | doc in docs :: BoundAt(platform, docs[doc], q)
  }

  predicate MissingIn(platform: Platform, listing: Listing, document: Document) {
    document.binding.Some? && !Listed(platform, listing, document.binding.value.spelling)
  }

  // The untracked listed files holding `content`.
  function Candidates(platform: Platform, docs: map<DocId, Document>, listing: Listing, content: Hash): set<Path> {
    set q | q in listing && listing[q].0 == content && !TrackedIn(platform, docs, q)
  }

  // Another document whose file is missing last saw `content` too.
  predicate Rival(platform: Platform, docs: map<DocId, Document>, listing: Listing, doc: DocId, content: Hash) {
    exists other | other in docs :: other != doc && MissingIn(platform, listing, docs[other])
      && docs[other].binding.value.seen == content
  }

  // A file moved while the app was closed (E7, verified-core.md §1.3, owner
  // decision 4): matched only when exactly one untracked file holds exactly
  // what the document last saw, and no other missing document saw it.
  predicate Matched(platform: Platform, docs: map<DocId, Document>, listing: Listing, doc: DocId)
    requires doc in docs && docs[doc].binding.Some?
  {
    var seen := docs[doc].binding.value.seen;
    |Candidates(platform, docs, listing, seen)| == 1 && !Rival(platform, docs, listing, doc, seen)
  }

  lemma SingletonPick<T>(s: set<T>)
    requires |s| == 1
    ensures exists x :: s == {x}
  {
    var x :| x in s;
    assert |s - {x}| == 0;
    assert s - {x} == {};
  }

  function MatchOf(platform: Platform, docs: map<DocId, Document>, listing: Listing, doc: DocId): Path
    requires doc in docs && docs[doc].binding.Some? && Matched(platform, docs, listing, doc)
  {
    var c := Candidates(platform, docs, listing, docs[doc].binding.value.seen);
    SingletonPick(c);
    var q :| q in c; q
  }

  // One document's row after the scan.
  function ScanDoc(platform: Platform, docs: map<DocId, Document>, listing: Listing, doc: DocId, rev: RevId): Document
    requires doc in docs && ListingDistinct(platform, listing)
  {
    var document := docs[doc];
    if document.binding.None? then document
    else
      var b := document.binding.value;
      if Listed(platform, listing, b.spelling) then
        var file := listing[ListedAt(platform, listing, b.spelling)];
        if file.0 == b.seen
           && (document.outbox.Some?
               || (document.base.Some? && !document.base.value.deleted && document.base.value.content == file.0))
        then document
        // An offline edit, or a file the server does not have as it is.
        else Rebind(document, b.spelling, file.0, file.1, rev)
      else if Matched(platform, docs, listing, doc) then
        var q := MatchOf(platform, docs, listing, doc);
        Rebind(document, q, b.seen, listing[q].1, rev)
      // Missing and not matched: the user deleted it while the app was closed.
      else Unbind(document, rev)
  }

  function ScanJournal(platform: Platform, journal: Journal, listing: Listing, revs: FreshRevs): Journal
    requires journal.documents.Keys <= revs.Keys && ListingDistinct(platform, listing)
  {
    journal.(documents := map doc | doc in journal.documents ::
      ScanDoc(platform, journal.documents, listing, doc, revs[doc]))
  }

  function OnScan(platform: Platform, journal: Journal, listing: Listing, revs: FreshRevs): (Journal, seq<Effect>)
    requires journal.documents.Keys <= revs.Keys && ListingDistinct(platform, listing)
  {
    var journal' := ScanJournal(platform, journal, listing, revs);
    (journal', [PersistJournal(journal')])
  }

  // The core's invariant
  // ---------------------------------------------------------------------

  // A user's delete is never forgotten: a document whose file the user
  // removed has no binding only while it has an outbox to send or the
  // server already has its tombstone as its base.
  ghost predicate CoreInv(state: State) {
    forall d, doc :: d in state.devices && doc in state.devices[d].journal.documents ==>
      var document := state.devices[d].journal.documents[doc];
      (document.binding.None? && document.absence == UserDeleted) ==>
        document.outbox.Some? || (document.base.Some? && document.base.value.deleted)
  }

  // ---------------------------------------------------------------------
  // Steps of the core
  // ---------------------------------------------------------------------

  // The state after the core answered on device d with `journal`: only d's
  // journal changes (the effects touch no disk, DisksFollowEffects).
  ghost function After(pre: State, d: DeviceId, journal: Journal): State
    requires d in pre.devices
  {
    pre.(devices := pre.devices[d := pre.devices[d].(journal := journal)])
  }

  ghost function LocalStep(pre: State, d: DeviceId, local: LocalEvent, revs: FreshRevs): Step
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
  {
    var device := pre.devices[d];
    var input := map p | p in LocalEventPaths(local) :: ReadAt(device, p);
    var answer := OnLocal(device.platform, device.journal, local, input, revs);
    Step(pre, Local(d, local), answer.1, After(pre, d, answer.0))
  }

  // Every step predicate of Guarantees.dfy, and the effect semantics.
  // (G10_NoLoop relates two sync rounds, so no local step is one of its
  // steps.)
  ghost predicate StepGuarantees(step: Step) {
    G1_OnlyRetentionRemoves(step)
    && G2_OnlyWhatItSaw(step) && G2_Conditional(step) && G2_NoUntrackedDelete(step) && G2_UnsavedSafe(step)
    && G5_RenameKeepsDocument(step) && G5_NeverMixedUp(step)
    && (forall d, doc, remote :: SettlesConcurrent(step, d, doc, remote) ==> G6_Settle(step, d, doc, remote))
    && G7_MoveKeepsContents(step)
    && G8_Recovers(step) && G8_PicksUpOfflineChanges(step)
    && G10_SettledOrReported(step)
    && DisksFollowEffects(step)
  }

  // ---------------------------------------------------------------------
  // The theorem for local events
  // ---------------------------------------------------------------------

  lemma LocalEventSafe(pre: State, d: DeviceId, local: LocalEvent, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
    requires StateInvariants(pre) && CoreInv(pre)
    ensures var step := LocalStep(pre, d, local, revs);
      StateInvariants(step.post) && CoreInv(step.post) && StepGuarantees(step)
  {
    var step := LocalStep(pre, d, local, revs);
    var device := pre.devices[d];
    var input := map p | p in LocalEventPaths(local) :: ReadAt(device, p);
    var journal' := LocalJournal(device.platform, device.journal, local, input, revs);
    assert step.post == After(pre, d, journal');
    assert step.effects == [PersistJournal(journal')];
    forall doc | doc in device.journal.documents
      ensures LocalRowFacts(device.platform, device.journal.documents[doc], journal'.documents[doc])
    {
      LocalDocFacts(device.platform, device.journal.documents[doc], local, input, revs[doc]);
    }
    JournalOnlyStep(step, d, journal');
    NeverJoinedAfterLocal(pre, d, local, input, revs);
    MixedUpAfterLocal(pre, d, local, input, revs);
  }

  // What every row update of the core keeps: the base and the ahead, and an
  // outbox on every row it changes; a binding gone from a row that had one
  // is a user's delete (CoreInv).
  ghost predicate LocalRowFacts(platform: Platform, before: Document, after: Document) {
    after.base == before.base && after.ahead == before.ahead
    && (after != before ==> after.outbox.Some?)
    && (after.binding.None? && after.absence == UserDeleted && after != before ==> after.outbox.Some?)
    && (after.binding.None? ==> before.binding.None? || after.absence == UserDeleted)
  }

  lemma LocalDocFacts(platform: Platform, document: Document, local: LocalEvent, input: map<Path, Read>, rev: RevId)
    ensures LocalRowFacts(platform, document, LocalDoc(platform, document, local, input, rev))
  {}

  // ---------------------------------------------------------------------
  // Steps that change only one device's journal
  // ---------------------------------------------------------------------

  // A step whose post is pre with d's journal replaced by `journal'`, whose
  // only effect persists the journal, keeps every invariant that does not
  // read bindings, and every step predicate that does not, as long as the
  // journal keeps every base and ahead and puts an outbox on every row it
  // changes.
  lemma JournalOnlyStep(step: Step, d: DeviceId, journal': Journal)
    requires d in step.pre.devices && EventDevice(step.event) == Some(d)
    requires !step.event.User? && !step.event.Restart? && !step.event.SyncRound?
    requires step.post == After(step.pre, d, journal') && step.effects == [PersistJournal(journal')]
    requires StateInvariants(step.pre) && CoreInv(step.pre)
    requires var journal := step.pre.devices[d].journal;
      journal'.documents.Keys == journal.documents.Keys
      && journal' == journal.(documents := journal'.documents)
      && forall doc :: doc in journal.documents ==>
           LocalRowFacts(step.pre.devices[d].platform, journal.documents[doc], journal'.documents[doc])
    ensures G1_Retained(step.post) && G1_LatestNeverPurged(step.post) && G7_OneFilePerName(step.post)
    ensures G9(step.post) && CoreInv(step.post)
    ensures G1_OnlyRetentionRemoves(step)
    ensures G2_OnlyWhatItSaw(step) && G2_Conditional(step) && G2_NoUntrackedDelete(step) && G2_UnsavedSafe(step)
    ensures forall x, doc, remote :: SettlesConcurrent(step, x, doc, remote) ==> G6_Settle(step, x, doc, remote)
    ensures G7_MoveKeepsContents(step) && G8_Recovers(step) && G10_SettledOrReported(step)
    ensures DisksFollowEffects(step)
  {
    var pre := step.pre;
    var post := step.post;
    var journal := pre.devices[d].journal;
    assert forall x :: x in pre.devices ==> x in post.devices && post.devices[x].disk == pre.devices[x].disk;
    forall rev | rev in pre.server.accepted
      ensures Retrievable(pre, rev) <==> Retrievable(post, rev)
    {
      var version := pre.server.accepted[rev];
      if exists x :: x in pre.devices && OnDisk(pre.devices[x], version.content) {
        var x :| x in pre.devices && OnDisk(pre.devices[x], version.content);
        assert OnDisk(post.devices[x], version.content);
      }
      if exists x :: x in post.devices && OnDisk(post.devices[x], version.content) {
        var x :| x in post.devices && OnDisk(post.devices[x], version.content);
        assert OnDisk(pre.devices[x], version.content);
      }
    }
    assert G1_Retained(post);
    assert G7_OneFilePerName(post);
    // G9: either nothing changed, or d has an outbox and has not finished.
    if journal' == journal {
      assert post == pre;
    } else {
      var doc :| doc in journal.documents && journal'.documents[doc] != journal.documents[doc] by {
        if forall doc :: doc in journal.documents ==> journal'.documents[doc] == journal.documents[doc] {
          assert journal'.documents == journal.documents;
          assert journal' == journal;
        }
      }
      assert !FinishedSyncing(post, d);
      forall d1, d2, p | FinishedSyncing(post, d1) && FinishedSyncing(post, d2)
        && p in post.devices[d1].disk && p !in post.devices[d1].outOfScope && p !in post.devices[d2].outOfScope
        ensures (exists q :: q in post.devices[d2].disk
                   && (SameNameModuloFolders(post.devices[d1].platform, p, q) || SameNameModuloFolders(post.devices[d2].platform, p, q))
                   && post.devices[d2].disk[q].content == post.devices[d1].disk[p].content)
                || ReportedCannotHold(post, post.devices[d2], p)
      {
        assert d1 != d && d2 != d;
        assert post.devices[d1] == pre.devices[d1] && post.devices[d2] == pre.devices[d2];
        assert FinishedSyncing(pre, d1) && FinishedSyncing(pre, d2);
      }
    }
    // DisksFollowEffects: the one effect leaves the disk as it is.
    var disk := pre.devices[d].disk;
    assert EffectTakes(pre.devices[d].platform, disk, PersistJournal(journal'), disk);
    assert EffectsTake(pre.devices[d].platform, disk, step.effects[1..], disk);
    assert EffectsTake(pre.devices[d].platform, disk, step.effects, disk);
  }

  // ---------------------------------------------------------------------
  // Bindings after a local event
  // ---------------------------------------------------------------------

  lemma NeverJoinedAfterLocal(pre: State, d: DeviceId, local: LocalEvent, input: map<Path, Read>, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
    requires G5_NeverJoined(pre)
    ensures G5_NeverJoined(After(pre, d, LocalJournal(pre.devices[d].platform, pre.devices[d].journal, local, input, revs)))
  {
    var device := pre.devices[d];
    var platform := device.platform;
    var docs := device.journal.documents;
    var post := After(pre, d, LocalJournal(platform, device.journal, local, input, revs));
    var docs' := post.devices[d].journal.documents;
    forall doc1, doc2 | doc1 != doc2 && doc1 in docs' && doc2 in docs'
      && docs'[doc1].binding.Some? && docs'[doc2].binding.Some?
      ensures !SameF(platform, docs'[doc1].binding.value.spelling, docs'[doc2].binding.value.spelling)
    {
      assert docs[doc1].binding.Some? && docs[doc2].binding.Some?;
      var s1, s2 := docs[doc1].binding.value.spelling, docs[doc2].binding.value.spelling;
      assert !SameF(platform, s1, s2);
      if local.Renamed? {
        var from, to := local.from, local.to;
        if BoundAt(platform, docs[doc1], from) {
          assert !BoundAt(platform, docs[doc2], from);
          assert !BoundAt(platform, docs[doc2], to);
        } else if BoundAt(platform, docs[doc2], from) {
          assert !BoundAt(platform, docs[doc1], to);
        }
      }
    }
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}
  }

  lemma MixedUpAfterLocal(pre: State, d: DeviceId, local: LocalEvent, input: map<Path, Read>, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
    requires G7_OneFilePerName(pre)
    requires input == map p | p in LocalEventPaths(local) :: ReadAt(pre.devices[d], p)
    ensures var answer := OnLocal(pre.devices[d].platform, pre.devices[d].journal, local, input, revs);
      var step := Step(pre, Local(d, local), answer.1, After(pre, d, answer.0));
      G5_RenameKeepsDocument(step) && G5_NeverMixedUp(step) && G8_PicksUpOfflineChanges(step)
  {
    var before := pre.devices[d];
    var platform := before.platform;
    var answer := OnLocal(platform, before.journal, local, input, revs);
    var step := Step(pre, Local(d, local), answer.1, After(pre, d, answer.0));
    var after := step.post.devices[d];
    var docs := before.journal.documents;
    var docs' := after.journal.documents;
    assert after.disk == before.disk && after.platform == platform;
    forall doc | BoundIdentity(after, doc).Some? && BoundIdentity(after, doc) != BoundIdentity(before, doc)
      ensures local.Renamed? && BoundTo(before, doc, local.from) && SameF(platform, local.to, docs'[doc].binding.value.spelling)
    {
      assert docs[doc].binding.Some?;
      if docs'[doc].binding.value.spelling == docs[doc].binding.value.spelling {
        SameFileOnSameDisk(before, after, docs[doc].binding.value.spelling);
        assert false;
      }
    }
  }

  // Two devices with the same disk and platform find the same file at a
  // name, because no two files share a name under F (G7).
  lemma SameFileOnSameDisk(before: Device, after: Device, s: Path)
    requires before.disk == after.disk && before.platform == after.platform
    requires forall p, q :: p in before.disk && q in before.disk && p != q ==> !CollideF(before.platform, p, q)
    ensures HasFile(before, s) == HasFile(after, s)
    ensures HasFile(before, s) ==> FileAt(before, s) == FileAt(after, s)
  {
    if HasFile(before, s) {
      var p :| p in before.disk && SameF(before.platform, p, s) && FileAt(before, s) == before.disk[p];
      var q :| q in after.disk && SameF(after.platform, q, s) && FileAt(after, s) == after.disk[q];
      if p != q { assert CollideF(before.platform, p, q); }
    }
  }

  // ---------------------------------------------------------------------
  // The theorem for the start-up scan
  // ---------------------------------------------------------------------

  // The scan's listing is the device's disk (verified-core.md §2.3).
  ghost function ListingOf(device: Device): Listing {
    map p | p in device.disk :: (device.disk[p].content, device.disk[p].kind)
  }

  ghost function ScanStep(pre: State, d: DeviceId, revs: FreshRevs): Step
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
    requires ListingDistinct(pre.devices[d].platform, ListingOf(pre.devices[d]))
  {
    var device := pre.devices[d];
    var listing := ListingOf(device);
    var answer := OnScan(device.platform, device.journal, listing, revs);
    Step(pre, Scan(d, listing), answer.1, After(pre, d, answer.0))
  }

  lemma DistinctDisk(device: Device)
    requires forall p, q :: p in device.disk && q in device.disk && p != q ==> !CollideF(device.platform, p, q)
    ensures ListingDistinct(device.platform, ListingOf(device))
  {}

  lemma ScanSafe(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
    requires StateInvariants(pre) && CoreInv(pre)
    ensures ListingDistinct(pre.devices[d].platform, ListingOf(pre.devices[d]))
    ensures var step := ScanStep(pre, d, revs);
      StateInvariants(step.post) && CoreInv(step.post) && StepGuarantees(step)
  {
    var device := pre.devices[d];
    DistinctDisk(device);
    var platform := device.platform;
    var listing := ListingOf(device);
    var docs := device.journal.documents;
    var step := ScanStep(pre, d, revs);
    var journal' := ScanJournal(platform, device.journal, listing, revs);
    assert step.post == After(pre, d, journal');
    forall doc | doc in docs
      ensures LocalRowFacts(platform, docs[doc], journal'.documents[doc])
    {}
    JournalOnlyStep(step, d, journal');
    ScanBindings(pre, d, revs);
  }

  lemma ScanBindings(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices && pre.devices[d].journal.documents.Keys <= revs.Keys
    requires StateInvariants(pre)
    requires ListingDistinct(pre.devices[d].platform, ListingOf(pre.devices[d]))
    ensures var step := ScanStep(pre, d, revs);
      G5_NeverJoined(step.post) && G5_RenameKeepsDocument(step) && G5_NeverMixedUp(step) && G8_PicksUpOfflineChanges(step)
  {
    var before := pre.devices[d];
    var platform := before.platform;
    var listing := ListingOf(before);
    var docs := before.journal.documents;
    var step := ScanStep(pre, d, revs);
    var after := step.post.devices[d];
    var docs' := after.journal.documents;
    assert after.disk == before.disk && after.platform == platform;
    assert forall s :: Listed(platform, listing, s) <==> HasFile(before, s);
    forall q ensures TrackedIn(platform, docs, q) <==> Tracked(before, q) {
      if TrackedIn(platform, docs, q) {
        var doc :| doc in docs && BoundAt(platform, docs[doc], q);
        assert BoundTo(before, doc, q);
      }
      if Tracked(before, q) {
        var doc :| BoundTo(before, doc, q);
        assert BoundAt(platform, docs[doc], q);
      }
    }

    // Bindings after the scan: a matched document is at its match, every
    // other bound document where it was.
    forall doc | doc in docs && docs'[doc].binding.Some?
      ensures docs[doc].binding.Some?
      ensures MissingIn(platform, listing, docs[doc]) ==>
        Matched(platform, docs, listing, doc)
        && docs'[doc].binding.value.spelling == MatchOf(platform, docs, listing, doc)
      ensures !MissingIn(platform, listing, docs[doc]) ==>
        docs'[doc].binding.value.spelling == docs[doc].binding.value.spelling
      ensures HasFile(after, docs'[doc].binding.value.spelling)
    {
      if MissingIn(platform, listing, docs[doc]) && Matched(platform, docs, listing, doc) {
        var q := MatchOf(platform, docs, listing, doc);
        assert q in listing;
        assert SameF(platform, q, q);
      }
    }

    // G5_NeverJoined.
    forall doc1, doc2 | doc1 != doc2 && doc1 in docs' && doc2 in docs'
      && docs'[doc1].binding.Some? && docs'[doc2].binding.Some?
      ensures !SameF(platform, docs'[doc1].binding.value.spelling, docs'[doc2].binding.value.spelling)
    {
      var m1, m2 := MissingIn(platform, listing, docs[doc1]), MissingIn(platform, listing, docs[doc2]);
      var s1, s2 := docs'[doc1].binding.value.spelling, docs'[doc2].binding.value.spelling;
      if m1 && m2 {
        var c1 := Candidates(platform, docs, listing, docs[doc1].binding.value.seen);
        assert s1 in c1;
        if docs[doc1].binding.value.seen == docs[doc2].binding.value.seen {
          assert Rival(platform, docs, listing, doc1, docs[doc1].binding.value.seen);
        }
        assert s1 != s2;
      } else if m1 {
        var c1 := Candidates(platform, docs, listing, docs[doc1].binding.value.seen);
        assert s1 in c1;
        assert BoundAt(platform, docs[doc2], s2);
        if SameF(platform, s1, s2) { assert BoundAt(platform, docs[doc2], s1); assert TrackedIn(platform, docs, s1); }
      } else if m2 {
        var c2 := Candidates(platform, docs, listing, docs[doc2].binding.value.seen);
        assert s2 in c2;
        assert BoundAt(platform, docs[doc1], s1);
        if SameF(platform, s1, s2) { assert BoundAt(platform, docs[doc1], s2); assert TrackedIn(platform, docs, s2); }
      }
    }
    forall x | x in step.post.devices && x != d ensures step.post.devices[x] == pre.devices[x] {}
    assert G5_NeverJoined(step.post);

    // G5_NeverMixedUp: only a matched document changes file, by rule (c).
    forall doc | BoundIdentity(after, doc).Some? && BoundIdentity(after, doc) != BoundIdentity(before, doc)
      ensures FileMissing(before, doc)
      ensures BoundFile(after, doc).value.content == before.journal.documents[doc].binding.value.seen
      ensures forall q :: (q in before.disk && Untracked(before, q)
                  && before.disk[q].content == BoundFile(after, doc).value.content) ==>
                SameF(platform, q, docs'[doc].binding.value.spelling)
      ensures forall other :: other != doc && FileMissing(before, other) ==>
                before.journal.documents[other].binding.value.seen != BoundFile(after, doc).value.content
    {
      if !MissingIn(platform, listing, docs[doc]) {
        SameFileOnSameDisk(before, after, docs[doc].binding.value.spelling);
        assert false;
      }
      var seen := docs[doc].binding.value.seen;
      var q := docs'[doc].binding.value.spelling;
      var c := Candidates(platform, docs, listing, seen);
      assert q in c;
      SingletonPick(c);
      assert c == {q};
      SameFileOnSameDisk(after, after, q);
      assert q in after.disk && SameF(platform, q, q);
      assert BoundFile(after, doc).value == FileAt(after, q);
      assert FileAt(after, q) == after.disk[q] by {
        var r :| r in after.disk && SameF(platform, r, q) && FileAt(after, q) == after.disk[r];
        if r != q { assert CollideF(platform, r, q); }
      }
      forall q' | q' in before.disk && Untracked(before, q') && before.disk[q'].content == seen
        ensures SameF(platform, q', q)
      {
        assert q' in c;
      }
      forall other | other != doc && FileMissing(before, other)
        ensures docs[other].binding.value.seen != seen
      {
        assert MissingIn(platform, listing, docs[other]);
      }
    }

    // G8_PicksUpOfflineChanges.
    forall p | p in after.disk && p !in after.outOfScope
      ensures AsServerHas(after, p) || PendingPush(after, p)
    {
      if !Untracked(after, p) {
        assert HasFile(after, p) by { assert SameF(platform, p, p); }
        var doc :| BoundTo(after, doc, p);
        var s := docs'[doc].binding.value.spelling;
        if docs'[doc] != docs[doc] {
          assert LocalChange(after, doc);
        } else {
          assert !MissingIn(platform, listing, docs[doc]);
          var q := ListedAt(platform, listing, s);
          if q != p { assert CollideF(platform, q, p); }
          if docs[doc].outbox.Some? {
            assert LocalChange(after, doc);
          } else {
            assert AsServerHas(after, p);
          }
        }
      }
    }
    forall doc | doc in docs' && docs'[doc].binding.Some?
      ensures HasFile(after, docs'[doc].binding.value.spelling)
    {}
    forall doc | FileMissing(before, doc) && doc in docs' && docs'[doc].binding.None?
      ensures docs'[doc].absence == UserDeleted
    {
      assert MissingIn(platform, listing, docs[doc]);
    }
  }
}
