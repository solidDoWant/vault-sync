// Satisfiability witnesses and rejections for the step contracts of
// Contracts.dfy (#1025). As in Witnesses.dfy, a witness shows a contract's
// hypotheses or conclusion can be met by the case it is meant to cover, so
// no correct core is ruled out; a rejection shows it excludes the failure
// its comment rules out.
include "Contracts.dfy"

abstract module StepContractWitnesses refines StepContracts {

  // ---------------------------------------------------------------------
  // CrashContract: the cut is the core's own step
  // ---------------------------------------------------------------------

  // Witnesses.dfy's crash after the first of two requested effects
  // (CrashAfterFirstEffectCutsShort), restated with the requested effects
  // being the core's round's: a crash that performed the first of them
  // meets every hypothesis CrashContract places on the cut.
  lemma CrashAfterFirstRequestedEffect(pre: State, post: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input) && RevsCover(pre.devices[d].journal, input, revs)
    requires |RoundStepOf(pre, d, input, revs).effects| >= 2
    ensures
      var requested := RoundStepOf(pre, d, input, revs).effects;
      var step := Step(pre, Crash(d, Some(Cut(SyncRound(d), requested))), requested[..1], post);
      CrashCutsShort(step) && CutRequestedByCore(step)
  {
    var requested := RoundStepOf(pre, d, input, revs).effects;
    assert CoreRequests(pre, SyncRound(d), requested);
  }

  // A crash whose cut lists a PersistJournal of a journal other than the
  // one the core persists for a remote revision is a prefix of what it
  // lists (CrashCutsShort alone admits it), but not the core's step: it
  // fails CutRequestedByCore, so CrashContract does not admit it, and the
  // journal CrashLeaves would keep (`j`) is never one a crash can leave.
  lemma CrashOfArbitraryJournalRejected(pre: State, post: State, d: DeviceId, revision: Revision, j: Journal)
    requires d in pre.devices && j != RemoteJournal(pre.devices[d].journal, revision)
    ensures
      var step := Step(pre, Crash(d, Some(Cut(RemoteRevision(d, revision), [PersistJournal(j)]))), [PersistJournal(j)], post);
      CrashCutsShort(step) && !CutRequestedByCore(step)
  {
    var requested := [PersistJournal(j)];
    assert requested[..1] == requested;
    assert RemoteStep(pre, d, revision).effects == [PersistJournal(RemoteJournal(pre.devices[d].journal, revision))];
  }

  // The same for a local event, whose step function also takes fresh
  // revision ids: no choice of them makes the core persist a journal with
  // another cursor (a local event never moves the cursor).
  lemma CrashOfOtherCursorRejected(pre: State, post: State, d: DeviceId, local: LocalEvent, j: Journal)
    requires d in pre.devices && j.cursor != pre.devices[d].journal.cursor
    ensures
      var step := Step(pre, Crash(d, Some(Cut(Local(d, local), [PersistJournal(j)]))), [PersistJournal(j)], post);
      CrashCutsShort(step) && !CutRequestedByCore(step)
  {
    var requested := [PersistJournal(j)];
    assert requested[..1] == requested;
    forall revs: FreshRevs | pre.devices[d].journal.documents.Keys <= revs.Keys
      ensures LocalStep(pre, d, local, revs).effects != requested
    {
      var device := pre.devices[d];
      var input := map p | p in LocalEventPaths(local) :: ReadAt(device, p);
      var journal' := LocalJournal(device.platform, device.journal, local, input, revs);
      assert LocalStep(pre, d, local, revs).effects == [PersistJournal(journal')];
      assert journal'.cursor == device.journal.cursor;
    }
  }

  // ---------------------------------------------------------------------
  // ApplySettlesContract: the row after the path rule
  // ---------------------------------------------------------------------

  // A clean bound file at `p`, synced at revision `rev0`.
  function CleanRow(rev0: RevId, p: Path, h: Hash): Document {
    Document(Some(Base(rev0, 0, p, h, Note, false)), None, Some(Binding(p, h, false, None)), Never, None)
  }

  // A remote move of a clean file to `q`, a name the path rule clears (no
  // file in its way, or every one moved aside): the row after the rule
  // binds the file at `q` and takes the revision as its base, with nothing
  // left waiting, and no user must act. ApplySettlesContract holds of it.
  lemma RuledRemoteMoveSettles(rev0: RevId, rev1: RevId, doc: DocId, device: DeviceId, p: Path, q: Path, h: Hash)
    requires p != q
    ensures
      var r := Revision(rev1, doc, 1, Some(rev0), q, h, Note, false, device);
      var before := CleanRow(rev0, p, h);
      var after := Document(Some(Base(rev1, 1, q, h, Note, false)), None, Some(Binding(q, h, false, None)), Never, None);
      ApplySettlesContract(before, after, r, Some((h, Note)), false)
  {
  }

  // The row ApplyRevision returns for the same move holds the revision for
  // its name (PathHeld). Left there although no user must act, it fails
  // ApplySettlesContract: the contract is about the rule's row, and the
  // rule must settle the move.
  lemma HeldRemoteMoveRejected(rev0: RevId, rev1: RevId, doc: DocId, device: DeviceId, p: Path, q: Path, h: Hash)
    requires p != q
    ensures
      var r := Revision(rev1, doc, 1, Some(rev0), q, h, Note, false, device);
      var before := CleanRow(rev0, p, h);
      var held := before.(ahead := Some(Ahead(r, PathHeld, true)));
      !ApplySettlesContract(before, held, r, Some((h, Note)), false)
  {
  }
}
