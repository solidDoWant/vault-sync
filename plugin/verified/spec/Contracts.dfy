// The contracts of the remaining verified-core steps (verified-core.md §4,
// design issue #1011).
//
// Each contract is a ghost predicate the step's PR must prove true, with a
// lemma `ensures <Contract>()` (or `ensures <Contract>(...)` for every
// argument). These are statements only: no proof is given here, and no
// contract is assumed by any other proof. The functions a step supplies
// (its handler, made into a Step) are declared without a body; the step's PR
// gives them one in a refining module. A step that finds it cannot prove its
// contract as stated has found a design gap (`design-gap`), and records why
// this pass missed it.
//
// The contracts are stated over the core's invariants (CoreInv, ServerInv,
// RowInv, MirrorInv), so this file builds on the core's modules; it adds no
// definition the core uses.
include "../core/Push.dfy"

// It refines the push half's module, not the pull apply's: Dafny 4.11's
// resolver crashes on a module refining ApplyCore. The apply's contract is
// therefore stated on rows, which #1007 proves of ApplyRevision's result.
abstract module StepContracts refines PushCore {

  // ---------------------------------------------------------------------
  // Shared vocabulary
  // ---------------------------------------------------------------------

  // What every step theorem starts from and must keep (§3.2, §3.5, §3.7).
  ghost predicate CoreReachable(state: State) {
    StateInvariants(state) && CoreInv(state) && ServerInv(state) && MirrorInv(state)
  }

  // A step keeps every invariant and satisfies every step predicate.
  ghost predicate KeepsAll(step: Step) {
    CoreReachable(step.post) && StepGuarantees(step)
  }

  // The revision ids of §3.1 name every document's next outbox, a new
  // document's first one included.
  ghost predicate RevsCover(journal: Journal, input: RoundInput, revs: FreshRevs) {
    journal.documents.Keys <= revs.Keys
    && forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
  }

  // An intent covers a disk effect: it records, before the effect is
  // performed, enough to finish or undo it from the disk alone (design §4.4).
  ghost predicate Covers(intent: IntentKind, effect: Effect) {
    match effect
    case Write(target, path, _, _, _) =>
      (target.Some? && intent.ApplyIntent? && intent.doc == target.value)
      || (intent.MergeIntent? && (target == Some(intent.doc) || target.None?))
    case Remove(doc, _, _) => intent.ApplyIntent? && intent.doc == doc
    case Move(_, from, to, expected) =>
      (intent.DisplaceIntent? && intent.from == from && intent.to == to && intent.content == expected)
      || (intent.DetachIntent? && intent.from == from && intent.to == to)
    case _ => false
  }

  // Crash safety of a step's effects (§4.3, #950): every disk effect comes
  // after a PersistJournal whose journal holds an intent that covers it, and
  // the step's last effect that persists a journal persists one with no
  // open intent, after every disk effect.
  ghost predicate IntentsCoverDiskEffects(effects: seq<Effect>) {
    (forall i :: 0 <= i < |effects| && IsDiskEffect(effects[i]) ==>
       exists j :: 0 <= j < i && effects[j].PersistJournal?
         && exists intent :: intent in effects[j].journal.intents && Covers(intent.kind, effects[i]))
    && ((exists i :: 0 <= i < |effects| && IsDiskEffect(effects[i])) ==>
          exists j :: 0 <= j < |effects| && effects[j].PersistJournal? && |effects[j].journal.intents| == 0
            && forall i :: j < i < |effects| ==> !IsDiskEffect(effects[i]) && !effects[i].PersistJournal?)
  }

  // ---------------------------------------------------------------------
  // #962: the path-conflict rule
  // ---------------------------------------------------------------------

  // The rule acts in a sync round. It never moves a file an open editor
  // holds unsaved text in, or one that collides with such a path (its
  // folders included: a revision creating `a/b.md` while an untracked `a`
  // has unsaved text moves nothing).
  ghost predicate NoMoveFromUnsaved(step: Step) {
    step.event.SyncRound? && step.event.device in step.pre.devices ==>
      var device := step.pre.devices[step.event.device];
      forall i :: 0 <= i < |step.effects| && step.effects[i].Move? ==>
        forall editor :: editor in device.editors && editor.unsaved.Some? ==>
          !CollideF(device.platform, editor.path, step.effects[i].from)
  }

  // A conflict copy (a write of no document where no file is) takes a name
  // that collides, under K, with no server claim the device knows of
  // another document (a live base or ahead path, folders included, or a live
  // outbox path as a name, PO-14), and under F with nothing in the round's
  // listing, bound name or unsaved path. (#1004 proves it of the copy-name
  // function; #962 of every copy the rule writes.)
  ghost predicate CopiesTakeFreeNames(step: Step, input: RoundInput) {
    step.event.SyncRound? && step.event.device in step.pre.devices ==>
      var device := step.pre.devices[step.event.device];
      forall i :: 0 <= i < |step.effects| && step.effects[i].Write? && step.effects[i].target.None? ==>
        var copy := step.effects[i].path;
        (forall q :: q in input.listing ==> !CollideF(device.platform, q, copy))
        && (forall u :: u in input.unsaved ==> !SameF(device.platform, u, copy))
        && (forall doc :: doc in device.journal.documents ==>
              var document := device.journal.documents[doc];
              (document.binding.Some? ==> !SameF(device.platform, document.binding.value.spelling, copy))
              && (document.base.Some? && !document.base.value.deleted ==> !CollideK(document.base.value.path, copy))
              && (document.ahead.Some? && !document.ahead.value.revision.deleted
                  ==> !CollideK(document.ahead.value.revision.path, copy))
              && (document.outbox.Some? && !document.outbox.value.deleted
                  ==> !SameK(document.outbox.value.path, copy)))
  }

  // After a round, a revision is held for a name (PathHeld) only where a
  // user must act (UserMustAct: unsaved text in the way), and every copy the
  // rule cannot name is a revision the device reports it cannot hold
  // (Unmaterializable(alias := false), a CannotHold blocker). The rest is
  // G10_SettledOrReported, which KeepsAll includes.
  ghost predicate PathRuleContract(step: Step, input: RoundInput) {
    NoMoveFromUnsaved(step) && CopiesTakeFreeNames(step, input)
    && (step.event.SyncRound? && step.event.device in step.post.devices ==>
          var device := step.post.devices[step.event.device];
          forall doc :: (doc in device.journal.documents && device.journal.documents[doc].ahead.Some?
                         && device.journal.documents[doc].ahead.value.blocker.PathHeld?) ==> UserMustAct(device, doc))
  }

  // ---------------------------------------------------------------------
  // #1007: the pull apply settles the conflicts G6 decides
  // ---------------------------------------------------------------------

  // The row the pull apply returns (`after`) for one pulled revision `r` of
  // a document whose row is `before`, where the round's listing reads
  // `read` at its bound name and `mustAct` says whether a user must act on
  // it (UserMustAct in the state after). #1007 proves it of ApplyRevision's
  // row, with the lemmas of §3.9 (AppliedG2, AppliedG5, AppliedG6,
  // AppliedG7, AppliedKeepsRowInv) extended to each settlement. The
  // settlements (verified-core.md §4.2):
  // - a remote delete against a change the server lacks: the file stays,
  //   the tombstone becomes the base, and the outbox sends the file on top
  //   of it;
  // - the user's delete (or a bound file missing from the listing, which the
  //   round records as the user's delete, G3_DeleteSeen) against a live
  //   remote revision: the file comes back, at the name the path rule gives,
  //   and the revision becomes the base;
  // - a remote move against a local change: the remote's name, the content
  //   settled as for an edit (SPEC.md §7, path and content merged apart);
  // - a commit in flight: as #1006 decided (§3.9);
  // - a pulled revision whose id is the outbox's: the outbox's
  //   acknowledgement, settled as §3.5's "accepted";
  // - a remote revision whose path and content are what the file holds: no
  //   conflict, it becomes the base and nothing is written or copied.
  // Only a user's need to act, or a file the device cannot hold, leaves the
  // revision waiting.
  ghost predicate ApplySettlesContract(before: Document, after: Document, r: Revision, read: Option<(Hash, Kind)>, mustAct: bool) {
    var rBase := Base(r.id, r.position, r.path, r.content, r.kind, r.deleted);
    var newer := before.ahead.Some? ==> before.ahead.value.revision.position < r.position;
    var changed := before.outbox.Some? || (before.binding.Some? && read != Some((before.binding.value.seen, KindOf(before))));
    RowInv(before) ==>
      RowInv(after)
      && (after.ahead.Some? && (after.ahead.value.blocker.LocalChanges? || after.ahead.value.blocker.PathHeld?) ==> mustAct)
      // A remote delete against a change the server lacks keeps the file.
      && (newer && r.deleted && before.binding.Some? && changed && !mustAct
          ==> after.binding.Some? && after.base == Some(rBase)
              && after.outbox.Some? && !after.outbox.value.deleted)
      // A live remote revision against the user's delete brings the file back.
      && (newer && !r.deleted && before.binding.None? && before.absence == UserDeleted
          && (after.ahead.None? || !CannotHold(after.ahead.value.blocker)) && !mustAct
          ==> after.binding.Some? && after.base == Some(rBase))
      // The outbox's own revision is its acknowledgement.
      && (newer && before.outbox.Some? && before.outbox.value.rev == r.id
          ==> after.base == Some(rBase) && after.ahead.None?)
      // A revision identical to the file is no conflict.
      && (newer && !r.deleted && before.binding.Some? && before.binding.value.spelling == r.path
          && read == Some((r.content, r.kind)) && !mustAct
          ==> after.base == Some(rBase) && after.ahead.None?
              && after.binding == Some(before.binding.value.(seen := r.content)))
  }

  // ---------------------------------------------------------------------
  // #982: the sync round
  // ---------------------------------------------------------------------

  // The round's step from the state before, its input and the revision ids
  // of §3.1: a pull of every revision after the device's cursor, the apply of
  // each, then the push. Supplied by #982.
  ghost function RoundStepOf(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs): Step
    requires d in pre.devices

  // A pulled revision whose id is the document's outbox's (sealed or not:
  // a reopened outbox keeps its id, §3.5) is that outbox's acknowledgement,
  // and the round takes it as §3.5's "accepted" answer. Every other revision
  // of this device's is one it already acknowledged, so not newer.
  // Revision `id` of document `doc` is the device's own and newer than its
  // base.
  ghost predicate Unacknowledged(state: State, d: DeviceId, doc: DocId, id: RevId) {
    d in state.devices && doc in state.devices[d].journal.documents && doc in state.server.history
    && id in state.server.history[doc] && id in state.server.revisions
    && state.server.revisions[id].device == d
    && var document := state.devices[d].journal.documents[doc];
    (document.base.None? || document.base.value.position < state.server.revisions[id].position)
  }

  ghost predicate OwnRevisionsAcknowledged(state: State, d: DeviceId) {
    d in state.devices
    && forall doc, id :: Unacknowledged(state, d, doc, id) ==>
         var document := state.devices[d].journal.documents[doc];
         document.outbox.Some? && document.outbox.value.rev == id
  }

  ghost predicate RoundContract(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs) {
    (d in pre.devices && pre.devices[d].running && CoreReachable(pre)
     && OwnRevisionsAcknowledged(pre, d)
     && RoundInputOf(pre, d, input)
     && RevsCover(pre.devices[d].journal, input, revs))
    ==>
      var step := RoundStepOf(pre, d, input, revs);
      step.pre == pre && step.event == SyncRound(d)
      && KeepsAll(step) && OwnRevisionsAcknowledged(step.post, d)
      && PathRuleContract(step, input)
      && d in step.post.devices && step.post.devices[d].journal.cursor == |pre.server.feed|
      && CommitsPersistedFirst(step.effects)
      && IntentsCoverDiskEffects(step.effects)
      // The round finishes what it can: a second round right after it has
      // nothing to do on disk or on the server.
      && (forall input2, revs2 :: RoundInputOf(step.post, d, input2)
            && RevsCover(step.post.devices[d].journal, input2, revs2)
            ==> G10_NoLoop(step, RoundStepOf(step.post, d, input2, revs2)))
  }

  // ---------------------------------------------------------------------
  // #950: history events and crash recovery
  // ---------------------------------------------------------------------

  // A server event (a restore from backup, a purge, a restore from history)
  // changes no device. From a reachable state it keeps CoreInv, MirrorInv
  // (a device it unfinishes stays out of MirrorInv's reach) and the
  // StepGuarantees; a purge and a restore from history keep StateInvariants
  // and ServerInv too. A restore keeps them apart from what it lost
  // (owner question on #1011: G1_Retained across a restore that loses a
  // version no device holds; ServerInv's cursor clause until the device's
  // resync).
  ghost predicate ServerEventContract(step: Step) {
    (step.event.Restore? || step.event.Purge? || step.event.RestoreFromHistory?)
    && CoreReachable(step.pre) && ServerFollowsEvent(step)
    && step.post.devices == step.pre.devices && step.effects == []
    ==>
      CoreInv(step.post) && MirrorInv(step.post) && StepGuarantees(step)
      && (!step.event.Restore? ==> StateInvariants(step.post) && ServerInv(step.post))
  }

  // What a crash leaves (settled here, verified-core.md §4.1): the app stops,
  // its open editors are gone with their unsaved text, the disk is as the
  // performed effects leave it (DisksFollowEffects), and the journal is the
  // last one the performed effects persisted, or the journal before the
  // step that was cut short if none did.
  ghost predicate CrashLeaves(step: Step) {
    step.event.Crash? && step.event.device in step.pre.devices ==>
      var d := step.event.device;
      var device := step.pre.devices[d];
      d in step.post.devices
      && !step.post.devices[d].running && step.post.devices[d].editors == {}
      && step.post.devices[d].platform == device.platform
      && step.post.devices[d].outOfScope == device.outOfScope
      && step.post.server == step.pre.server
      && (forall x :: x in step.pre.devices && x != d ==> x in step.post.devices && step.post.devices[x] == step.pre.devices[x])
      && step.post.devices.Keys == step.pre.devices.Keys
      && ((forall i :: 0 <= i < |step.effects| ==> !step.effects[i].PersistJournal?)
          ==> step.post.devices[d].journal == device.journal)
      && (forall i :: 0 <= i < |step.effects| && step.effects[i].PersistJournal?
            && (forall j :: i < j < |step.effects| ==> !step.effects[j].PersistJournal?)
            ==> step.post.devices[d].journal == step.effects[i].journal)
  }

  // The core's restart: from the journal and the disk's listing (read from
  // the step's state before, as the scan's) it finishes or undoes every open
  // intent. Supplied by #950.
  ghost function RestartStepOf(pre: State, d: DeviceId, revs: FreshRevs): Step
    requires d in pre.devices

  // The resync the shell runs on the server's divergence signal after a
  // restore from backup (SPEC.md §8 "Divergence", engine design §4.6), from
  // the round's input. Supplied by #950.
  ghost function ResyncStepOf(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs): Step
    requires d in pre.devices

  // A state a crash may leave: CoreReachable apart from the intents the
  // crash left open, which only a restart resolves. #950 defines it
  // (CrashInv) and proves that a crash from a CoreReachable state leaves it.
  ghost predicate CrashInv(state: State)

  ghost predicate RecoveryContract(pre: State, d: DeviceId, revs: FreshRevs) {
    d in pre.devices && !pre.devices[d].running && CrashInv(pre)
    && pre.devices[d].journal.documents.Keys <= revs.Keys
    ==>
      var step := RestartStepOf(pre, d, revs);
      step.pre == pre && step.event == Restart(d)
      && d in step.post.devices && step.post.devices[d].running
      && G8_Recovers(step) && StepGuarantees(step)
      && (CrashInv(step.post) || CoreReachable(step.post))
      && (forall x :: x != d && x in pre.devices ==> x in step.post.devices && step.post.devices[x] == pre.devices[x])
  }

  ghost predicate CrashContract(step: Step) {
    step.event.Crash? && CrashCutsShort(step) && CrashLeaves(step) && DisksFollowEffects(step)
    && CoreReachable(step.pre)
    ==> CrashInv(step.post) && StepGuarantees(step)
  }

  ghost predicate ResyncContract(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs) {
    (d in pre.devices && pre.devices[d].running && CoreInv(pre)
     && RoundInputOf(pre, d, input)
     && RevsCover(pre.devices[d].journal, input, revs))
    ==>
      var step := ResyncStepOf(pre, d, input, revs);
      step.pre == pre && step.event == Resync(d)
      && CoreInv(step.post) && StepGuarantees(step)
      && d in step.post.devices && step.post.devices[d].journal.cursor == |pre.server.feed|
      && OwnRevisionsAcknowledged(step.post, d)
      && IntentsCoverDiskEffects(step.effects)
  }

  // ---------------------------------------------------------------------
  // #963: two devices on one feed converge
  // ---------------------------------------------------------------------

  // Two finished devices on one server, from a reachable state, have each
  // document they both hold, and neither holds back, at the same base
  // revision (so at one path and with one content), apart from files one of
  // them cannot hold or does not sync. With RoundContract (a round from a state with no local change
  // leaves the device finished), two devices that apply the same feed with
  // no further local events converge.
  ghost predicate ConvergenceContract(state: State, d1: DeviceId, d2: DeviceId) {
    CoreReachable(state) && FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
    ==> forall doc :: doc in state.devices[d1].journal.documents && doc in state.devices[d2].journal.documents
          && state.devices[d1].journal.documents[doc].binding.Some?
          && state.devices[d2].journal.documents[doc].binding.Some?
          && state.devices[d1].journal.documents[doc].ahead.None?
          && state.devices[d2].journal.documents[doc].ahead.None?
          ==> state.devices[d1].journal.documents[doc].base == state.devices[d2].journal.documents[doc].base
  }

  // A round of a running device with no local change (nothing to send, no
  // user's delete, no untracked in-scope file, no unsaved text, and the disk
  // as the journal last saw it) leaves it finished.
  ghost predicate NoLocalChange(state: State, d: DeviceId) {
    d in state.devices
    && var device := state.devices[d];
    device.running && |device.journal.intents| == 0
    && (forall e :: e in device.editors ==> e.unsaved.None?)
    && (forall doc :: doc in device.journal.documents ==>
          device.journal.documents[doc].outbox.None? && device.journal.documents[doc].absence != UserDeleted
          && (device.journal.documents[doc].binding.Some? ==>
                var b := device.journal.documents[doc].binding.value;
                b.spelling in device.disk && device.disk[b.spelling].content == b.seen))
    && (forall p :: p in device.disk && p !in device.outOfScope ==> Tracked(device, p))
  }

  ghost predicate OneRoundFinishes(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs) {
    d in pre.devices && NoLocalChange(pre, d) && CoreReachable(pre) && OwnRevisionsAcknowledged(pre, d)
    && RoundInputOf(pre, d, input)
    && RevsCover(pre.devices[d].journal, input, revs)
    ==> FinishedSyncing(RoundStepOf(pre, d, input, revs).post, d)
  }

  // ---------------------------------------------------------------------
  // #966: the trace guarantees over every run
  // ---------------------------------------------------------------------

  // A step the core handles, or one of the outside world or a crash, as
  // the specification and the shell define them. #966 defines it from the
  // step functions above and the merged ones (LocalStep, ScanStep,
  // RemoteStep, RefusedStep, AcceptStep, RoundStepOf, RestartStepOf,
  // ResyncStepOf), user actions, server events (ServerFollowsEvent) and
  // crashes (CrashCutsShort, CrashLeaves, DisksFollowEffects).
  ghost predicate CoreStep(step: Step)

  // The shell's obligation over a run (#952): after a restore from backup,
  // each device resyncs before its next sync round, and no local event is
  // delivered that an earlier scan's listing already reflects (§3.4).
  ghost predicate ShellRun(trace: Trace) {
    forall j, k, d :: 0 <= j < k < |trace| && trace[j].event.Restore?
      && trace[k].event == SyncRound(d)
      ==> exists m :: j < m < k && trace[m].event == Resync(d)
  }

  ghost predicate TraceContract(platforms: map<DeviceId, Platform>, trace: Trace) {
    Run(platforms, trace) && ShellRun(trace) && (forall i :: 0 <= i < |trace| ==> CoreStep(trace[i]))
    ==> TraceGuarantees(trace)
  }

  ghost predicate AsIfNoCrashContract(platforms: map<DeviceId, Platform>, crashed: Trace, clean: Trace) {
    Run(platforms, crashed) && Run(platforms, clean) && ShellRun(crashed) && ShellRun(clean)
    && (forall i :: 0 <= i < |crashed| ==> CoreStep(crashed[i]))
    && (forall i :: 0 <= i < |clean| ==> CoreStep(clean[i]))
    ==> G8_AsIfNoCrash(crashed, clean)
  }

  // ---------------------------------------------------------------------
  // #952: what the shell supplies and may assume
  // ---------------------------------------------------------------------

  // Each step the shell hands the core is the core's step: its input is
  // read from the step's state before (LocalReads, the scan's listing,
  // RoundInputOf), its disk effects take effect only where their
  // preconditions hold (DisksFollowEffects), each PersistJournal is atomic
  // (CrashLeaves sees a journal whole or not at all), and a Pushed event
  // answers a commit the core requested. #952 proves the TypeScript side by
  // tests: the externs' axioms (Paths.dfy, PathOrder, DocOrder) by one
  // property test each, the merge against Merge3's contract, and every
  // effect's precondition check by failure injection between effects.
  ghost predicate ShellStep(step: Step) {
    DisksFollowEffects(step) && ServerFollowsEvent(step) && CrashCutsShort(step) && CrashLeaves(step)
  }

  // ---------------------------------------------------------------------
  // #953: the simulation's oracle
  // ---------------------------------------------------------------------

  // The checker evaluates, on the finite states and steps of a simulated
  // run, exactly these predicates: StateInvariants and the core's
  // invariants after every step, StepGuarantees and ShellStep on every
  // step, and TraceGuarantees at the end. #953 compiles each through a
  // non-ghost function with `ensures result == <predicate>(...)`, proved,
  // over finite states (every quantifier bounded by a map's keys or a
  // sequence's indices).
  ghost predicate OracleContract(step: Step) {
    CoreReachable(step.post) && StepGuarantees(step) && ShellStep(step)
  }
}
