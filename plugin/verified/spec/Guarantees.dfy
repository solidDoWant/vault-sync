// The guarantees of docs/design/verified-core.md §1.1 as predicates over the
// model of Engine.dfy (#947). Each predicate quotes the English sentence it
// formalizes. A guarantee about one moment is a predicate on a State; one
// about what a single step may do is a predicate on a Step; one about the
// order of things is a predicate on a Trace (a connected run from the
// initial state). Changing a predicate's meaning needs the owner
// (verified-core.md §2.4).
include "Engine.dfy"

abstract module Guarantees refines EngineModel {

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  // The device whose disk and journal a step's effects act on.
  ghost function EventDevice(event: Event): Option<DeviceId> {
    match event
    case User(d, _) => Some(d)
    case Local(d, _) => Some(d)
    case Scan(d, _) => Some(d)
    case RemoteRevision(d, _) => Some(d)
    case Pushed(d, _) => Some(d)
    case Crash(d) => Some(d)
    case Restart(d) => Some(d)
    case SyncRound(d) => Some(d)
    case _ => None
  }

  // The line-level three-way merge of a note (SPEC.md §7): the combined
  // content, or None when the two changes touch the same lines. Abstract:
  // which edits combine is the merge's business, not the guarantees'.
  ghost function Merge3(base: Hash, local: Hash, remote: Hash): Option<Hash>


  // A conflict-copy name (SPEC.md §7, `<name> (conflict <device> <date>).<ext>`).
  ghost predicate IsCopyName(p: Path)

  // The file at `path` on a device, found under the device's F.
  ghost predicate HasFile(device: Device, path: Path) {
    exists q :: q in device.disk && SameF(device.platform, q, path)
  }
  ghost function FileAt(device: Device, path: Path): DiskFile
    requires HasFile(device, path)
  {
    var q :| q in device.disk && SameF(device.platform, q, path); device.disk[q]
  }

  // The file a document is bound to on a device, if it is on disk.
  ghost function BoundFile(device: Device, doc: DocId): Option<DiskFile> {
    if doc in device.journal.documents && device.journal.documents[doc].binding.Some?
       && HasFile(device, device.journal.documents[doc].binding.value.spelling)
    then Some(FileAt(device, device.journal.documents[doc].binding.value.spelling))
    else None
  }

  ghost predicate Running(state: State, d: DeviceId) {
    d in state.devices && state.devices[d].running
  }

  // ---------------------------------------------------------------------
  // G1. Nothing the server accepted is lost.
  // ---------------------------------------------------------------------

  // "Once the server has accepted a version of a file, that version can
  // always be got back: as the current file, in the file's history, or as a
  // conflict copy."
  //
  // A version can be got back if the server's history still has it (the
  // current file is the head of that history), or its bytes are the current
  // content of a live file on the server (a conflict copy is one), or a
  // device still holds its bytes in a file (a conflict copy not yet pushed,
  // or the writer's file after a restore from backup lost the version).
  ghost predicate Retrievable(state: State, rev: RevId)
    requires rev in state.server.accepted
  {
    var version := state.server.accepted[rev];
    InHistory(state.server, rev)
    || (!version.deleted
        && ((exists doc :: Head(state.server, doc).Some? && !Head(state.server, doc).value.deleted
                         && Head(state.server, doc).value.content == version.content)
            || (exists d :: d in state.devices && OnDisk(state.devices[d], version.content))))
  }

  // "Only the operator's history-retention policy ever removes old versions,
  // and never the latest one."
  ghost predicate G1_Retained(state: State) {
    forall rev :: rev in state.server.accepted ==>
      Retrievable(state, rev) || (rev in state.server.purged && !IsHead(state.server, rev))
  }

  ghost predicate G1_LatestNeverPurged(state: State) {
    forall doc :: Head(state.server, doc).Some? ==> Head(state.server, doc).value.id !in state.server.purged
  }

  // "Only the operator's history-retention policy ever removes old versions":
  // a version stops being retrievable only in a purge step that names it,
  // and only if it is not its file's latest version.
  ghost predicate G1_OnlyRetentionRemoves(step: Step) {
    forall rev :: (rev in step.pre.server.accepted && rev in step.post.server.accepted
      && Retrievable(step.pre, rev) && !Retrievable(step.post, rev)) ==>
        step.event.Purge? && rev in step.event.revisions && !IsHead(step.pre.server, rev)
  }

  ghost predicate G1(trace: Trace) {
    (forall i :: 0 <= i < |trace| ==>
       G1_Retained(trace[i].post) && G1_LatestNeverPurged(trace[i].post) && G1_OnlyRetentionRemoves(trace[i]))
  }

  // ---------------------------------------------------------------------
  // G2. Sync never destroys what you wrote on a device.
  // ---------------------------------------------------------------------

  // "The plugin only overwrites or deletes a file whose contents are exactly
  // what it last saw there."
  //
  // Every overwrite or delete the core requests names a file bound to the
  // document it acts for, conditional on the content the engine last read or
  // wrote there (`seen`). A write where no file is must be conditional on no
  // file being there.
  ghost predicate G2_OnlyWhatItSaw(step: Step) {
    var d := EventDevice(step.event);
    forall effect :: effect in step.effects ==>
      d.Some? && d.value in step.pre.devices &&
      var device := step.pre.devices[d.value];
      (effect.Write? && effect.precondition.Some? ==>
         effect.target.Some? && BoundTo(device, effect.target.value, effect.path)
         && effect.precondition.value == device.journal.documents[effect.target.value].binding.value.seen)
      && (effect.Remove? ==>
         BoundTo(device, effect.doc, effect.path)
         && effect.expected == device.journal.documents[effect.doc].binding.value.seen)
  }

  // The adapter performs a disk effect only if its precondition holds: a
  // step that is not the user's changes or removes a file only on the
  // event's device, and only where an effect's precondition matched the
  // file's content before the step (the effect's path names the file under
  // the device's F).
  ghost predicate G2_Conditional(step: Step) {
    !step.event.User? ==>
      forall d, p :: (d in step.pre.devices && p in step.pre.devices[d].disk
        && (d !in step.post.devices || p !in step.post.devices[d].disk
            || step.post.devices[d].disk[p] != step.pre.devices[d].disk[p])) ==>
          EventDevice(step.event) == Some(d) &&
          var platform := step.pre.devices[d].platform;
          var content := step.pre.devices[d].disk[p].content;
          exists effect :: effect in step.effects &&
            ((effect.Write? && SameF(platform, effect.path, p) && effect.precondition == Some(content))
             || (effect.Remove? && SameF(platform, effect.path, p) && effect.expected == content)
             || (effect.Move? && SameF(platform, effect.from, p) && effect.expected == content))
  }

  // "It never deletes a file it does not track: it moves it out of the way
  // instead."
  ghost predicate G2_NoUntrackedDelete(step: Step) {
    var d := EventDevice(step.event);
    forall effect :: effect in step.effects && effect.Remove? ==>
      d.Some? && d.value in step.pre.devices && Tracked(step.pre.devices[d.value], effect.path)
  }

  // "A file you are editing is never replaced underneath your unsaved
  // changes."
  ghost predicate G2_UnsavedSafe(step: Step) {
    var d := EventDevice(step.event);
    forall effect :: effect in step.effects && (effect.Write? || effect.Remove?) ==>
      d.Some? && d.value in step.pre.devices &&
      var device := step.pre.devices[d.value];
      !(effect.Write? && HasUnsavedEdits(device, effect.path))
      && !(effect.Remove? && HasUnsavedEdits(device, effect.path))
  }

  ghost predicate G2(trace: Trace) {
    forall i :: 0 <= i < |trace| ==>
      G2_OnlyWhatItSaw(trace[i]) && G2_Conditional(trace[i])
      && G2_NoUntrackedDelete(trace[i]) && G2_UnsavedSafe(trace[i])
  }

  // ---------------------------------------------------------------------
  // G3. A file is only deleted because someone deleted it.
  // ---------------------------------------------------------------------

  // A user deleted document `doc`'s file in step j: the user's own delete of
  // the file a binding names (on some device, app running or not).
  ghost predicate UserDeletedFileOf(step: Step, doc: DocId) {
    step.event.User? && step.event.action.DeleteFile?
    && step.event.device in step.pre.devices
    && BoundTo(step.pre.devices[step.event.device], doc, step.event.action.path)
  }

  // "Sync deletes a file on other devices only after a user deleted that file
  // on some device. A crash, a missed notification or a file sync itself
  // moved never counts as a delete."
  //
  // Every delete sync requests, and every tombstone the server accepts, is
  // preceded by a user's delete of that document's file. Only a User step
  // counts: a crash, a lost local event or an engine move is no such step.
  ghost predicate G3(trace: Trace) {
    forall i :: 0 <= i < |trace| ==>
      (forall effect :: effect in trace[i].effects && effect.Remove? ==>
         exists j :: 0 <= j < i && UserDeletedFileOf(trace[j], effect.doc))
      && (trace[i].event.Pushed? && trace[i].event.result.Accepted? && trace[i].event.result.revision.deleted ==>
         exists j :: 0 <= j < i && UserDeletedFileOf(trace[j], trace[i].event.result.doc))
  }

  // ---------------------------------------------------------------------
  // G4. A deleted file only comes back because someone wanted it.
  // ---------------------------------------------------------------------

  // Someone edited, renamed or re-created document `doc`'s file in step j, or
  // restored it from history. `deletedAt` is the path of its tombstone.
  ghost predicate WantedBack(step: Step, doc: DocId, deletedAt: Path) {
    (step.event.RestoreFromHistory? && step.event.doc == doc)
    || (step.event.User? && step.event.device in step.pre.devices &&
        var device := step.pre.devices[step.event.device];
        match step.event.action
        // An edit of the document's file, or a new file in its place.
        case WriteFile(p, _, _) => BoundTo(device, doc, p) || SameK(p, deletedAt)
        // A rename of the document's file, or of a file into its place.
        case RenameFile(from, to) => BoundTo(device, doc, from) || SameK(to, deletedAt)
        case _ => false)
  }

  // Device d's commit of `doc` was accepted in this step.
  ghost predicate CommittedBy(step: Step, d: DeviceId, doc: DocId) {
    step.event.Pushed? && step.event.device == d
    && step.event.result.Accepted? && step.event.result.doc == doc
  }

  // Step i commits a live revision of `doc` on top of a tombstone.
  ghost predicate Resurrects(step: Step) {
    step.event.Pushed? && step.event.result.Accepted? && !step.event.result.revision.deleted
    && Head(step.pre.server, step.event.result.doc).Some?
    && Head(step.pre.server, step.event.result.doc).value.deleted
  }

  // "A deleted file reappears only when someone edited it, renamed it,
  // created a new file in its place, or restored it from history. It never
  // comes back by itself."
  //
  // On the server: a live revision on top of a tombstone (accepted in step
  // k) needs such a cause in some step j before it. An edit or rename that
  // the server already had before the delete (its device committed it
  // between j and k) was overruled by the delete and does not count. On a
  // device: the engine creates a file for a document whose newest server
  // claim it knows is a tombstone only if, after the step, that claim is a
  // live revision.
  ghost predicate G4(trace: Trace) {
    forall i :: 0 <= i < |trace| ==>
      (Resurrects(trace[i]) ==>
         var doc := trace[i].event.result.doc;
         var tombstone := Head(trace[i].pre.server, doc).value;
         exists j, k :: 0 <= j < i && 0 <= k < i
           && trace[k].event.Pushed? && trace[k].event.result.Accepted?
           && trace[k].event.result.revision.id == tombstone.id
           && WantedBack(trace[j], doc, tombstone.path)
           && (k < j || trace[j].event.RestoreFromHistory?
               || !exists m :: j < m < k && CommittedBy(trace[m], trace[j].event.device, doc)))
      && (forall effect :: (effect in trace[i].effects && effect.Write? && effect.target.Some?
            && effect.precondition.None?) ==>
            var d := EventDevice(trace[i].event);
            d.Some? && d.value in trace[i].pre.devices && d.value in trace[i].post.devices &&
            var doc := effect.target.value;
            var before := trace[i].pre.devices[d.value].journal.documents;
            var after := trace[i].post.devices[d.value].journal.documents;
            (doc in before && NewestClaim(before[doc]).Some? && NewestClaim(before[doc]).value.1) ==>
              doc in after && NewestClaim(after[doc]).Some? && !NewestClaim(after[doc]).value.1)
  }

  // ---------------------------------------------------------------------
  // G5. A file stays the same file.
  // ---------------------------------------------------------------------

  // "Renaming or moving a file keeps it the same file, with its history."
  //
  // When the vault reports a rename of a file a document is bound to, the
  // same document (so the same history) is bound to the new name after it.
  ghost predicate G5_RenameKeepsDocument(step: Step) {
    step.event.Local? && step.event.local.Renamed? && step.event.device in step.pre.devices
    && step.event.device in step.post.devices ==>
      forall doc :: BoundTo(step.pre.devices[step.event.device], doc, step.event.local.from) ==>
        BoundTo(step.post.devices[step.event.device], doc, step.event.local.to)
  }

  // "Two different files are never mixed up or joined into one just because
  // they have the same name or the same contents."
  //
  // Joined: no two documents are ever bound to one file.
  ghost predicate G5_NeverJoined(state: State) {
    forall d, doc1, doc2 :: (d in state.devices && doc1 != doc2
      && doc1 in state.devices[d].journal.documents && doc2 in state.devices[d].journal.documents
      && state.devices[d].journal.documents[doc1].binding.Some?
      && state.devices[d].journal.documents[doc2].binding.Some?) ==>
        !SameF(state.devices[d].platform,
               state.devices[d].journal.documents[doc1].binding.value.spelling,
               state.devices[d].journal.documents[doc2].binding.value.spelling)
  }

  // Mixed up: a document's binding moves from one existing file to another
  // only by the user's rename (reported by the vault), by the engine's own
  // write or move of that document's file in the same step, or by the two
  // content matches the owner approved (verified-core.md §1.3): the start-up
  // scan's one-to-one match of a file moved while the app was closed, and
  // the adoption of a file whose bytes equal a remote create's.
  ghost predicate G5_NeverMixedUp(step: Step) {
    var d := EventDevice(step.event);
    d.Some? && d.value in step.pre.devices && d.value in step.post.devices ==>
      forall doc :: (BoundFile(step.pre.devices[d.value], doc).Some? && BoundFile(step.post.devices[d.value], doc).Some?
        && BoundFile(step.pre.devices[d.value], doc).value.identity != BoundFile(step.post.devices[d.value], doc).value.identity) ==>
          (step.event.Local? && step.event.local.Renamed?
           && BoundTo(step.pre.devices[d.value], doc, step.event.local.from))
          // The start-up scan: the file holds exactly what the document's
          // missing file held (decision 4).
          || (step.event.Scan?
              && BoundFile(step.post.devices[d.value], doc).value.content
                 == step.pre.devices[d.value].journal.documents[doc].binding.value.seen)
          // The engine wrote or moved this document's file there itself.
          || (exists effect :: effect in step.effects
                && ((effect.Write? && effect.target == Some(doc)
                     && SameF(step.post.devices[d.value].platform, effect.path,
                              step.post.devices[d.value].journal.documents[doc].binding.value.spelling))
                    || (effect.Move? && effect.mover == Some(doc)
                     && SameF(step.post.devices[d.value].platform, effect.to,
                              step.post.devices[d.value].journal.documents[doc].binding.value.spelling))))
          // Adoption: the file holds exactly the revision the step applied.
          || (step.post.devices[d.value].journal.documents[doc].base.Some?
              && (step.pre.devices[d.value].journal.documents[doc].base.None?
                  || step.pre.devices[d.value].journal.documents[doc].base.value.rev
                     != step.post.devices[d.value].journal.documents[doc].base.value.rev)
              && BoundFile(step.post.devices[d.value], doc).value.content
                 == step.post.devices[d.value].journal.documents[doc].base.value.content)
  }

  ghost predicate G5(trace: Trace) {
    forall i :: 0 <= i < |trace| ==>
      G5_RenameKeepsDocument(trace[i]) && G5_NeverJoined(trace[i].post) && G5_NeverMixedUp(trace[i])
  }

  // ---------------------------------------------------------------------
  // G6. Simultaneous changes keep both versions.
  // ---------------------------------------------------------------------

  // A document has a change on the device that the server has not got: its
  // file differs from its base, it was moved, it was deleted, or it has
  // something to send.
  ghost predicate LocalChange(device: Device, doc: DocId) {
    doc in device.journal.documents &&
    var document := device.journal.documents[doc];
    document.outbox.Some?
    || document.absence == UserDeleted
    || (document.binding.Some? && document.base.Some?
        && (document.binding.value.spelling != document.base.value.path
            || (BoundFile(device, doc).Some? && BoundFile(device, doc).value.content != document.base.value.content)))
  }

  // A step settles another device's revision R of `doc` against a local
  // change on device d (a change made at the same time, which the server
  // does not have): R becomes the document's base.
  ghost predicate SettlesConcurrent(step: Step, d: DeviceId, doc: DocId, remote: Revision) {
    d in step.pre.devices && d in step.post.devices
    // R is a revision the server accepted from another device.
    && remote.id in step.post.server.accepted && step.post.server.accepted[remote.id] == remote
    && remote.doc == doc && remote.device != d
    && LocalChange(step.pre.devices[d], doc)
    && doc in step.post.devices[d].journal.documents
    && step.post.devices[d].journal.documents[doc].base.Some?
    && step.post.devices[d].journal.documents[doc].base.value.rev == remote.id
    && (doc in step.pre.devices[d].journal.documents ==>
          step.pre.devices[d].journal.documents[doc].base.None?
          || step.pre.devices[d].journal.documents[doc].base.value.rev != remote.id)
  }

  // The content a document will have on the server after this device's sync:
  // its outgoing commit's, or its bound file's.
  ghost function Outgoing(device: Device, doc: DocId): Option<Hash> {
    if doc in device.journal.documents && device.journal.documents[doc].outbox.Some?
       && !device.journal.documents[doc].outbox.value.deleted
    then Some(device.journal.documents[doc].outbox.value.content)
    else if BoundFile(device, doc).Some? then Some(BoundFile(device, doc).value.content)
    else None
  }

  // An untracked file next to the document holds the content: a conflict copy.
  ghost predicate SavedNextToIt(device: Device, content: Hash) {
    exists p :: p in device.disk && device.disk[p].content == content && !Tracked(device, p)
  }

  // "When two devices change a file at the same time, edits to different
  // parts of a note are combined. Otherwise one version stays in place and
  // the other is saved next to it as a conflict copy. An edit or a rename
  // always beats a delete."
  ghost predicate G6_Settle(step: Step, d: DeviceId, doc: DocId, remote: Revision)
    requires SettlesConcurrent(step, d, doc, remote)
  {
    var before := step.pre.devices[d];
    var after := step.post.devices[d];
    var local := BoundFile(before, doc);
    var base := before.journal.documents[doc].base;
    // Both sides live: a side that left the content as it was takes the
    // other side's content; if both changed it, a note is combined when the
    // merge combines the edits, and otherwise one version stays in place and
    // the other is saved next to it.
    (local.Some? && !remote.deleted && base.Some? ==>
       var b := base.value.content;
       var l := local.value.content;
       var r := remote.content;
       if l == b then Outgoing(after, doc) == Some(r)
       else if r == b then Outgoing(after, doc) == Some(l)
       else if local.value.kind == Note && remote.kind == Note && Merge3(b, l, r).Some? then
         Outgoing(after, doc) == Merge3(b, l, r)
       else
         (Outgoing(after, doc) == Some(r) && SavedNextToIt(after, l))
         || (Outgoing(after, doc) == Some(l) && SavedNextToIt(after, r)))
    // A remote delete against a local edit or rename: the file stays.
    && (local.Some? && remote.deleted ==> Outgoing(after, doc).Some?)
    // A local delete against a remote edit or rename: the file comes back.
    && (before.journal.documents[doc].absence == UserDeleted && local.None? && !remote.deleted ==>
          Outgoing(after, doc) == Some(remote.content))
  }

  ghost predicate G6(trace: Trace) {
    forall i, d, doc, remote :: 0 <= i < |trace| && SettlesConcurrent(trace[i], d, doc, remote) ==>
      G6_Settle(trace[i], d, doc, remote)
  }

  // ---------------------------------------------------------------------
  // G7. One name, one file.
  // ---------------------------------------------------------------------

  // "No two files ever hold the same name, on a device or on the server."
  // A device: no two listed files collide under its F (a file and a folder
  // of the same name included, design §3.2). The server: no two live files
  // collide under K.
  ghost predicate G7_OneFilePerName(state: State) {
    (forall d, p, q :: d in state.devices && p in state.devices[d].disk && q in state.devices[d].disk && p != q ==>
       !CollideF(state.devices[d].platform, p, q))
    && (forall doc1, doc2 :: (doc1 != doc2 && Head(state.server, doc1).Some? && Head(state.server, doc2).Some?
          && !Head(state.server, doc1).value.deleted && !Head(state.server, doc2).value.deleted) ==>
            !CollideK(Head(state.server, doc1).value.path, Head(state.server, doc2).value.path))
  }

  // "When two files want one name, one keeps it and the other moves to a new
  // name with its contents intact."
  // A file the engine moves (its precondition held) arrives at its new name
  // with its content; the engine frees a name only by moving, never by
  // deleting (G2, G3).
  ghost predicate G7_MoveKeepsContents(step: Step) {
    var d := EventDevice(step.event);
    forall effect :: (effect in step.effects && effect.Move?
      && d.Some? && d.value in step.pre.devices
      && effect.from in step.pre.devices[d.value].disk
      && step.pre.devices[d.value].disk[effect.from].content == effect.expected) ==>
      d.value in step.post.devices &&
      effect.to in step.post.devices[d.value].disk
      && step.post.devices[d.value].disk[effect.to].content == effect.expected
  }

  ghost predicate G7(trace: Trace) {
    forall i :: 0 <= i < |trace| ==> G7_OneFilePerName(trace[i].post) && G7_MoveKeepsContents(trace[i])
  }

  // ---------------------------------------------------------------------
  // G8. A crash changes nothing.
  // ---------------------------------------------------------------------

  // "If the app crashes, is killed or loses power at any moment, it finishes
  // or undoes what it was doing when it starts again"
  ghost predicate G8_Recovers(step: Step) {
    step.event.Restart? && step.event.device in step.post.devices ==>
      |step.post.devices[step.event.device].journal.intents| == 0
  }

  // "Changes made while the app was closed are picked up when it starts."
  // After the start-up scan every binding names a listed file: a file moved
  // while the app was closed is followed (or its document counts as deleted
  // by the user), and every other file is untracked, so the next push sends
  // it.
  ghost predicate G8_PicksUpOfflineChanges(step: Step) {
    step.event.Scan? && step.event.device in step.post.devices ==>
      var device := step.post.devices[step.event.device];
      forall doc :: doc in device.journal.documents && device.journal.documents[doc].binding.Some? ==>
        HasFile(device, device.journal.documents[doc].binding.value.spelling)
  }

  // Two traces see the same outside world when they have the same events
  // once crashes and restarts are left out.
  ghost function WithoutCrashes(trace: Trace): seq<Event> {
    if |trace| == 0 then []
    else (if trace[0].event.Crash? || trace[0].event.Restart? then [] else [trace[0].event])
         + WithoutCrashes(trace[1..])
  }

  // Equal apart from the names and times of conflict copies: the same files
  // at every name that is not a copy name, the same contents at copy names,
  // on every device and on the server.
  ghost predicate EquivModuloCopyNames(a: State, b: State) {
    a.devices.Keys == b.devices.Keys
    && (forall d :: d in a.devices ==>
          (forall p :: !IsCopyName(p) ==> (p in a.devices[d].disk <==> p in b.devices[d].disk))
          && (forall p :: !IsCopyName(p) && p in a.devices[d].disk ==>
                a.devices[d].disk[p].content == b.devices[d].disk[p].content)
          && (set p | p in a.devices[d].disk && IsCopyName(p) :: a.devices[d].disk[p].content)
             == (set p | p in b.devices[d].disk && IsCopyName(p) :: b.devices[d].disk[p].content))
    && (set doc | doc in a.server.history && Head(a.server, doc).Some? && !Head(a.server, doc).value.deleted && !IsCopyName(Head(a.server, doc).value.path)
          :: (Head(a.server, doc).value.path, Head(a.server, doc).value.content))
       == (set doc | doc in b.server.history && Head(b.server, doc).Some? && !Head(b.server, doc).value.deleted && !IsCopyName(Head(b.server, doc).value.path)
          :: (Head(b.server, doc).value.path, Head(b.server, doc).value.content))
    && (set doc | doc in a.server.history && Head(a.server, doc).Some? && !Head(a.server, doc).value.deleted && IsCopyName(Head(a.server, doc).value.path)
          :: Head(a.server, doc).value.content)
       == (set doc | doc in b.server.history && Head(b.server, doc).Some? && !Head(b.server, doc).value.deleted && IsCopyName(Head(b.server, doc).value.path)
          :: Head(b.server, doc).value.content)
  }

  ghost predicate AllFinishedSyncing(state: State) {
    forall d :: d in state.devices ==> FinishedSyncing(state, d)
  }

  // "... and ends up as if it had not crashed (apart from the names and
  // times of conflict copies)."
  // A run with crashes and a run without them, from the same state and with
  // the same outside events, that both finish syncing end up equal apart
  // from conflict copies.
  ghost predicate G8_AsIfNoCrash(crashed: Trace, clean: Trace) {
    |crashed| > 0 && |clean| > 0
    && crashed[0].pre == clean[0].pre
    && WithoutCrashes(crashed) == WithoutCrashes(clean)
    && (forall i :: 0 <= i < |clean| ==> !clean[i].event.Crash? && !clean[i].event.Restart?)
    && AllFinishedSyncing(crashed[|crashed| - 1].post)
    && AllFinishedSyncing(clean[|clean| - 1].post) ==>
      EquivModuloCopyNames(crashed[|crashed| - 1].post, clean[|clean| - 1].post)
  }

  ghost predicate G8(trace: Trace) {
    forall i :: 0 <= i < |trace| ==> G8_Recovers(trace[i]) && G8_PicksUpOfflineChanges(trace[i])
  }

  // ---------------------------------------------------------------------
  // G9. Synced devices agree.
  // ---------------------------------------------------------------------

  // A device cannot hold the file `p`, keeps it on the server and reports it:
  // a document the server has live at `p` waits on this device for a reason
  // that means it cannot hold it.
  ghost predicate ReportedCannotHold(state: State, device: Device, p: Path) {
    exists doc :: doc in device.journal.documents
      && device.journal.documents[doc].ahead.Some?
      && CannotHold(device.journal.documents[doc].ahead.value.blocker)
      && SameK(device.journal.documents[doc].ahead.value.revision.path, p)
      && Head(state.server, doc).Some? && !Head(state.server, doc).value.deleted
      && SameK(Head(state.server, doc).value.path, p)
  }

  // "Two devices that have both finished syncing hold the same files, with
  // the same contents, under the same names. The exceptions are files a
  // device cannot hold (a name its system does not allow, a file too large
  // to download), which stay on the server and are reported on that device
  // instead of dropped; settings files a device has chosen not to sync; and
  // folder names that differ only in upper or lower case, where a device's
  // system treats them as one folder."
  ghost predicate G9(state: State) {
    forall d1, d2, p :: (FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
      && p in state.devices[d1].disk
      && p !in state.devices[d1].outOfScope && p !in state.devices[d2].outOfScope) ==>
        var one := state.devices[d1];
        var other := state.devices[d2];
        (exists q :: q in other.disk
           && (SameNameModuloFolders(one.platform, p, q) || SameNameModuloFolders(other.platform, p, q))
           && other.disk[q].content == one.disk[p].content)
        || ReportedCannotHold(state, other, p)
  }

  // ---------------------------------------------------------------------
  // G10. Sync always finishes.
  // ---------------------------------------------------------------------

  // A conflict on a device that sync has not settled: a remote revision held
  // back by local changes or by another document's file.
  ghost predicate Unsettled(device: Device, doc: DocId) {
    doc in device.journal.documents
    && device.journal.documents[doc].ahead.Some?
    && (device.journal.documents[doc].ahead.value.blocker.LocalChanges?
        || device.journal.documents[doc].ahead.value.blocker.PathHeld?)
  }

  // "Every conflict is settled within one sync, unless a user has to act on
  // it, which the plugin then reports."
  ghost predicate G10_SettledOrReported(step: Step) {
    step.event.SyncRound? && step.event.device in step.post.devices ==>
      forall doc :: Unsettled(step.post.devices[step.event.device], doc) ==>
        exists effect :: effect in step.effects && effect.Report? && effect.subject == Some(doc)
  }

  // "Sync never loops or stalls forever."
  // A sync round is one step, so it ends; and a second round right after
  // the first, with nothing happening in between, has nothing left to do on
  // disk or on the server.
  ghost predicate G10_NoLoop(first: Step, second: Step) {
    first.event.SyncRound? && second.event == first.event && second.pre == first.post ==>
      forall effect :: effect in second.effects ==> !IsDiskEffect(effect) && !effect.Commit?
  }

  ghost predicate G10(trace: Trace) {
    (forall i :: 0 <= i < |trace| ==> G10_SettledOrReported(trace[i]))
    && (forall i :: 0 < i < |trace| ==> G10_NoLoop(trace[i - 1], trace[i]))
  }

  // ---------------------------------------------------------------------
  // All of them
  // ---------------------------------------------------------------------

  // The guarantees that are properties of a single state.
  ghost predicate StateInvariants(state: State) {
    G1_Retained(state) && G1_LatestNeverPurged(state)
    && G5_NeverJoined(state) && G7_OneFilePerName(state) && G9(state)
  }

  // The guarantees of a run. G8_AsIfNoCrash relates two runs and is stated
  // on its own.
  ghost predicate TraceGuarantees(trace: Trace) {
    G1(trace) && G2(trace) && G3(trace) && G4(trace) && G5(trace)
    && G6(trace) && G7(trace) && G8(trace) && G10(trace)
    && forall i :: 0 <= i < |trace| ==> G9(trace[i].post)
  }

  // ---------------------------------------------------------------------
  // The initial state
  // ---------------------------------------------------------------------

  // Every device runs, with an empty vault and journal; the server is empty.
  ghost function Initial(platforms: map<DeviceId, Platform>): State {
    State(
      map d | d in platforms :: Device(platforms[d], true, Journal(map[], 0, [], []), map[], {}, {}),
      Server(map[], map[], [], {}, map[]))
  }

  lemma InitialSatisfiesInvariants(platforms: map<DeviceId, Platform>)
    ensures StateInvariants(Initial(platforms))
  {
    var s := Initial(platforms);
    forall doc ensures Head(s.server, doc).None? {}
  }

  lemma EmptyTraceSatisfiesGuarantees()
    ensures TraceGuarantees([])
  {}

  // A run starts in the initial state and each step starts where the
  // previous one ended.
  ghost predicate Run(platforms: map<DeviceId, Platform>, trace: Trace) {
    Connected(trace) && (|trace| > 0 ==> trace[0].pre == Initial(platforms))
  }
}
