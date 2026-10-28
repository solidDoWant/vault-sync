// Crash and restart recovery (#1018, split from #950; verified-core.md §4).
//
// A crash leaves the journal the last PersistJournal of the step it cut
// short persisted (CrashLeaves), and the disk as the performed effects left
// it. The only journals a step persists with open intents are the sync
// round's guards (SettleRevision): the rows before the revision, and one
// intent per disk effect of the revision's rule. The restart settles each
// open intent from the journal alone (Recover) and persists the result
// before the device runs again (RestartStepOf):
//
// - an intent of a revision (ApplyIntent, MergeIntent) is undone: its row
//   stays as the guard has it, the row before the revision, and the
//   revision is recorded as waiting (`ahead`, LocalChanges) where it is
//   newer than what the row knows. The next round retries it as a waiting
//   row (RetryWaiting), so a revision the device already read is never
//   forgotten (ClaimsCoverCursor) and whatever the revision's half-done
//   effects left on disk is the device's local version of it, which the
//   round merges (engine design §4.4: "anything else: hand D to the merge
//   path, as a local change").
// - an intent that moves a file (DisplaceIntent, DetachIntent) is undone
//   in the journal: the binding stays where the guard has it, and the
//   start-up scan that follows the restart finds the file wherever the move
//   left it (G8_PicksUpOfflineChanges).
// - a commit or resync intent, which no step of the core opens, is dropped.
//
// Either outcome of a half-done revision is acceptable (engine design
// §10.3, owner's policy: nothing is lost); a crash may therefore leave a
// conflict copy a crash-free run would not (verified-core.md §4.3).
//
// CrashInv is CoreReachable's claims of the state every crashed device's
// restart would make (Recovered), and no running device has an open intent.
// Dafny 4.11's resolver crashes on a module refining RoundClaimsCore, so
// this one refines PathRuleCore, which has the round's body.
include "PathRule.dfy"

abstract module RecoveryCore refines PathRuleCore {

  // ---------------------------------------------------------------------
  // The restart
  // ---------------------------------------------------------------------

  // The revision an intent applies, if it applies one.
  function IntentRevision(kind: IntentKind): Option<(DocId, Revision)> {
    match kind
    case ApplyIntent(doc, r) => Some((doc, r))
    case MergeIntent(doc, r, _, _, _) => Some((doc, r))
    case _ => None
  }

  // Undo one intent: a revision it applies waits on its row.
  function UndoIntent(documents: map<DocId, Document>, kind: IntentKind): map<DocId, Document> {
    match IntentRevision(kind)
    case None => documents
    case Some(applied) =>
      var doc := applied.0;
      var r := applied.1;
      var row := if doc in documents then documents[doc] else NoRow();
      if Newer(row, r) then documents[doc := row.(ahead := Some(Ahead(r, LocalChanges, false)))]
      else documents
  }

  function UndoIntents(documents: map<DocId, Document>, intents: seq<Intent>): map<DocId, Document>
    decreases |intents|
  {
    if |intents| == 0 then documents
    else UndoIntents(UndoIntent(documents, intents[0].kind), intents[1..])
  }

  // The journal the restart persists: every open intent settled.
  function Recover(journal: Journal): Journal {
    journal.(documents := UndoIntents(journal.documents, journal.intents), intents := [])
  }

  // Every device as its restart would leave its journal.
  ghost function Recovered(state: State): State {
    state.(devices := map x | x in state.devices :: state.devices[x].(journal := Recover(state.devices[x].journal)))
  }

  ghost predicate CrashInv(state: State) {
    (forall x :: x in state.devices && state.devices[x].running ==> |state.devices[x].journal.intents| == 0)
    && ClaimsCore(Recovered(state))
  }

  // The restart persists the recovered journal (nothing when no intent is
  // open) and runs the app again.
  ghost function RestartStepOf(pre: State, d: DeviceId, revs: FreshRevs): Step
  {
    var device := pre.devices[d];
    var journal' := Recover(device.journal);
    var effects := if |device.journal.intents| == 0 then [] else [PersistJournal(journal')];
    Step(pre, Restart(d), effects, pre.(devices := pre.devices[d := device.(journal := journal', running := true)]))
  }

  // ---------------------------------------------------------------------
  // Recover
  // ---------------------------------------------------------------------

  // A journal with no open intent is its own recovery.
  lemma RecoverNoIntent(journal: Journal)
    requires |journal.intents| == 0
    ensures Recover(journal) == journal
  {}

  // Recovery is idempotent.
  lemma RecoverIdempotent(journal: Journal)
    ensures Recover(Recover(journal)) == Recover(journal)
  {}

  // Undoing intents keeps every row apart from its ahead, and adds only
  // rows with nothing but an ahead.
  ghost predicate OnlyAheads(documents: map<DocId, Document>, documents': map<DocId, Document>) {
    documents.Keys <= documents'.Keys
    && (forall doc :: doc in documents' ==>
          var before := if doc in documents then documents[doc] else NoRow();
          documents'[doc] == before.(ahead := documents'[doc].ahead))
  }

  lemma UndoIntentsOnlyAheads(documents: map<DocId, Document>, intents: seq<Intent>)
    ensures OnlyAheads(documents, UndoIntents(documents, intents))
    decreases |intents|
  {
    if |intents| > 0 {
      var once := UndoIntent(documents, intents[0].kind);
      assert OnlyAheads(documents, once);
      UndoIntentsOnlyAheads(once, intents[1..]);
    }
  }

  // ---------------------------------------------------------------------
  // RecoveryContract
  // ---------------------------------------------------------------------

  lemma RestartStepFacts(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices
    ensures var step := RestartStepOf(pre, d, revs);
      step.pre == pre && step.event == Restart(d)
      && d in step.post.devices && step.post.devices[d].running
      && G8_Recovers(step)
      && (forall x :: x != d && x in pre.devices ==> x in step.post.devices && step.post.devices[x] == pre.devices[x])
  {}

  lemma RestartGuarantees(pre: State, d: DeviceId, revs: FreshRevs)
    requires d in pre.devices && !pre.devices[d].running && CrashInv(pre)
    ensures StepGuarantees(RestartStepOf(pre, d, revs))
  {
    var step := RestartStepOf(pre, d, revs);
    UndoIntentsOnlyAheads(pre.devices[d].journal.documents, pre.devices[d].journal.intents);
    assert G1_OnlyRetentionRemoves(step);
    assert G2_OnlyWhatItSaw(step);
    assert G2_Conditional(step);
    assert G2_NoUntrackedDelete(step);
    assert G2_UnsavedSafe(step);
    assert G3_DeleteSeen(step);
    assert G5_RenameKeepsDocument(step);
    var before := pre.devices[d];
    var after := step.post.devices[d];
    var docs := before.journal.documents;
    var docs' := after.journal.documents;
    assert Recovered(pre).devices[d].disk == before.disk;
    assert G7_OneFilePerName(Recovered(pre));
    assert after.disk == before.disk && after.platform == before.platform;
    forall doc ensures BoundIdentity(after, doc) == BoundIdentity(before, doc) {
      if doc in docs' {
        var row := if doc in docs then docs[doc] else NoRow();
        assert docs'[doc].binding == row.binding;
        if docs'[doc].binding.Some? {
          assert doc in docs && docs[doc].binding == docs'[doc].binding;
          var spelling := docs[doc].binding.value.spelling;
          SameFileOnSameDisk(before, after, spelling);
        }
      } else {
        assert doc !in docs;
      }
      assert BoundFile(after, doc) == BoundFile(before, doc);
    }
    assert G5_NeverMixedUp(step);
    assert forall x, doc, remote :: SettlesConcurrent(step, x, doc, remote) ==> G6_Settle(step, x, doc, remote);
    assert G7_MoveKeepsContents(step);
    assert G8_PicksUpOfflineChanges(step);
    assert G10_SettledOrReported(step);
    assert DisksFollowEffects(step);
    assert ServerFollowsEvent(step);
  }
}
