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
    | RemoteRevision(device: DeviceId, revision: Revision)
    | Pushed(device: DeviceId, result: PushResult)
    // A server restore from backup; the server's revisions after it.
    | Restore(restored: Server)
    // A retention purge of non-head revisions (SPEC.md §11).
    | Purge(revisions: set<RevId>)
    // A user restores a document's earlier revision from history (SPEC.md
    // §11), which commits it as a new revision.
    | RestoreFromHistory(doc: DocId, from: RevId, revision: Revision)
    | Crash(device: DeviceId)
    | Restart(device: DeviceId)
    // One sync round (a pull, then a push) the engine runs on its own.
    | SyncRound(device: DeviceId)

  ghost predicate IsUserAction(event: Event) { event.User? }

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
  // exactly the file's content; every binding names a file on disk; and a
  // document the server has live but the device holds no file of is one it
  // reports it cannot hold. A user change the engine has not yet handled
  // (or not yet learned of) breaks this.
  ghost predicate InStep(device: Device) {
    (forall p :: p in device.disk && p !in device.outOfScope ==>
       exists doc :: BoundTo(device, doc, p)
         && device.journal.documents[doc].binding.value.seen == device.disk[p].content
         && device.journal.documents[doc].base.Some?
         && !device.journal.documents[doc].base.value.deleted
         && device.journal.documents[doc].base.value.content == device.disk[p].content)
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
