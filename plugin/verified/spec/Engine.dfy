// The engine's abstract state, the events that change it and the effects the
// core may request (#947, docs/design/verified-core.md §2). This is a
// specification only: it has no decision logic and is not compiled. The
// vocabulary is docs/design/engine-path-ownership.md §4.
include "Paths.dfy"

abstract module EngineModel {
  import opened P : PathModel

  datatype Option<T> = None | Some(value: T)

  // ---------------------------------------------------------------------
  // Identifiers and contents
  // ---------------------------------------------------------------------

  type DocId(==, !new)
  type RevId(==, !new)
  type DeviceId(==, !new)
  type IntentId(==, !new)
  // A content hash. Bytes are identified by their hash (SPEC.md §6).
  type Hash(==, !new)
  // The harness's file identity (an inode, design §5.4). It is ghost: the
  // engine never sees it. The guarantees use it to say which file is which.
  type FileIdentity(==, !new)

  // The supply of file identities is unbounded: whatever finitely many files
  // exist, a new file can get an identity none of them has. Sound because
  // the harness's inodes are unbounded (a fresh number per file); the
  // refinement `NatIdentities` (Witnesses.dfy) proves it for identities that
  // are natural numbers, so the axiom is consistent. Without it a create
  // could have no outcome (`EffectsCanTake`).
  lemma {:axiom} FreshIdentityExists(used: set<FileIdentity>)
    ensures exists identity: FileIdentity :: identity !in used

  datatype Kind = Note | Binary

  // ---------------------------------------------------------------------
  // The server
  // ---------------------------------------------------------------------

  // A revision of a document as the server stores it (SPEC.md §6).
  datatype Revision = Revision(
    id: RevId,
    doc: DocId,
    position: nat,
    parent: Option<RevId>,
    path: Path,
    content: Hash,
    kind: Kind,
    deleted: bool,
    device: DeviceId)

  // What the server holds. `history[d]` is document d's line of revisions,
  // oldest first; its last element is the head. `purged` are revisions the
  // retention policy removed (SPEC.md §11). `accepted` is ghost bookkeeping:
  // every revision the server ever acknowledged, by id, even one a restore
  // from backup later lost.
  datatype Server = Server(
    revisions: map<RevId, Revision>,
    history: map<DocId, seq<RevId>>,
    feed: seq<RevId>,
    purged: set<RevId>,
    ghost accepted: map<RevId, Revision>)

  // ---------------------------------------------------------------------
  // The device: journal (documents, bindings, outbox, server view), intents
  // ---------------------------------------------------------------------

  // §4.1 base(D): the last server revision applied to disk or acknowledged.
  datatype Base = Base(rev: RevId, position: nat, path: Path, content: Hash, kind: Kind, deleted: bool)

  // §4.1 ahead(D): the newest server revision not yet applied, and why.
  datatype Blocker =
    | LocalChanges
    | PathHeld
    | InvalidPath
    | Unmaterializable(alias: bool)
    | OutOfScope
    | TooLarge
  datatype Ahead = Ahead(revision: Revision, blocker: Blocker, postponed: bool)

  // §4.1 binding(D): the local file that is D on this device.
  datatype Binding = Binding(spelling: Path, seen: Hash, displaced: bool, userSpelling: Option<Path>)
  datatype Absence = UserDeleted | Released | Never

  // §4.1 outbox(D): the one commit D will send.
  datatype Outbox = Outbox(
    rev: RevId,
    baseRev: Option<RevId>,
    path: Path,
    content: Hash,
    kind: Kind,
    deleted: bool,
    sealed: bool,
    // The server refused it with INVALID_ARGUMENT: it stays, is reported as
    // rejected, and is dropped only when its file is gone (SPEC.md §6.2).
    rejected: bool)

  // One row per document the journal knows.
  datatype Document = Document(
    base: Option<Base>,
    ahead: Option<Ahead>,
    binding: Option<Binding>,
    absence: Absence,
    outbox: Option<Outbox>)

  // §4.4 intents: write-ahead records of multi-step changes.
  datatype IntentKind =
    | ApplyIntent(doc: DocId, revision: Revision)
    | MergeIntent(doc: DocId, revision: Revision, result: Path, resultContent: Hash, copy: Option<(Path, Hash)>)
    | DisplaceIntent(doc: DocId, from: Path, to: Path, content: Hash)
    | DetachIntent(doc: DocId, from: Path, to: Path)
    | CommitIntent(doc: DocId)
    | ResyncIntent
  datatype Intent = Intent(id: IntentId, kind: IntentKind)

  // The conflict log is a UI log only (§4.1), never a write-ahead record.
  datatype ConflictRecord = ConflictRecord(doc: Option<DocId>, copy: Path, reason: string)

  datatype Journal = Journal(
    documents: map<DocId, Document>,
    cursor: nat,
    intents: seq<Intent>,
    conflicts: seq<ConflictRecord>)

  // ---------------------------------------------------------------------
  // The disk
  // ---------------------------------------------------------------------

  // A listed file: its content, and (ghost) which file it is.
  datatype DiskFile = DiskFile(content: Hash, kind: Kind, ghost identity: FileIdentity)

  // An open editor holding text not yet saved to the file (SPEC.md §8
  // "Editor-safe writes").
  datatype Editor = Editor(path: Path, unsaved: Option<Hash>)

  datatype Device = Device(
    platform: Platform,
    running: bool,
    journal: Journal,
    disk: map<Path, DiskFile>,
    editors: set<Editor>,
    // Paths this device does not sync (out of scope: settings it chose not to
    // sync, SPEC.md §8 ".obsidian/ config sync").
    outOfScope: set<Path>)

  datatype State = State(devices: map<DeviceId, Device>, server: Server)

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  // What a user does to a device's disk, with or without the app running.
  // These change the disk; the plugin learns of them only through local
  // file events (which can be lost) or the start-up scan.
  datatype UserAction =
    | WriteFile(path: Path, content: Hash, kind: Kind)
    | DeleteFile(path: Path)
    | RenameFile(from: Path, to: Path)
    | EditBuffer(path: Path, unsaved: Option<Hash>)

  // Local file events the vault reports (design §4.3 E1-E6).
  datatype LocalEvent =
    | Created(path: Path)
    | Modified(path: Path)
    | Deleted(path: Path)
    | Renamed(from: Path, to: Path)

  // The outcome of a commit (SPEC.md §6.2).
  datatype PushResult =
    | Accepted(doc: DocId, revision: Revision)
    | HeadMoved(doc: DocId)
    | AlreadyExists(doc: DocId)
    | InvalidArgument(doc: DocId)
    | Unavailable

  datatype Event =
    | User(device: DeviceId, action: UserAction)
    | Local(device: DeviceId, local: LocalEvent)
    // E7: the start-up scan, with the vault listing.
    | Scan(device: DeviceId, listing: map<Path, (Hash, Kind)>)
    // A remote revision delivered to the device outside a sync round (a
    // pull the realtime channel triggered, or a page of a pull still being
    // read).
    | RemoteRevision(device: DeviceId, revision: Revision)
    | Pushed(device: DeviceId, result: PushResult)
    // A server restore from backup; the server's revisions after it.
    | Restore(restored: Server)
    // A retention purge of non-head revisions (SPEC.md §11).
    | Purge(revisions: set<RevId>)
    // A user restores a document's earlier revision from history (SPEC.md
    // §11), which commits it as a new revision.
    | RestoreFromHistory(doc: DocId, from: RevId, revision: Revision)
    // A crash of the device's app. `cut` is the step it cut short, if any
    // (`CrashCutsShort`).
    | Crash(device: DeviceId, cut: Option<Cut>)
    | Restart(device: DeviceId)
    // One sync round the engine runs on its own: a pull, then a push. The
    // step includes the pull's results: the revisions on the feed after the
    // device's cursor when the round starts are handed to the core within
    // the step (its `Pull` effect names where the pull starts), together
    // with the round's input (`RoundInput`, `RoundInputOf`). The push's
    // answers arrive as later `Pushed` events.
    | SyncRound(device: DeviceId)
    // The resync the shell runs on the server's divergence signal after a
    // restore from backup (SPEC.md §8 "Divergence"): a round that re-reads
    // every head instead of the feed after the cursor (verified-core.md
    // §4.1). Its step includes its input as a sync round's does.
    | Resync(device: DeviceId)

  ghost predicate IsUserAction(event: Event) { event.User? }

  // A step a crash cut short: its event, and the effects the core requested
  // in response to it from the crash step's pre state.
  datatype Cut = Cut(event: Event, requested: seq<Effect>)

  // ---------------------------------------------------------------------
  // Effects the core may request
  // ---------------------------------------------------------------------

  // Every disk effect carries its precondition (SPEC.md §8 "Conditional
  // writes"): the adapter performs it only if the disk still matches.
  datatype Effect =
    // Write `content` at `path` for document `doc` (target None: a conflict copy or
    // other untracked file). `precondition` is the content the file must still
    // have (None: no file may be there).
    | Write(target: Option<DocId>, path: Path, content: Hash, kind: Kind, precondition: Option<Hash>)
    // Delete the file at `path`, which must still hold `expected`.
    | Remove(doc: DocId, path: Path, expected: Hash)
    // Move the file at `from` (which must hold `expected`) to `to` (which must
    // be free).
    | Move(mover: Option<DocId>, from: Path, to: Path, expected: Hash)
    | ReadFile(path: Path)
    | Upload(content: Hash)
    | Commit(doc: DocId, outbox: Outbox)
    | Pull(cursor: nat)
    | PersistJournal(journal: Journal)
    // Tell the user about something only they can settle, or a file this
    // device cannot hold.
    | Report(subject: Option<DocId>, path: Path, reason: string)

  ghost predicate IsDiskEffect(effect: Effect) { effect.Write? || effect.Remove? || effect.Move? }

  // One step of the system: an event, the effects the core requested in
  // response, and the state before and after.
  datatype Step = Step(pre: State, event: Event, effects: seq<Effect>, post: State)

  type Trace = seq<Step>

  // A trace is connected: each step starts where the previous one ended.
  ghost predicate Connected(trace: Trace) {
    forall i :: 0 < i < |trace| ==> trace[i].pre == trace[i - 1].post
  }

  // ---------------------------------------------------------------------
  // What an effect does to the disk (verified-core.md §2.3)
  // ---------------------------------------------------------------------

  // The device whose disk and journal a step's effects act on.
  ghost function EventDevice(event: Event): Option<DeviceId> {
    match event
    case User(d, _) => Some(d)
    case Local(d, _) => Some(d)
    case Scan(d, _) => Some(d)
    case RemoteRevision(d, _) => Some(d)
    case Pushed(d, _) => Some(d)
    case Crash(d, _) => Some(d)
    case Restart(d) => Some(d)
    case SyncRound(d) => Some(d)
    case Resync(d) => Some(d)
    case _ => None
  }

  // The file at `path` on a device, found under the device's F.
  ghost predicate HasFile(device: Device, path: Path) {
    exists q :: q in device.disk && SameF(device.platform, q, path)
  }
  ghost function FileAt(device: Device, path: Path): DiskFile
    requires HasFile(device, path)
  {
    var q :| q in device.disk && SameF(device.platform, q, path); device.disk[q]
  }


  // What the shell reads at `path` when it hands the core an event: the
  // content and kind of the file there under the device's F, or None when no
  // file is there.
  ghost function ReadAt(device: Device, path: Path): Option<(Hash, Kind)> {
    if HasFile(device, path) then Some((FileAt(device, path).content, FileAt(device, path).kind)) else None
  }

  // The paths a local event names.
  ghost function LocalEventPaths(local: LocalEvent): set<Path> {
    match local
    case Created(p) => {p}
    case Modified(p) => {p}
    case Deleted(p) => {p}
    case Renamed(from, to) => {from, to}
  }

  // How file contents reach the core: a local event's input is the event
  // together with the shell's read of every path it names, taken from the
  // step's pre disk (there is no read-result event). The start-up scan's
  // input is its listing.
  ghost function LocalReads(step: Step): map<Path, Option<(Hash, Kind)>>
    requires step.event.Local? && step.event.device in step.pre.devices
  {
    map p | p in LocalEventPaths(step.event.local) :: ReadAt(step.pre.devices[step.event.device], p)
  }

  // A sync round's input (verified-core.md §2.3): what the shell hands the
  // core with a `SyncRound` besides the pulled revisions. `listing` is the
  // device's vault listing, every file with its content and kind (as the
  // start-up scan's), so the push can name untracked files and the round
  // knows the content of every file it writes over. `unsaved` are the paths
  // an open editor holds unsaved text at. `freshDocs` are document ids for
  // the documents the push creates. `outOfScope` are the paths the device
  // does not sync, so the round creates no document for a file at one and
  // applies no revision at one; the listing still names those files, so the
  // round knows every file its writes and moves can collide with.
  datatype RoundInput = RoundInput(listing: map<Path, (Hash, Kind)>, unsaved: set<Path>, freshDocs: seq<DocId>, outOfScope: set<Path>)

  // The device's listing: every file on its disk, by spelling.
  ghost function DiskListing(device: Device): map<Path, (Hash, Kind)> {
    map p | p in device.disk :: (device.disk[p].content, device.disk[p].kind)
  }

  // The paths at which an open editor holds unsaved text.
  ghost function UnsavedPaths(device: Device): set<Path> {
    set editor | editor in device.editors && editor.unsaved.Some? :: editor.path
  }

  // A document id some device's journal or the server already uses.
  ghost predicate DocIdUsed(state: State, doc: DocId) {
    (exists d :: d in state.devices && doc in state.devices[d].journal.documents)
    || doc in state.server.history
    || (exists rev :: rev in state.server.revisions && state.server.revisions[rev].doc == doc)
    || (exists rev :: rev in state.server.accepted && state.server.accepted[rev].doc == doc)
  }

  // `input` is device d's input for a round starting in `state`: the listing,
  // the unsaved paths and the device's scope are read from the state before
  // (the same disk the effects' preconditions are checked against), and the
  // fresh document ids
  // are distinct and used by no device and not by the server. Their freshness
  // is a fact about other devices and the server, which the core cannot see;
  // the shell meets it with random UUIDs.
  ghost predicate RoundInputOf(state: State, d: DeviceId, input: RoundInput) {
    d in state.devices
    && input.listing == DiskListing(state.devices[d])
    && input.unsaved == UnsavedPaths(state.devices[d])
    && input.outOfScope == state.devices[d].outOfScope
    && (forall i, j :: 0 <= i < j < |input.freshDocs| ==> input.freshDocs[i] != input.freshDocs[j])
    && (forall i :: 0 <= i < |input.freshDocs| ==> !DocIdUsed(state, input.freshDocs[i]))
  }

  // What a sync round read at `path` (under the device's F): the content of
  // the file there in the round's listing. It is ReadAt of the state before.
  ghost function RoundRead(step: Step, path: Path): Option<(Hash, Kind)>
    requires step.event.SyncRound? && step.event.device in step.pre.devices
  {
    ReadAt(step.pre.devices[step.event.device], path)
  }

  // No file on `disk` collides with `path` under F (design §3.2: the same
  // name, or a file where a folder of the name is, or under the name).
  ghost predicate FreeOn(platform: Platform, disk: map<Path, DiskFile>, path: Path) {
    forall q :: q in disk ==> !CollideF(platform, q, path)
  }

  // The file found at spelling q (under F) holds `content`.
  ghost predicate Holds(platform: Platform, disk: map<Path, DiskFile>, q: Path, path: Path, content: Hash) {
    q in disk && SameF(platform, q, path) && disk[q].content == content
  }

  // One effect acting on one device's disk, from `disk` to `disk'`. A disk
  // effect takes effect only when its precondition matches the disk under
  // the device's F, and otherwise does nothing (SPEC.md §8 "Conditional
  // writes"):
  // - a Write conditional on content h overwrites the file holding h in
  //   place: the same file (identity) and spelling, with the new content and
  //   kind;
  // - a Write conditional on no file creates a new file (an identity no file
  //   on the disk has) at `path`, if no file collides with `path`;
  // - a Remove deletes the file holding `expected`;
  // - a Move takes the file holding `expected` (the same file, with its
  //   content and kind) to `to`, if no other file collides with `to` and
  //   neither name is a folder of the other (a rename that changes only the
  //   case of the name is allowed).
  // Every other effect leaves the disk unchanged.
  ghost predicate EffectTakes(platform: Platform, disk: map<Path, DiskFile>, effect: Effect, disk': map<Path, DiskFile>) {
    match effect
    case Write(_, path, content, kind, precondition) =>
      if precondition.Some? then
        if exists q :: Holds(platform, disk, q, path, precondition.value)
        then exists q :: Holds(platform, disk, q, path, precondition.value)
               && disk' == disk[q := DiskFile(content, kind, disk[q].identity)]
        else disk' == disk
      else
        if FreeOn(platform, disk, path)
        then exists identity: FileIdentity :: (forall q :: q in disk ==> disk[q].identity != identity)
               && disk' == disk[path := DiskFile(content, kind, identity)]
        else disk' == disk
    case Remove(_, path, expected) =>
      if exists q :: Holds(platform, disk, q, path, expected)
      then exists q :: Holds(platform, disk, q, path, expected) && disk' == disk - {q}
      else disk' == disk
    case Move(_, from, to, expected) =>
      if exists q :: MovableTo(platform, disk, q, from, to, expected)
      then exists q :: MovableTo(platform, disk, q, from, to, expected) && disk' == (disk - {q})[to := disk[q]]
      else disk' == disk
    case _ => disk' == disk
  }

  ghost predicate MovableTo(platform: Platform, disk: map<Path, DiskFile>, q: Path, from: Path, to: Path, expected: Hash) {
    Holds(platform, disk, q, from, expected)
    && FreeOn(platform, disk - {q}, to)
    && (CollideF(platform, q, to) ==> SameF(platform, q, to))
  }

  // The effects act in the order requested, each on the disk the earlier
  // ones left.
  ghost predicate EffectsTake(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>)
    decreases |effects|
  {
    if |effects| == 0 then disk' == disk
    else exists mid :: EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk')
  }

  // A step's disks follow its effects. In a step that is not the user's,
  // the event's device's disk after the step is its disk before with the
  // step's effects applied in order, and no other device's disk changes.
  // (A user's step changes the disk by the user's action, not by effects.)
  // A crash cuts a step short: that step does not complete, and the
  // device's Crash step lists, as its effects, the prefix of the
  // interrupted step's effects the shell had performed, which therefore
  // act on the disk as any step's effects do (CrashCutsShort).
  ghost predicate DisksFollowEffects(step: Step) {
    !step.event.User? ==>
      forall d :: d in step.pre.devices && d in step.post.devices ==>
        if EventDevice(step.event) == Some(d)
        then EffectsTake(step.pre.devices[d].platform, step.pre.devices[d].disk, step.effects, step.post.devices[d].disk)
        else step.post.devices[d].disk == step.pre.devices[d].disk
  }

  // A crash step's effects are a prefix of the effects the core requested
  // for the step the crash cut short, an event of the same device that the
  // core handles (not a user's action or another crash) and that starts in
  // the crash step's pre state. A crash that cut nothing short performs no
  // effect. That `cut.requested` is what the core requests for `cut.event`
  // in that state is a proof obligation of the verified core.
  ghost predicate CrashCutsShort(step: Step) {
    step.event.Crash? ==>
      if step.event.cut.Some? then
        var cut := step.event.cut.value;
        EventDevice(cut.event) == Some(step.event.device)
        && !cut.event.User? && !cut.event.Crash?
        && |step.effects| <= |cut.requested|
        && step.effects == cut.requested[..|step.effects|]
      else step.effects == []
  }

  // ---------------------------------------------------------------------
  // What a step does to the server (verified-core.md §2.3)
  // ---------------------------------------------------------------------

  // A revision's parent is the document's head on `server` (None for a
  // document the server has no head of): SPEC.md §6.2, a commit is accepted
  // only on the head it was based on.
  ghost predicate ParentIsHead(server: Server, doc: DocId, parent: Option<RevId>) {
    if Head(server, doc).Some? then parent == Some(Head(server, doc).value.id) else parent.None?
  }

  // `r` is a new revision of `doc` the server may append: an id the server
  // never used, the document's head as its parent, the document's kind (a
  // document's kind is chosen at creation and never changes: SPEC.md §6.2,
  // the server refuses a commit of another kind), and, if live, a path no
  // other document's live head collides with under K (SPEC.md §5).
  ghost predicate Appendable(server: Server, doc: DocId, r: Revision) {
    r.doc == doc
    && r.id !in server.revisions && r.id !in server.accepted
    && ParentIsHead(server, doc, r.parent)
    && (Head(server, doc).Some? ==> r.kind == Head(server, doc).value.kind)
    && (!r.deleted ==>
          forall other :: other != doc && Head(server, other).Some? && !Head(server, other).value.deleted ==>
            !CollideK(Head(server, other).value.path, r.path))
  }

  // The server after appending `r` to `doc`'s history and to the feed;
  // nothing is dropped.
  ghost function Appended(server: Server, doc: DocId, r: Revision): Server {
    server.(revisions := server.revisions[r.id := r],
            history := server.history[doc := (if doc in server.history then server.history[doc] else []) + [r.id]],
            feed := server.feed + [r.id],
            accepted := server.accepted[r.id := r])
  }

  // A step's server follows its event:
  // - an accepted commit appends one revision, which is the device's sealed
  //   outbox of that document (the commit in flight) on the head it was
  //   based on;
  // - a restore from history appends one live revision with the restored
  //   revision's content and kind;
  // - a purge marks non-head revisions purged and changes nothing else;
  // - a restore from backup leaves the server it names;
  // - a remote revision is one on the feed, and every other event (a push
  //   result other than an accept, a sync round, a user's action, a local
  //   event, the scan, a crash, a restart) leaves the server unchanged.
  ghost predicate ServerFollowsEvent(step: Step) {
    var pre := step.pre.server;
    var post := step.post.server;
    match step.event
    case Pushed(d, Accepted(doc, r)) =>
      d in step.pre.devices && doc in step.pre.devices[d].journal.documents
      && var outbox := step.pre.devices[d].journal.documents[doc].outbox;
      outbox.Some? && outbox.value.sealed
      && r.id == outbox.value.rev && r.parent == outbox.value.baseRev
      && r.path == outbox.value.path && r.content == outbox.value.content
      && r.kind == outbox.value.kind && r.deleted == outbox.value.deleted
      && r.device == d
      && Appendable(pre, doc, r) && post == Appended(pre, doc, r)
    case RestoreFromHistory(doc, from, r) =>
      from in pre.revisions && pre.revisions[from].doc == doc && !r.deleted
      && r.content == pre.revisions[from].content && r.kind == pre.revisions[from].kind
      && Appendable(pre, doc, r) && post == Appended(pre, doc, r)
    case Purge(revisions) =>
      (forall rev :: rev in revisions ==> rev in pre.revisions && !IsHead(pre, rev))
      && post == pre.(purged := pre.purged + revisions)
    // A backup is an earlier state of the server: the restored feed and
    // every restored history are prefixes of the current ones, its revisions
    // are current ones and its purges were made already. The ghost record
    // of what the server accepted is not restored (verified-core.md §4.1).
    case Restore(restored) =>
      restored.feed <= pre.feed
      && (forall doc :: doc in restored.history ==> doc in pre.history && restored.history[doc] <= pre.history[doc])
      && (forall id :: id in restored.revisions ==> id in pre.revisions && restored.revisions[id] == pre.revisions[id])
      && restored.purged <= pre.purged
      && post == restored.(accepted := pre.accepted)
    case RemoteRevision(_, rev) =>
      post == pre && rev.id in pre.revisions && pre.revisions[rev.id] == rev && rev.id in pre.feed
    case _ => post == pre
  }

  // ---------------------------------------------------------------------
  // Derived notions used by the guarantees
  // ---------------------------------------------------------------------

  ghost function Head(server: Server, doc: DocId): Option<Revision> {
    if doc in server.history && |server.history[doc]| > 0
       && server.history[doc][|server.history[doc]| - 1] in server.revisions
    then Some(server.revisions[server.history[doc][|server.history[doc]| - 1]])
    else None
  }

  ghost predicate IsHead(server: Server, rev: RevId) {
    exists doc :: Head(server, doc).Some? && Head(server, doc).value.id == rev
  }

  ghost predicate InHistory(server: Server, rev: RevId) {
    rev in server.revisions && rev !in server.purged
    && exists doc :: doc in server.history && rev in server.history[doc]
  }

  // The documents whose binding on `device` names the file at `path`
  // (under the device's F, PO-10).
  ghost predicate BoundTo(device: Device, doc: DocId, path: Path) {
    doc in device.journal.documents
    && device.journal.documents[doc].binding.Some?
    && SameF(device.platform, device.journal.documents[doc].binding.value.spelling, path)
  }

  ghost predicate Tracked(device: Device, path: Path) {
    exists doc :: BoundTo(device, doc, path)
  }

  ghost predicate HasUnsavedEdits(device: Device, path: Path) {
    exists editor :: editor in device.editors && editor.unsaved.Some?
      && SameF(device.platform, editor.path, path)
  }

  // A content is held somewhere on a device's disk.
  ghost predicate OnDisk(device: Device, content: Hash) {
    exists p :: p in device.disk && device.disk[p].content == content
  }

  // The newest server claim of a document as a device knows it (§4.2).
  ghost function NewestClaim(document: Document): Option<(Path, bool)> {
    if document.ahead.Some? then Some((document.ahead.value.revision.path, document.ahead.value.revision.deleted))
    else if document.base.Some? then Some((document.base.value.path, document.base.value.deleted))
    else None
  }

  // A device's disk is in step with its journal: every in-scope file is
  // bound to a document whose live base, and whose last-seen content, are
  // exactly the file's content, and whose base's path is the file's name with
  // folders compared under F (INV-9: a folder keeps the spelling the device
  // has, but a file's own name, its case included, is the server's); every
  // binding names a file on disk; and a
  // document the server has live but the device holds no file of is one it
  // reports it cannot hold. A user change the engine has not yet handled
  // (or not yet learned of) breaks this.
  ghost predicate InStep(device: Device) {
    (forall p :: p in device.disk && p !in device.outOfScope ==>
       exists doc :: BoundTo(device, doc, p)
         && device.journal.documents[doc].binding.value.seen == device.disk[p].content
         && device.journal.documents[doc].base.Some?
         && !device.journal.documents[doc].base.value.deleted
         && device.journal.documents[doc].base.value.content == device.disk[p].content
         && SameNameModuloFolders(device.platform, p, device.journal.documents[doc].base.value.path))
    && (forall doc :: doc in device.journal.documents && device.journal.documents[doc].binding.Some? ==>
          exists p :: p in device.disk && SameF(device.platform, p, device.journal.documents[doc].binding.value.spelling))
    && (forall doc :: (doc in device.journal.documents && device.journal.documents[doc].binding.None?
          && device.journal.documents[doc].base.Some? && !device.journal.documents[doc].base.value.deleted) ==>
          device.journal.documents[doc].ahead.Some? && CannotHold(device.journal.documents[doc].ahead.value.blocker))
  }

  // A device has finished syncing (quiescence, INV-9): it runs, has read the
  // whole feed, has no open intent, nothing to send, every revision not
  // applied is one it reports it cannot hold, and its disk is in step with
  // its journal.
  ghost predicate FinishedSyncing(state: State, d: DeviceId) {
    d in state.devices
    && var device := state.devices[d];
    device.running
    && device.journal.cursor == |state.server.feed|
    && |device.journal.intents| == 0
    && (forall doc :: doc in device.journal.documents ==>
         device.journal.documents[doc].outbox.None?
         && (device.journal.documents[doc].ahead.Some? ==> CannotHold(device.journal.documents[doc].ahead.value.blocker)))
    && InStep(device)
  }

  // The blockers that mean "this device cannot hold the file" (G9's
  // exceptions): a name its system does not allow, a file too large to
  // download, a settings file it chose not to sync.
  ghost predicate CannotHold(blocker: Blocker) {
    blocker.InvalidPath? || blocker.Unmaterializable? || blocker.TooLarge? || blocker.OutOfScope?
  }
}
