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

  // The line-level three-way merge of a note (SPEC.md §7): the combined
  // content, or None when the two changes touch the same lines. Abstract:
  // which edits combine is the merge's business, not the guarantees'.
  ghost function Merge3(base: Hash, local: Hash, remote: Hash): Option<Hash>


  // A conflict-copy name (SPEC.md §7, `<name> (conflict <device> <date>).<ext>`).
  ghost predicate IsCopyName(p: Path)

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
  // Versions are compared by content: a file anywhere that holds exactly the
  // version's bytes gives the version back, whatever its name, so any such
  // file counts, not only one with a conflict-copy name.
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
  // a version stops being retrievable only
  // - in a purge step that names it, if it is not its file's latest version;
  // - if retention already purged it (its bytes were only coincidentally
  //   elsewhere as well);
  // - in a restore from backup that removed it from the server's history
  //   (SPEC.md §13, restore runs: only the server's own history of the
  //   revisions the restore removed is excused). A restore changes no
  //   device's disk (G2_Conditional), so every engine still holds what it
  //   held, and pushes it again (G9, G10);
  // - in the user's own step, which deletes or overwrites a device's copy of
  //   bytes the server no longer has (a write the user replaced themselves).
  //   A user step never changes the server.
  ghost predicate G1_OnlyRetentionRemoves(step: Step) {
    forall rev :: (rev in step.pre.server.accepted && rev in step.post.server.accepted
      && Retrievable(step.pre, rev) && !Retrievable(step.post, rev)) ==>
        (step.event.Purge? && rev in step.event.revisions && !IsHead(step.pre.server, rev))
        || rev in step.pre.server.purged
        || (step.event.Restore? && !InHistory(step.post.server, rev))
        || (step.event.User? && step.post.server == step.pre.server)
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
  // wrote there: `seen`, or, in a sync round, the content the round read
  // there (`LastSaw`). A write where no file is must be conditional on no
  // file being there.
  ghost predicate G2_OnlyWhatItSaw(step: Step) {
    var d := EventDevice(step.event);
    forall effect :: effect in step.effects ==>
      d.Some? && d.value in step.pre.devices &&
      var device := step.pre.devices[d.value];
      (effect.Write? && effect.precondition.Some? ==>
         effect.target.Some? && BoundTo(device, effect.target.value, effect.path)
         && LastSaw(step, device, effect.target.value, effect.path, effect.precondition.value))
      && (effect.Remove? ==>
         BoundTo(device, effect.doc, effect.path)
         && LastSaw(step, device, effect.doc, effect.path, effect.expected))
  }

  // What the core last saw at the bound file `path` of `doc` is `content`:
  // the binding's `seen`, or, in a sync round, the round's read of the file
  // (its listing, verified-core.md §2.3), which is newer than `seen`. The
  // round's read counts only where the step keeps what it read (`ReadKept`):
  // an overwrite of a user's change the core read but did not keep would
  // destroy what the user wrote.
  ghost predicate LastSaw(step: Step, device: Device, doc: DocId, path: Path, content: Hash)
    requires BoundTo(device, doc, path)
  {
    content == device.journal.documents[doc].binding.value.seen
    || (step.event.SyncRound? && step.event.device in step.pre.devices
        && RoundRead(step, path).Some? && RoundRead(step, path).value.0 == content
        && ReadKept(step, doc, content))
  }

  // A sync round keeps the content it read in doc's file: after the step it
  // is what the document will have on the server (`Outgoing`), or it is in
  // an untracked file on the device, or the step settles another device's
  // live note revision of doc against it and the document sends their merge
  // (G6's combined edits). Settling a remote delete keeps the read content
  // only by the first two: an edit beats a delete with the edit itself.
  ghost predicate ReadKept(step: Step, doc: DocId, content: Hash)
    requires step.event.SyncRound?
  {
    var d := step.event.device;
    d in step.post.devices
    && (Outgoing(step.post.devices[d], doc) == Some(content)
        || SavedNextToIt(step.post.devices[d], content)
        || exists remote :: MergedRead(step, d, doc, content, remote))
  }

  // The step settles `remote`, a live note revision of doc, against the
  // content the round read in doc's file, a note too (G6 merges only two
  // notes), and the document sends the merge of the two over its base.
  ghost predicate MergedRead(step: Step, d: DeviceId, doc: DocId, content: Hash, remote: Revision) {
    SettlesConcurrent(step, d, doc, remote)
    && !remote.deleted && remote.kind == Note
    && step.event.SyncRound? && step.event.device == d
    && step.pre.devices[d].journal.documents[doc].binding.Some?
    && RoundRead(step, step.pre.devices[d].journal.documents[doc].binding.value.spelling) == Some((content, Note))
    && step.pre.devices[d].journal.documents[doc].base.Some?
    && var merged := Merge3(step.pre.devices[d].journal.documents[doc].base.value.content, content, remote.content);
    merged.Some? && Outgoing(step.post.devices[d], doc) == merged
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
  // the file a binding names (on some device, app running or not), or the
  // user's rename of it away from that name. A rename made while the app is
  // closed, or in the crash window before the engine learned of it, without a
  // unique content match is a delete plus a new file (verified-core.md §1.3,
  // owner decision 4; SPEC.md §13 `phantom-delete`, #167 item 2).
  ghost predicate UserRemovedFileOf(step: Step, doc: DocId) {
    step.event.User? && step.event.device in step.pre.devices
    && var device := step.pre.devices[step.event.device];
    ((step.event.action.DeleteFile? && BoundTo(device, doc, step.event.action.path))
     || (step.event.action.RenameFile? && BoundTo(device, doc, step.event.action.from)
         && !SameF(device.platform, step.event.action.from, step.event.action.to)))
  }

  // Document `doc` started a new life in this step: the server accepted a
  // live revision of it, or a user restored it from history.
  ghost predicate LiveAgain(step: Step, doc: DocId) {
    (step.event.Pushed? && step.event.result.Accepted? && step.event.result.doc == doc
     && !step.event.result.revision.deleted)
    || (step.event.RestoreFromHistory? && step.event.doc == doc)
  }

  // The tombstone of `doc` accepted in step k follows a user's removal of
  // the document's file in its current life: no live revision of it was
  // accepted, and no restore from history happened, between the two.
  ghost predicate JustifiedTombstone(trace: Trace, k: int, doc: DocId)
    requires 0 <= k < |trace|
  {
    exists j :: 0 <= j < k && UserRemovedFileOf(trace[j], doc)
      && !exists m :: j < m < k && LiveAgain(trace[m], doc)
  }

  ghost predicate AcceptsTombstone(step: Step, doc: DocId, rev: RevId) {
    step.event.Pushed? && step.event.result.Accepted? && step.event.result.doc == doc
    && step.event.result.revision.deleted && step.event.result.revision.id == rev
  }

  // A step records a user's delete of document `doc`: the document was
  // bound before, and after the step it has no binding and counts as deleted
  // by the user.
  ghost predicate RecordsUserDelete(step: Step, d: DeviceId, doc: DocId) {
    d in step.pre.devices && d in step.post.devices
    && doc in step.pre.devices[d].journal.documents
    && step.pre.devices[d].journal.documents[doc].binding.Some?
    && doc in step.post.devices[d].journal.documents
    && step.post.devices[d].journal.documents[doc].binding.None?
    && step.post.devices[d].journal.documents[doc].absence == UserDeleted
  }

  // "A file is only deleted because someone deleted it ... a missed
  // notification ... never counts as a delete", for what the engine records:
  // a step that is not the user's records a user's delete of a document only
  // when its file is gone from its name (no file is there under F before the
  // step), or the vault reported another file renamed onto that name (the
  // user replaced it). A file still at its name was not deleted, whatever
  // event arrived (verified-core.md §2.4).
  ghost predicate G3_DeleteSeen(step: Step) {
    !step.event.User? ==>
      forall d, doc :: RecordsUserDelete(step, d, doc) ==>
        var device := step.pre.devices[d];
        var spelling := device.journal.documents[doc].binding.value.spelling;
        !HasFile(device, spelling)
        || (step.event.Local? && step.event.device == d && step.event.local.Renamed?
            && SameF(device.platform, step.event.local.to, spelling))
  }

  // "Sync deletes a file on other devices only after a user deleted that file
  // on some device. A crash, a missed notification or a file sync itself
  // moved never counts as a delete."
  //
  // Every tombstone the server accepts follows a user's removal of that
  // document's file in its current life (JustifiedTombstone). Every delete
  // sync requests on a device applies such a tombstone: after the step, the
  // document's newest claim on the device, or an open apply intent of it,
  // is that tombstone. Only a User step counts: a crash, a lost local event
  // or an engine move is no such step, and a delete from an earlier life of
  // the document (before a restore or a re-create) does not count.
  ghost predicate G3(trace: Trace) {
    forall i :: 0 <= i < |trace| ==>
      G3_DeleteSeen(trace[i])
      && (forall doc, rev :: AcceptsTombstone(trace[i], doc, rev) ==> JustifiedTombstone(trace, i, doc))
      && (forall effect :: effect in trace[i].effects && effect.Remove? ==>
            var d := EventDevice(trace[i].event);
            d.Some? && d.value in trace[i].post.devices &&
            var journal := trace[i].post.devices[d.value].journal;
            exists k, rev :: 0 <= k < i && AcceptsTombstone(trace[k], effect.doc, rev)
              && JustifiedTombstone(trace, k, effect.doc)
              && ((effect.doc in journal.documents
                   && ((journal.documents[effect.doc].ahead.Some? && journal.documents[effect.doc].ahead.value.revision.id == rev)
                       || (journal.documents[effect.doc].ahead.None? && journal.documents[effect.doc].base.Some?
                           && journal.documents[effect.doc].base.value.rev == rev)))
                  || (exists intent :: intent in journal.intents && intent.kind.ApplyIntent?
                        && intent.kind.doc == effect.doc && intent.kind.revision.id == rev)))
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
  // after j, up to and including k, which covers the device whose own
  // tombstone overruled its edit) was overruled by the delete and does not
  // count. On a
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
               || !exists m :: j < m <= k && CommittedBy(trace[m], trace[j].event.device, doc)))
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

  // The identity of the file a document is bound to on a device, if the file
  // is there.
  ghost function BoundIdentity(device: Device, doc: DocId): Option<FileIdentity> {
    if BoundFile(device, doc).Some? then Some(BoundFile(device, doc).value.identity) else None
  }

  ghost predicate Untracked(device: Device, p: Path) {
    HasFile(device, p) && !Tracked(device, p)
  }

  // The document's binding names a file that is not on disk.
  ghost predicate FileMissing(device: Device, doc: DocId) {
    doc in device.journal.documents && device.journal.documents[doc].binding.Some?
    && !HasFile(device, device.journal.documents[doc].binding.value.spelling)
  }

  // Mixed up or joined: whenever a document becomes bound to a file it was
  // not bound to before (coming from another file, from a missing file, or
  // from no binding at all), the step is one of these, and nothing else:
  //  (a) the user's rename of the document's file onto that name, reported
  //      by the vault (E1);
  //  (b) the engine's own write or move of that document's file to that
  //      name in this step;
  //  (c) the start-up scan's match of a file moved while the app was closed
  //      (verified-core.md §1.3, owner decision 4): the document's file was
  //      missing, the new file holds exactly what the engine last saw in it,
  //      and the match is one-to-one: no other file untracked before the
  //      step holds that content, and no other document whose file is
  //      missing last saw it;
  //  (d) adoption (design §4.5 step 3): the document had no file, the file
  //      was untracked, and the step applied a revision whose content is
  //      exactly the file's;
  //  (e) a new document for an untracked file (its first push): the journal
  //      did not know the document, the file was untracked, and the
  //      document has no server revision after the step (a remote create
  //      binds an existing file only by adoption, (d));
  //  (f) tombstone re-creation (verified-core.md §1.3, decision #17): the
  //      document had no file, its newest claim was a tombstone whose path
  //      is the file's name under K, and the file was untracked;
  //  (g) the user's own step, which changed the disk under a binding the
  //      step left as it was (a write at a bound name, or a rename onto
  //      it): the user, not sync, put another file there, and the engine
  //      learns of it from the vault's report or the start-up scan.
  // In (c), (d) and (f) contents or names decide, and only these
  // owner-approved rules let them.
  ghost predicate G5_NeverMixedUp(step: Step) {
    var d := EventDevice(step.event);
    d.Some? && d.value in step.pre.devices && d.value in step.post.devices ==>
      var before := step.pre.devices[d.value];
      var after := step.post.devices[d.value];
      forall doc :: (BoundIdentity(after, doc).Some? && BoundIdentity(after, doc) != BoundIdentity(before, doc)) ==>
        var spelling := after.journal.documents[doc].binding.value.spelling;
        var file := BoundFile(after, doc).value;
        var known := doc in before.journal.documents;
        var hadFile := known && BoundFile(before, doc).Some?;
        // (a)
        (step.event.Local? && step.event.local.Renamed?
         && BoundTo(before, doc, step.event.local.from) && SameF(after.platform, step.event.local.to, spelling))
        // (b)
        || (exists effect :: effect in step.effects
              && ((effect.Write? && effect.target == Some(doc) && SameF(after.platform, effect.path, spelling))
                  || (effect.Move? && effect.mover == Some(doc) && SameF(after.platform, effect.to, spelling))))
        // (c)
        || (step.event.Scan? && FileMissing(before, doc)
            && file.content == before.journal.documents[doc].binding.value.seen
            && (forall q :: (q in before.disk && Untracked(before, q)
                  && before.disk[q].content == file.content) ==> SameF(after.platform, q, spelling))
            && (forall other :: other != doc && FileMissing(before, other) ==>
                  before.journal.documents[other].binding.value.seen != file.content))
        // (d)
        || (!hadFile && Untracked(before, spelling)
            && after.journal.documents[doc].base.Some?
            && (!known || before.journal.documents[doc].base.None?
                || before.journal.documents[doc].base.value.rev != after.journal.documents[doc].base.value.rev)
            && file.content == after.journal.documents[doc].base.value.content)
        // (e)
        || (!known && Untracked(before, spelling) && after.journal.documents[doc].base.None?)
        // (f)
        || (!hadFile && known && Untracked(before, spelling)
            && NewestClaim(before.journal.documents[doc]).Some?
            && NewestClaim(before.journal.documents[doc]).value.1
            && SameK(NewestClaim(before.journal.documents[doc]).value.0, spelling))
        // (g)
        || (step.event.User? && known && before.journal.documents[doc].binding == after.journal.documents[doc].binding)
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

  // A commit in flight that another device's revision overtook: the outbox
  // is sealed on a parent that is no longer the document's base, because a
  // revision the server accepted after that parent became the base. The
  // server answers it "head moved" (a commit is accepted only on the head,
  // SPEC.md §6.2), so it is not what the document will have on the server.
  ghost predicate Superseded(document: Document) {
    document.outbox.Some? && document.outbox.value.sealed
    && document.outbox.value.baseRev != (if document.base.Some? then Some(document.base.value.rev) else None)
  }

  // The content a document will have on the server after this device's sync:
  // its outgoing commit's, unless that is a superseded commit in flight, or
  // its bound file's.
  ghost function Outgoing(device: Device, doc: DocId): Option<Hash> {
    if doc in device.journal.documents && device.journal.documents[doc].outbox.Some?
       && !device.journal.documents[doc].outbox.value.deleted
       && !Superseded(device.journal.documents[doc])
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
  //
  // Approximation: "stays in place" is read as "is the content the document
  // keeps" (Outgoing: content only, not its path; the path merge is not a
  // guarantee), and "saved next to it" as "is in an untracked file on the
  // device" (SavedNextToIt: any name, which the next push sends as a new
  // document). The copy's name is SPEC.md §7's business (§1.3).
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
      && HasFile(step.pre.devices[d.value], effect.from)
      && FileAt(step.pre.devices[d.value], effect.from).content == effect.expected) ==>
      d.value in step.post.devices &&
      HasFile(step.post.devices[d.value], effect.to)
      && FileAt(step.post.devices[d.value], effect.to).content == effect.expected
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

  // A file is as the server has it: bound to a document whose live base
  // holds exactly its content.
  ghost predicate AsServerHas(device: Device, p: Path) {
    p in device.disk
    && (exists doc :: BoundTo(device, doc, p)
          && device.journal.documents[doc].base.Some?
          && !device.journal.documents[doc].base.value.deleted
          && device.journal.documents[doc].base.value.content == device.disk[p].content)
  }

  // The next push sends this file: it is untracked (a new document), or its
  // document has a local change (LocalChange: it differs from the base, was
  // moved, or has an outgoing commit).
  ghost predicate PendingPush(device: Device, p: Path) {
    Untracked(device, p) || exists doc :: BoundTo(device, doc, p) && LocalChange(device, doc)
  }

  // "Changes made while the app was closed are picked up when it starts."
  // After the start-up scan:
  // - every in-scope file is either as the server has it, or recorded as a
  //   change the next push sends (an offline edit, a moved file, a new file);
  // - every binding names a listed file;
  // - a document whose file went missing and is not matched to another file
  //   counts as deleted by the user, so the delete is sent.
  ghost predicate G8_PicksUpOfflineChanges(step: Step) {
    step.event.Scan? && step.event.device in step.pre.devices && step.event.device in step.post.devices ==>
      var before := step.pre.devices[step.event.device];
      var device := step.post.devices[step.event.device];
      (forall p :: p in device.disk && p !in device.outOfScope ==> AsServerHas(device, p) || PendingPush(device, p))
      && (forall doc :: doc in device.journal.documents && device.journal.documents[doc].binding.Some? ==>
            HasFile(device, device.journal.documents[doc].binding.value.spelling))
      && (forall doc :: (FileMissing(before, doc) && doc in device.journal.documents
            && device.journal.documents[doc].binding.None?) ==>
            device.journal.documents[doc].absence == UserDeleted)
  }

  // The outside world of a run: what users and the operator do. Everything
  // else (local file events, the scan, sync rounds, pulled revisions, push
  // results) is the engine's own doing or its reaction to these, and may
  // differ between a run with crashes and one without.
  ghost predicate Outside(event: Event) {
    event.User? || event.Restore? || event.Purge? || event.RestoreFromHistory?
  }

  ghost function OutsideWorld(trace: Trace): seq<Event> {
    if |trace| == 0 then []
    else (if Outside(trace[0].event) then [trace[0].event] else []) + OutsideWorld(trace[1..])
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
  // the same outside world (the same user, restore, purge and
  // restore-from-history events, in the same order), that both finish
  // syncing end up equal apart from conflict copies.
  ghost predicate G8_AsIfNoCrash(crashed: Trace, clean: Trace) {
    |crashed| > 0 && |clean| > 0
    && crashed[0].pre == clean[0].pre
    && OutsideWorld(crashed) == OutsideWorld(clean)
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

  // A file `p` on device `one` agrees with device `other`: `other` holds a
  // file with its content under the same name, folders compared on either
  // device's system; or `other` reports that it cannot hold `p`; or the two
  // agree through the server (#995): `p` is a live head's path, folders
  // compared on `one`'s system, with the head's content, and `other` holds
  // that head under its path, folders compared on `other`'s system, or the
  // head's path is out of `other`'s scope, or `other` reports that it cannot
  // hold it. The last clause is what each device keeping its own folder
  // spelling (INV-9) gives: each device's spelling and the server's are one
  // folder on that device's system, which does not make the two devices'
  // spellings one folder on either system.
  ghost predicate G9Agrees(state: State, one: Device, other: Device, p: Path)
    requires p in one.disk
  {
    (exists q :: q in other.disk
       && (SameNameModuloFolders(one.platform, p, q) || SameNameModuloFolders(other.platform, p, q))
       && other.disk[q].content == one.disk[p].content)
    || ReportedCannotHold(state, other, p)
    || (exists doc :: Head(state.server, doc).Some? && !Head(state.server, doc).value.deleted
          && SameNameModuloFolders(one.platform, p, Head(state.server, doc).value.path)
          && Head(state.server, doc).value.content == one.disk[p].content
          && ((exists q :: q in other.disk
                 && SameNameModuloFolders(other.platform, q, Head(state.server, doc).value.path)
                 && other.disk[q].content == one.disk[p].content)
              || Head(state.server, doc).value.path in other.outOfScope
              || ReportedCannotHold(state, other, Head(state.server, doc).value.path)))
  }

  // "Two devices that have both finished syncing hold the same files, with
  // the same contents, under the same names. The exceptions are files a
  // device cannot hold (a name its system does not allow, a file too large
  // to download), which stay on the server and are reported on that device
  // instead of dropped; settings files a device has chosen not to sync; and
  // folder names that differ only in upper or lower case, where a device's
  // system treats them as one folder, or where each device's system treats
  // its own spelling of the folder and the server's as one folder."
  ghost predicate G9(state: State) {
    forall d1, d2, p :: (FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
      && p in state.devices[d1].disk
      && p !in state.devices[d1].outOfScope && p !in state.devices[d2].outOfScope) ==>
        G9Agrees(state, state.devices[d1], state.devices[d2], p)
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

  // A user has to act on a document before sync can settle it: its file has
  // text not yet saved in an open editor (G2_UnsavedSafe keeps sync from
  // replacing it), or the server refused its commit as invalid (SPEC.md
  // §6.2: it stays, reported as rejected, until the user changes it).
  ghost predicate UserMustAct(device: Device, doc: DocId) {
    doc in device.journal.documents
    && ((device.journal.documents[doc].binding.Some?
         && HasUnsavedEdits(device, device.journal.documents[doc].binding.value.spelling))
        || (device.journal.documents[doc].outbox.Some? && device.journal.documents[doc].outbox.value.rejected))
  }

  // "Every conflict is settled within one sync, unless a user has to act on
  // it, which the plugin then reports."
  // After a sync round, a conflict left unsettled, and a commit left
  // rejected, is one a user has to act on, and the round reports it.
  ghost predicate G10_SettledOrReported(step: Step) {
    step.event.SyncRound? && step.event.device in step.post.devices ==>
      var device := step.post.devices[step.event.device];
      forall doc :: (Unsettled(device, doc)
                     || (doc in device.journal.documents && device.journal.documents[doc].outbox.Some?
                         && device.journal.documents[doc].outbox.value.rejected)) ==>
        UserMustAct(device, doc)
        && exists effect :: effect in step.effects && effect.Report? && effect.subject == Some(doc)
  }

  // "Sync never loops or stalls forever."
  // A sync round is one step, so it ends; and a second round right after
  // the first, with nothing happening in between, has nothing left to do on
  // disk or on the server.
  ghost predicate G10_NoLoop(first: Step, second: Step) {
    first.event.SyncRound? && second.event == first.event && second.pre == first.post ==>
      forall effect :: effect in second.effects ==> !IsDiskEffect(effect) && !effect.Commit?
  }

  // Steps [from, to) are quiet for device d: only answers to d's own
  // commits (none of them "server unavailable") and remote revisions
  // delivered to d.
  ghost predicate QuietFor(trace: Trace, d: DeviceId, from: int, to: int)
    requires 0 <= from && to <= |trace|
  {
    forall m :: from <= m < to ==>
      (trace[m].event.Pushed? && trace[m].event.device == d && !trace[m].event.result.Unavailable?)
      || (trace[m].event.RemoteRevision? && trace[m].event.device == d)
  }

  ghost predicate UserTouches(action: UserAction, platform: Platform, p: Path) {
    match action
    case WriteFile(q, _, _) => SameF(platform, q, p)
    case DeleteFile(q) => SameF(platform, q, p)
    case RenameFile(from, to) => SameF(platform, from, p) || SameF(platform, to, p)
    case EditBuffer(q, _) => SameF(platform, q, p)
  }

  ghost predicate EventTells(local: LocalEvent, platform: Platform, p: Path) {
    match local
    case Created(q) => SameF(platform, q, p)
    case Modified(q) => SameF(platform, q, p)
    case Deleted(q) => SameF(platform, q, p)
    case Renamed(from, to) => SameF(platform, from, p) || SameF(platform, to, p)
  }

  // The engine on device d has not been told, by step n, of the user's last
  // change at `p`: the user changed `p` in some step m <= n, and no local
  // event about `p` and no start-up scan reached the engine after it. Local
  // events lag the disk (design §4.3), so such a file is not yet the
  // engine's to settle.
  ghost predicate Unnoticed(trace: Trace, d: DeviceId, n: int, platform: Platform, p: Path)
    requires 0 <= n < |trace|
  {
    exists m :: 0 <= m <= n && trace[m].event.User? && trace[m].event.device == d
      && UserTouches(trace[m].event.action, platform, p)
      && !exists m2 :: m < m2 <= n
           && ((trace[m2].event.Local? && trace[m2].event.device == d
                && EventTells(trace[m2].event.local, platform, p))
               || (trace[m2].event.Scan? && trace[m2].event.device == d))
  }

  // Device d has finished syncing apart from what a user has to act on and
  // what it has not been told of: it has read the whole feed, has no open
  // intent, and every document and in-scope file is as the server has it,
  // except documents it cannot hold (G9), those a user has to act on
  // (reported, G10_SettledOrReported), and files in `unnoticed`.
  ghost predicate SettledExceptReported(state: State, d: DeviceId, unnoticed: iset<Path>) {
    d in state.devices
    && var device := state.devices[d];
    device.running
    && device.journal.cursor == |state.server.feed|
    && |device.journal.intents| == 0
    && (forall doc :: doc in device.journal.documents ==>
          (device.journal.documents[doc].outbox.None? || UserMustAct(device, doc))
          && (device.journal.documents[doc].ahead.Some? ==>
                CannotHold(device.journal.documents[doc].ahead.value.blocker) || UserMustAct(device, doc)))
    && (forall p :: (p in device.disk && p !in device.outOfScope && p !in unnoticed) ==>
          AsServerHas(device, p) || exists doc :: BoundTo(device, doc, p) && UserMustAct(device, doc))
  }

  // "Sync never ... stalls forever", as a safety property: two sync rounds
  // of a device with nothing in between but answers to its own commits (none
  // of them "unavailable") and revisions delivered to it, and nothing else
  // after them, leave the device finished apart from what a user has to act
  // on and the user changes it has not been told of yet. A core that never
  // commits, or never applies what it pulled, breaks this. Each round's
  // pull is part of its step (`SyncRound`, Engine.dfy), so the second round
  // has pulled everything the server had when it started.
  ghost predicate G10_NeverStalls(trace: Trace) {
    forall d, i, i2, n :: (0 <= i < i2 <= n < |trace|
      && trace[i].event == SyncRound(d) && trace[i2].event == SyncRound(d)
      && QuietFor(trace, d, i + 1, i2) && QuietFor(trace, d, i2 + 1, n + 1)
      && (n + 1 == |trace| || !QuietFor(trace, d, n + 1, n + 2))
      && d in trace[n].post.devices) ==>
        var platform := trace[n].post.devices[d].platform;
        SettledExceptReported(trace[n].post, d, iset p | Unnoticed(trace, d, n, platform, p))
  }

  ghost predicate G10(trace: Trace) {
    (forall i :: 0 <= i < |trace| ==> G10_SettledOrReported(trace[i]))
    && (forall i :: 0 < i < |trace| ==> G10_NoLoop(trace[i - 1], trace[i]))
    && G10_NeverStalls(trace)
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

  // The predicates are not vacuous: states and steps that break a guarantee
  // fail its predicate.

  // Two files whose names are one file on the device break G7.
  lemma G7Rejects(d: DeviceId, platform: Platform, p: Path, q: Path, f: DiskFile, g: DiskFile)
    requires p != q && SameF(platform, p, q)
    ensures !G7_OneFilePerName(State(
      map[d := Device(platform, true, Journal(map[], 0, [], []), map[p := f, q := g], {}, {})],
      Server(map[], map[], [], {}, map[])))
  {
    var s := State(
      map[d := Device(platform, true, Journal(map[], 0, [], []), map[p := f, q := g], {}, {})],
      Server(map[], map[], [], {}, map[]));
    assert p in s.devices[d].disk && q in s.devices[d].disk && CollideF(platform, p, q);
  }

  // Deleting a file no document is bound to breaks G2.
  lemma G2Rejects(d: DeviceId, platform: Platform, p: Path, f: DiskFile, doc: DocId, event: Event)
    requires event == Local(d, Modified(p))
    ensures !G2_NoUntrackedDelete(Step(
      State(map[d := Device(platform, true, Journal(map[], 0, [], []), map[p := f], {}, {})],
            Server(map[], map[], [], {}, map[])),
      event, [Remove(doc, p, f.content)],
      State(map[d := Device(platform, true, Journal(map[], 0, [], []), map[], {}, {})],
            Server(map[], map[], [], {}, map[]))))
  {
    var device := Device(platform, true, Journal(map[], 0, [], []), map[p := f], {}, {});
    assert !Tracked(device, p);
  }

  // Two documents bound to one file break G5.
  lemma G5Rejects(d: DeviceId, platform: Platform, p: Path, doc1: DocId, doc2: DocId, h: Hash)
    requires doc1 != doc2
    ensures !G5_NeverJoined(State(
      map[d := Device(platform, true,
        Journal(map[doc1 := Document(None, None, Some(Binding(p, h, false, None)), Never, None),
                    doc2 := Document(None, None, Some(Binding(p, h, false, None)), Never, None)], 0, [], []),
        map[], {}, {})],
      Server(map[], map[], [], {}, map[])))
  {
    var s := State(
      map[d := Device(platform, true,
        Journal(map[doc1 := Document(None, None, Some(Binding(p, h, false, None)), Never, None),
                    doc2 := Document(None, None, Some(Binding(p, h, false, None)), Never, None)], 0, [], []),
        map[], {}, {})],
      Server(map[], map[], [], {}, map[]));
    assert d in s.devices && doc1 in s.devices[d].journal.documents && doc2 in s.devices[d].journal.documents;
    assert SameF(platform, p, p);
  }

  // A run starts in the initial state and each step starts where the
  // previous one ended.
  ghost predicate Run(platforms: map<DeviceId, Platform>, trace: Trace) {
    Connected(trace) && (|trace| > 0 ==> trace[0].pre == Initial(platforms))
  }
}
