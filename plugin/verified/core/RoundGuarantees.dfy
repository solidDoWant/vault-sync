// The sync round's step guarantees (#1091, part 2 of #1034's split): the
// round (RetryWaiting, then SettlePulled, then OnPush; RoundStepOf in
// PathRule.dfy) keeps each guarantee of StepGuarantees except
// G10_SettledOrReported, which the oracle tests (#1047, #1048). One lemma
// per guarantee; #1034 assembles them into RoundKeepsNoLoss.
//
// This module refines PathRuleCore, so it sees the round's body. (Dafny
// 4.11's precedence linter crashed on any module refining PathRuleCore
// while PathRule.dfy used the let-such-that *statement* `var x :| P;`; it
// now uses the expression form `var x := var x :| P; x;`, as Apply.dfy does.)
include "PathRule.dfy"

abstract module RoundGuarantees refines PathRuleCore {

  // ---------------------------------------------------------------------
  // The round's shape
  // ---------------------------------------------------------------------

  // The round replaces only d's device (its journal and its disk) and leaves
  // the server and every other device as they were.
  lemma RoundOnlyTouchesDevice(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures var step := RoundStepOf(pre, d, input, revs);
      step.pre == pre && step.event == SyncRound(d)
      && step.post.server == pre.server
      && step.post.devices.Keys == pre.devices.Keys
      && (forall x :: x in pre.devices && x != d ==> step.post.devices[x] == pre.devices[x])
      && step.post.devices[d] == pre.devices[d].(journal := step.post.devices[d].journal,
                                                 disk := step.post.devices[d].disk)
  {}

  // ---------------------------------------------------------------------
  // ServerFollowsEvent: a round leaves the server as it was
  // ---------------------------------------------------------------------

  lemma RoundServerFollowsEvent(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures ServerFollowsEvent(RoundStepOf(pre, d, input, revs))
  {}

  // ---------------------------------------------------------------------
  // G5_RenameKeepsDocument and G8_*: about local renames, restarts and
  // scans, so they hold vacuously of a round
  // ---------------------------------------------------------------------

  lemma RoundG5RenameKeepsDocument(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures G5_RenameKeepsDocument(RoundStepOf(pre, d, input, revs))
  {}

  lemma RoundG8Recovers(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures G8_Recovers(RoundStepOf(pre, d, input, revs))
  {}

  lemma RoundG8PicksUpOfflineChanges(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures G8_PicksUpOfflineChanges(RoundStepOf(pre, d, input, revs))
  {}

  // ---------------------------------------------------------------------
  // G2_Conditional: the round changes a file only through an effect whose
  // precondition matched the file's content before the round
  // ---------------------------------------------------------------------

  // An effect's precondition matched file `p`'s content: what
  // G2_Conditional asks of the effect that changed or removed p.
  ghost predicate MatchedBy(platform: Platform, effect: Effect, p: Path, content: Hash) {
    (effect.Write? && SameF(platform, effect.path, p) && effect.precondition == Some(content))
    || (effect.Remove? && SameF(platform, effect.path, p) && effect.expected == content)
    || (effect.Move? && SameF(platform, effect.from, p) && effect.expected == content)
  }

  // One effect changes or removes only the file whose content its
  // precondition matched.
  lemma EffectChangesOnlyMatched(platform: Platform, disk: map<Path, DiskFile>, effect: Effect, disk': map<Path, DiskFile>, p: Path)
    requires EffectTakes(platform, disk, effect, disk')
    requires p in disk && (p !in disk' || disk'[p] != disk[p])
    ensures MatchedBy(platform, effect, p, disk[p].content)
  {
    assert CollideF(platform, p, p);
    match effect
    case Write(_, path, content, kind, precondition) =>
      if precondition.Some? {
        var q := var q :| Holds(platform, disk, q, path, precondition.value)
          && disk' == disk[q := DiskFile(content, kind, disk[q].identity)]; q;
        assert q == p;
      }
    case Remove(_, path, expected) =>
      var q := var q :| Holds(platform, disk, q, path, expected) && disk' == disk - {q}; q;
      assert q == p;
    case Move(_, from, to, expected) =>
      var q := var q :| MovableTo(platform, disk, q, from, to, expected) && disk' == (disk - {q})[to := disk[q]]; q;
      if q != p { assert p in disk - {q}; assert !CollideF(platform, p, to); }
    case _ =>
  }

  // So do effects acting in order: the first one that changes p matched the
  // content p had before all of them.
  lemma EffectsChangeOnlyMatched(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>, p: Path)
    requires EffectsTake(platform, disk, effects, disk')
    requires p in disk && (p !in disk' || disk'[p] != disk[p])
    ensures exists effect :: effect in effects && MatchedBy(platform, effect, p, disk[p].content)
    decreases |effects|
  {
    var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :|
      EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk'); mid;
    if p !in mid || mid[p] != disk[p] {
      EffectChangesOnlyMatched(platform, disk, effects[0], mid, p);
      assert effects[0] in effects;
    } else {
      EffectsChangeOnlyMatched(platform, mid, effects[1..], disk', p);
      var effect: Effect := var effect: Effect :| effect in effects[1..] && MatchedBy(platform, effect, p, mid[p].content); effect;
      assert effect in effects;
    }
  }

  // The round's disk: the effects' result where they can take effect
  // (DiskAfter), otherwise the disk as it was.
  lemma DiskAfterFollows(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>)
    ensures var disk' := DiskAfter(platform, disk, effects);
      disk' == disk || EffectsTake(platform, disk, effects, disk')
  {}

  lemma RoundG2Conditional(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures G2_Conditional(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    RoundOnlyTouchesDevice(pre, d, input, revs);
    var device := pre.devices[d];
    DiskAfterFollows(device.platform, device.disk, step.effects);
    forall x, p | x in step.pre.devices && p in step.pre.devices[x].disk
        && (x !in step.post.devices || p !in step.post.devices[x].disk
            || step.post.devices[x].disk[p] != step.pre.devices[x].disk[p])
      ensures EventDevice(step.event) == Some(x)
      ensures exists effect :: effect in step.effects
                && MatchedBy(step.pre.devices[x].platform, effect, p, step.pre.devices[x].disk[p].content)
    {
      assert x == d;
      EffectsChangeOnlyMatched(device.platform, device.disk, step.effects, step.post.devices[d].disk, p);
    }
  }

  // ---------------------------------------------------------------------
  // G2_UnsavedSafe: no effect of the round writes or removes a file with
  // unsaved text
  // ---------------------------------------------------------------------

  // No effect in `effects` writes or removes a path with unsaved text.
  ghost predicate AvoidsUnsaved(platform: Platform, unsaved: set<Path>, effects: seq<Effect>) {
    forall i | 0 <= i < |effects| && (effects[i].Write? || effects[i].Remove?) :: !UnsavedAt(platform, unsaved, effects[i].path)
  }

  lemma ApplyAvoidsUnsaved(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures AvoidsUnsaved(platform, input.unsaved, ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects)
  {}

  lemma RuleAvoidsUnsaved(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures AvoidsUnsaved(platform, input.unsaved, PathRule(platform, documents, doc, r, input, revs, first).effects)
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    ApplyAvoidsUnsaved(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      ClearWayUnsavedSafe(platform, documents, doc, r, input, revs);
      var effects := ClearWay(platform, documents, doc, r, input, revs).effects;
      forall i | 0 <= i < |effects| && (effects[i].Write? || effects[i].Remove?)
        ensures !UnsavedAt(platform, input.unsaved, effects[i].path)
      {
        assert effects[i] in effects;
      }
    }
  }

  lemma SettleAvoidsUnsaved(platform: Platform, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires AvoidsUnsaved(platform, input.unsaved, pass.effects)
    ensures AvoidsUnsaved(platform, input.unsaved, SettleRevision(platform, pass, doc, r, input, revs, first).effects)
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    if Distinct(platform, pass.listing) && r.path !in input.outOfScope {
      var rows := documents[doc := row];
      var revs' := RevsFor(rows, revs, r);
      var ruled := PathRule(platform, rows, doc, r, input.(listing := pass.listing), revs', first);
      RuleAvoidsUnsaved(platform, rows, doc, r, input.(listing := pass.listing), revs', first);
      var intents := IntentsFor(doc, r, ruled.effects, pass.n);
      var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
      var after := SettleRevision(platform, pass, doc, r, input, revs, first);
      assert after.effects == pass.effects + guard + ruled.effects;
      var k := |pass.effects|;
      forall i | 0 <= i < |after.effects| && (after.effects[i].Write? || after.effects[i].Remove?)
        ensures !UnsavedAt(platform, input.unsaved, after.effects[i].path)
      {
        if i >= k + |guard| { assert after.effects[i] == ruled.effects[i - k - |guard|]; }
        else if i >= k { assert after.effects[i] == guard[i - k]; }
        else { assert after.effects[i] == pass.effects[i]; }
      }
    }
  }

  lemma SettlePulledAvoidsUnsaved(platform: Platform, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires AvoidsUnsaved(platform, input.unsaved, pass.effects)
    ensures AvoidsUnsaved(platform, input.unsaved, SettlePulled(platform, pass, revisions, input, revs, first).effects)
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleAvoidsUnsaved(platform, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettlePulledAvoidsUnsaved(platform, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryAvoidsUnsaved(platform: Platform, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires AvoidsUnsaved(platform, input.unsaved, pass.effects)
    ensures AvoidsUnsaved(platform, input.unsaved, RetryWaiting(platform, pass, docs, input, revs, first).effects)
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        SettleAvoidsUnsaved(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryAvoidsUnsaved(platform, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryAvoidsUnsaved(platform, pass, docs[1..], input, revs, first);
      }
    }
  }

  // The push only persists the journal and commits.
  lemma PushTouchesNoFile(platform: Platform, journal: Journal, input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures forall e | e in OnPush(platform, journal, input, revs).1 :: !e.Write? && !e.Remove? && !e.Move?
  {
    var push := OnPush(platform, journal, input, revs);
    PushCommitsSealedPersisted(platform, journal, input, revs);
    assert push.1[0] == PersistJournal(push.0);
    assert forall i | 1 <= i < |push.1| :: push.1[i].Commit?;
    forall e | e in push.1 ensures !e.Write? && !e.Remove? && !e.Move? {
      var i := var i :| 0 <= i < |push.1| && push.1[i] == e; i;
    }
  }

  lemma OnRoundAvoidsUnsaved(platform: Platform, journal: Journal, pulled: seq<Revision>, cursor': nat, anchor': Option<RevId>,
                             input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures AvoidsUnsaved(platform, input.unsaved, OnRound(platform, journal, pulled, cursor', anchor', input, revs).1)
  {
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    RetryAvoidsUnsaved(platform, start, WaitingRows(journal.documents), input, revs, first);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    SettlePulledAvoidsUnsaved(platform, retried, pulled, input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    var push := OnPush(platform, read, input', revs);
    PushTouchesNoFile(platform, read, input', revs);
    var effects := settled.effects + push.1;
    var k := |settled.effects|;
    forall i | 0 <= i < |effects| && (effects[i].Write? || effects[i].Remove?)
      ensures !UnsavedAt(platform, input.unsaved, effects[i].path)
    {
      if i >= k { assert effects[i] == push.1[i - k]; assert push.1[i - k] in push.1; }
      else { assert effects[i] == settled.effects[i]; }
    }
  }

  // The round's effects avoid unsaved text.
  lemma RoundAvoidsUnsaved(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures AvoidsUnsaved(pre.devices[d].platform, input.unsaved, RoundStepOf(pre, d, input, revs).effects)
  {
    var device := pre.devices[d];
    var journal := device.journal;
    var feed := pre.server.feed;
    var behind := journal.cursor < |feed|;
    var pulled := if behind then Revisions(pre.server, feed[journal.cursor..]) else [];
    var cursor' := if behind then |feed| else journal.cursor;
    var anchor' := if behind then Some(feed[|feed| - 1]) else journal.anchor;
    if forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs {
      OnRoundAvoidsUnsaved(device.platform, journal, pulled, cursor', anchor', input, revs);
    }
  }

  lemma RoundG2UnsavedSafe(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input)
    ensures G2_UnsavedSafe(RoundStepOf(pre, d, input, revs))
  {
    var device := pre.devices[d];
    var step := RoundStepOf(pre, d, input, revs);
    RoundAvoidsUnsaved(pre, d, input, revs);
    assert step.event == SyncRound(d) && step.pre == pre;
    var effects := step.effects;
    forall effect | effect in effects && (effect.Write? || effect.Remove?)
      ensures !(effect.Write? && HasUnsavedEdits(device, effect.path))
      ensures !(effect.Remove? && HasUnsavedEdits(device, effect.path))
    {
      var i := var i :| 0 <= i < |effects| && effects[i] == effect; i;
      UnsavedSeen(device, input.unsaved, effect.path);
    }
  }

  // ---------------------------------------------------------------------
  // DisksFollowEffects: every effect has an outcome on every disk
  // (EffectsCanTake), so the round's disk is its effects' result
  // ---------------------------------------------------------------------

  // As Witnesses.dfy's EffectCanTake (a spec module this one cannot reach):
  // a create that applies gets a fresh identity (FreshIdentityExists).
  lemma EffectCanTake(platform: Platform, disk: map<Path, DiskFile>, effect: Effect)
    ensures exists disk' :: EffectTakes(platform, disk, effect, disk')
  {
    match effect
    case Write(_, path, content, kind, precondition) =>
      if precondition.Some? {
        if exists q :: Holds(platform, disk, q, path, precondition.value) {
          var q := var q :| Holds(platform, disk, q, path, precondition.value); q;
          assert EffectTakes(platform, disk, effect, disk[q := DiskFile(content, kind, disk[q].identity)]);
        } else {
          assert EffectTakes(platform, disk, effect, disk);
        }
      } else if FreeOn(platform, disk, path) {
        var used := set q | q in disk :: disk[q].identity;
        FreshIdentityExists(used);
        var identity: FileIdentity := var identity: FileIdentity :| identity !in used; identity;
        assert forall q :: q in disk ==> disk[q].identity in used;
        assert EffectTakes(platform, disk, effect, disk[path := DiskFile(content, kind, identity)]);
      } else {
        assert EffectTakes(platform, disk, effect, disk);
      }
    case Remove(_, path, expected) =>
      if exists q :: Holds(platform, disk, q, path, expected) {
        var q := var q :| Holds(platform, disk, q, path, expected); q;
        assert EffectTakes(platform, disk, effect, disk - {q});
      } else {
        assert EffectTakes(platform, disk, effect, disk);
      }
    case Move(_, from, to, expected) =>
      if exists q :: MovableTo(platform, disk, q, from, to, expected) {
        var q := var q :| MovableTo(platform, disk, q, from, to, expected); q;
        assert EffectTakes(platform, disk, effect, (disk - {q})[to := disk[q]]);
      } else {
        assert EffectTakes(platform, disk, effect, disk);
      }
    case _ =>
      assert EffectTakes(platform, disk, effect, disk);
  }

  // Effects in order have an outcome on every disk.
  lemma EffectsCanTake(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>)
    ensures exists disk' :: EffectsTake(platform, disk, effects, disk')
    decreases |effects|
  {
    if |effects| == 0 {
      assert EffectsTake(platform, disk, effects, disk);
    } else {
      EffectCanTake(platform, disk, effects[0]);
      var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, effects[0], mid); mid;
      EffectsCanTake(platform, mid, effects[1..]);
      var disk': map<Path, DiskFile> := var disk': map<Path, DiskFile> :| EffectsTake(platform, mid, effects[1..], disk'); disk';
      assert EffectsTake(platform, disk, effects, disk');
    }
  }

  lemma RoundDisksFollowEffects(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures DisksFollowEffects(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    var device := pre.devices[d];
    EffectsCanTake(device.platform, device.disk, step.effects);
    assert step.post.devices[d].disk == DiskAfter(device.platform, device.disk, step.effects);
    assert EffectsTake(device.platform, device.disk, step.effects, step.post.devices[d].disk);
  }

  // ---------------------------------------------------------------------
  // Toward G3_DeleteSeen: the round records a user's delete only where the
  // binding's file is missing from the listing the rule read
  // ---------------------------------------------------------------------

  // A row the step left unbound as the user's delete was one already, or
  // its file was missing from `listing` (RecordMissing).
  ghost predicate DeleteSeenRow(platform: Platform, listing: Listing, before: Document, after: Document) {
    (after.binding.None? && after.absence == UserDeleted) ==>
      (before.binding.None? && before.absence == UserDeleted)
      || (before.binding.Some? && !Listed(platform, listing, before.binding.value.spelling))
  }

  // The apply never records a user's delete.
  lemma ApplyRecordsNoDelete(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var after := ApplyRevision(platform, doc, document, r, input, bound, claims, rev).document;
      after.binding.None? && after.absence == UserDeleted ==> document.binding.None? && document.absence == UserDeleted
  {}

  // Nor does moving aside: W(a) keeps the binding and W(b) releases it.
  lemma MoveRowsRecordNoDelete(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, revs: FreshRevs)
    requires documents.Keys <= revs.Keys
    ensures var rows := MoveRows(platform, documents, doc, moves, revs);
      rows.Keys == documents.Keys
      && forall e | e in documents :: rows[e].binding.None? && rows[e].absence == UserDeleted
                                      ==> documents[e].binding.None? && documents[e].absence == UserDeleted
    decreases |moves|
  {
    if moves != [] { MoveRowsRecordNoDelete(platform, documents, doc, moves[1..], revs); }
  }

  // The rule records a user's delete only of a row whose file is missing
  // from the listing it read.
  lemma {:isolate_assertions} RuleDeleteSeen(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      ruled.documents.Keys == documents.Keys
      && forall e | e in documents :: DeleteSeenRow(platform, input.listing, documents[e], ruled.documents[e])
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    ApplyRecordsNoDelete(platform, doc, document, r, input, BoundNames(documents), ApplyClaims(documents, first), revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var aside := Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), way, r.path);
      if aside.Some? {
        MoveRowsRecordNoDelete(platform, documents, doc, aside.value, revs);
        var moved := MoveRows(platform, documents, doc, aside.value, revs);
        var ruled := PathRule(platform, documents, doc, r, input, revs, first);
        assert ruled == ClearWay(platform, documents, doc, r, input, revs);
        var cleared := ClearRows(platform, documents, doc, r, input, aside.value, revs);
        var recorded := RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs);
        if ruled.documents == cleared {
          forall e | e in documents ensures DeleteSeenRow(platform, input.listing, documents[e], ruled.documents[e]) {
            if e != doc {
              assert ruled.documents[e] == recorded[e];
              if MissingInTheWay(platform, input.listing, documents, doc, e, r.path) && moved[e].binding.Some? && e in revs {
                assert MissingIn(platform, input.listing, documents[e]);
              } else {
                assert recorded[e] == moved[e];
              }
            }
          }
        }
      }
    }
  }

  // An effect that unlists `s`: it removes the file at `s`, or moves it
  // away (under F).
  ghost predicate Unlists(platform: Platform, effect: Effect, s: Path) {
    (effect.Remove? && SameF(platform, effect.path, s)) || (effect.Move? && SameF(platform, effect.from, s))
  }

  // The round's listing keeps every listed name no effect unlists.
  lemma ListingEffectKeepsListed(platform: Platform, listing: Listing, effect: Effect, s: Path)
    requires Listed(platform, listing, s) && !Unlists(platform, effect, s)
    ensures Listed(platform, ListingAfterEffect(platform, listing, effect), s)
  {
    var k := var k :| k in listing && SameF(platform, k, s); k;
    if Distinct(platform, listing) {
      var after := ListingAfterEffect(platform, listing, effect);
      match effect
      case Remove(_, path, _) =>
        if Listed(platform, listing, path) {
          var q := ListedAt(platform, listing, path);
          if q == k { SameFIsEquivalence(platform, path, q, s); }
          assert k in after;
        }
      case Move(_, from, to, _) =>
        if Listed(platform, listing, from) {
          var q := ListedAt(platform, listing, from);
          if q == k { SameFIsEquivalence(platform, from, q, s); }
          assert k in after;
        }
      case Write(_, path, content, kind, precondition) =>
        assert k in after;
      case _ =>
    }
  }

  lemma ListingAfterKeepsListed(platform: Platform, listing: Listing, effects: seq<Effect>, s: Path)
    requires Listed(platform, listing, s)
    requires forall i | 0 <= i < |effects| :: !Unlists(platform, effects[i], s)
    ensures Listed(platform, ListingAfter(platform, listing, effects), s)
    decreases |effects|
  {
    if |effects| > 0 {
      ListingEffectKeepsListed(platform, listing, effects[0], s);
      ListingAfterKeepsListed(platform, ListingAfterEffect(platform, listing, effects[0]), effects[1..], s);
    }
  }

  // The apply unlists only the document's own file or a file no row is
  // bound to (an untracked file it moves aside).
  lemma ApplyUnlistsOnlyOwn(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, s: Path)
    requires ListingDistinct(platform, input.listing)
    requires exists e | e in ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects :: Unlists(platform, e, s)
    ensures (document.binding.Some? && SameF(platform, document.binding.value.spelling, s)) || !BoundName(platform, bound, s)
  {}

  // A row moved aside is bound to the copy (W(a)) or to nothing (W(b)).
  lemma MovedAsideBinding(document: Document, to: Path, rev: RevId)
    requires document.binding.Some?
    ensures var row := MovedAside(document, to, rev);
      row.binding.None? || row.binding.value.spelling == to
  {}

  // Where the rule clears the way, it unlists only the document's own file,
  // a file no row is bound to, or the file of a row it moves aside, whose
  // binding then changes (to the copy, or none).
  lemma {:isolate_assertions} ClearWayUnlistsOnlyMoved(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, s: Path)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires exists effect | effect in ClearWay(platform, documents, doc, r, input, revs).effects :: Unlists(platform, effect, s)
    ensures var rows := ClearWay(platform, documents, doc, r, input, revs).documents;
      (documents[doc].binding.Some? && SameF(platform, documents[doc].binding.value.spelling, s))
      || !BoundName(platform, BoundNames(documents), s)
      || exists e :: e in documents && e != doc && FileOf(platform, documents, s, e) && e in rows
           && (rows[e].binding.None? || rows[e].binding.value.spelling != documents[e].binding.value.spelling)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      // The rule defers: one report, which unlists nothing.
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      return;
    }
    if (documents[doc].binding.Some? && SameF(platform, documents[doc].binding.value.spelling, s))
       || !BoundName(platform, BoundNames(documents), s) {
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    var effect := var effect :| effect in ruled.effects && Unlists(platform, effect, s); effect;
    var t := var t :| t in BoundNames(documents) && SameF(platform, t, s); t;
    var e := var e :| e in documents && documents[e].binding.Some? && documents[e].binding.value.spelling == t; e;
    assert FileOf(platform, documents, s, e);
    if effect in arrive {
      // The arrival unlists only the document's own file (Keeps is OwnFile).
      assert keep.Some?;
      assert false;
    }
    var i := var i :| 0 <= i < |front| && front[i] == effect; i;
    var q := moves[i].0;
    SameFIsEquivalence(platform, t, s, q);
    assert FileOf(platform, documents, q, e);
    assert e != doc;
    MoveRowsRow(platform, documents, doc, moves, revs, input.listing, e);
    var moved := MoveRows(platform, documents, doc, moves, revs);
    assert moved[e] == MovedAside(documents[e], moves[i].1, revs[e]);
    assert t in avoid;
    assert !SameF(platform, t, moves[i].1);
    SameFIsEquivalence(platform, t, t, t);
    assert ruled.documents == ClearRows(platform, documents, doc, r, input, moves, revs);
    var recorded := RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs);
    assert e in moved && e in recorded;
    assert ruled.documents[e] == recorded[e];
    var row := ruled.documents[e];
    MovedAsideBinding(documents[e], moves[i].1, revs[e]);
    assert recorded[e] == moved[e] || recorded[e].binding.None?;
    assert row.binding.None? || row.binding.value.spelling != t;
    assert e in ruled.documents && e != doc && FileOf(platform, documents, s, e)
           && (row.binding.None? || row.binding.value.spelling != documents[e].binding.value.spelling);
  }

  // The rule unlists only the document's own file, a file no row is bound
  // to, or the file of another row whose binding it changes.
  lemma RuleUnlistsOnlyChanged(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, s: Path)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires exists effect | effect in PathRule(platform, documents, doc, r, input, revs, first).effects :: Unlists(platform, effect, s)
    ensures var rows := PathRule(platform, documents, doc, r, input, revs, first).documents;
      (documents[doc].binding.Some? && SameF(platform, documents[doc].binding.value.spelling, s))
      || !BoundName(platform, BoundNames(documents), s)
      || exists e :: e in documents && e != doc && FileOf(platform, documents, s, e) && e in rows
           && (rows[e].binding.None? || rows[e].binding.value.spelling != documents[e].binding.value.spelling)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      assert ruled.effects == applied.effects;
      ApplyUnlistsOnlyOwn(platform, doc, document, r, input, bound, claims, revs[doc], s);
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
    } else {
      assert ruled == ClearWay(platform, documents, doc, r, input, revs);
      ClearWayUnlistsOnlyMoved(platform, documents, doc, r, input, revs, s);
    }
  }

  // The apply binds its document only at a name no other row is bound to,
  // so no two rows end bound to one name (NeverJoinedRows).
  lemma ApplyKeepsNeverJoined(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, claims: Claims, rev: RevId)
    requires doc in documents && ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    ensures var applied := ApplyRevision(platform, doc, documents[doc], r, input, BoundNames(documents), claims, rev);
      NeverJoinedRows(platform, documents[doc := applied.document])
  {
    var document := documents[doc];
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), claims, rev);
    var rows := documents[doc := applied.document];
    forall e1, e2 | e1 in rows && e2 in rows && e1 != e2 && rows[e1].binding.Some? && rows[e2].binding.Some?
      ensures !SameF(platform, rows[e1].binding.value.spelling, rows[e2].binding.value.spelling)
    {
      if e1 == doc || e2 == doc {
        var other := if e1 == doc then e2 else e1;
        assert documents[other].binding.value.spelling in BoundNames(documents);
        SameFIsEquivalence(platform, rows[e1].binding.value.spelling, rows[e2].binding.value.spelling, rows[e1].binding.value.spelling);
      }
    }
  }

  // Where the rule clears the way with `moves`, another row ends moved to a
  // copy, unbound, or bound as it was; never at the head's name.
  ghost predicate ClearedRow(platform: Platform, documents: map<DocId, Document>, moves: seq<(Path, Path, Hash)>, e: DocId, row: Document) {
    e in documents && documents[e].binding.Some? && row.binding.Some?
    && ((exists i | 0 <= i < |moves| :: row.binding.value.spelling == moves[i].1 && FileOf(platform, documents, moves[i].0, e))
        || (row.binding == documents[e].binding && forall i | 0 <= i < |moves| :: !FileOf(platform, documents, moves[i].0, e)))
  }

  lemma {:isolate_assertions} ClearWayRow(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs,
                                          keep: Option<Path>, moves: seq<(Path, Path, Hash)>, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires ClearsWith(platform, documents, doc, r, input, keep, moves)
    requires var rows := ClearRows(platform, documents, doc, r, input, moves, revs);
      e in rows && e != doc && rows[e].binding.Some?
    ensures var rows := ClearRows(platform, documents, doc, r, input, moves, revs);
      ClearedRow(platform, documents, moves, e, rows[e]) && !SameF(platform, rows[e].binding.value.spelling, r.path)
  {
    var document := documents[doc];
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    AsideCovers(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    var moved := MoveRows(platform, documents, doc, moves, revs);
    var rows := ClearRows(platform, documents, doc, r, input, moves, revs);
    var recorded := RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs);
    MoveRowsRecordNoDelete(platform, documents, doc, moves, revs);
    assert rows[e] == recorded[e];
    MoveRowsRow(platform, documents, doc, moves, revs, input.listing, e);
    assert recorded[e] == moved[e];
    if exists i | 0 <= i < |moves| :: FileOf(platform, documents, moves[i].0, e) {
      var i := var i :| 0 <= i < |moves| && FileOf(platform, documents, moves[i].0, e); i;
      MovedAsideBinding(documents[e], moves[i].1, revs[e]);
      assert !CollideF(platform, moves[i].1, r.path);
    } else {
      assert moved[e] == documents[e];
      var t := documents[e].binding.value.spelling;
      if SameF(platform, t, r.path) {
        assert CollideF(platform, t, r.path);
        if Listed(platform, input.listing, t) {
          var k := ListedAt(platform, input.listing, t);
          SameFIsEquivalence(platform, k, t, r.path);
          assert CollideF(platform, k, r.path);
          if keep == Some(k) {
            SameFIsEquivalence(platform, document.binding.value.spelling, k, t);
            assert false;
          }
          assert k in way;
          var i := var i :| 0 <= i < |moves| && moves[i].0 == k; i;
          assert FileOf(platform, documents, moves[i].0, e);
          assert false;
        } else {
          assert MissingInTheWay(platform, input.listing, documents, doc, e, r.path);
          assert false;
        }
      }
    }
  }

  // Two other rows cleared that way are not bound to one name: copies
  // collide with nothing bound and with each other, and rows left as they
  // were are not joined.
  lemma {:isolate_assertions} ClearedRowsApart(platform: Platform, documents: map<DocId, Document>, avoid: set<Path>, moves: seq<(Path, Path, Hash)>,
                                               e1: DocId, e2: DocId, row1: Document, row2: Document)
    requires NeverJoinedRows(platform, documents) && BoundNames(documents) <= avoid && e1 != e2
    requires forall i | 0 <= i < |moves| :: forall t | t in avoid :: !SameF(platform, t, moves[i].1)
    requires forall i, j | 0 <= i < j < |moves| :: moves[i].0 != moves[j].0 && !CollideF(platform, moves[i].1, moves[j].1)
    requires ClearedRow(platform, documents, moves, e1, row1) && ClearedRow(platform, documents, moves, e2, row2)
    ensures !SameF(platform, row1.binding.value.spelling, row2.binding.value.spelling)
  {
    var s1 := row1.binding.value.spelling;
    var s2 := row2.binding.value.spelling;
    var t1 := documents[e1].binding.value.spelling;
    var t2 := documents[e2].binding.value.spelling;
    assert t1 in BoundNames(documents) && t2 in BoundNames(documents);
    if SameF(platform, s1, s2) {
      SameFIsEquivalence(platform, s1, s2, s1);
      if exists i | 0 <= i < |moves| :: s1 == moves[i].1 && FileOf(platform, documents, moves[i].0, e1) {
        var i := var i :| 0 <= i < |moves| && s1 == moves[i].1 && FileOf(platform, documents, moves[i].0, e1); i;
        if exists j | 0 <= j < |moves| :: s2 == moves[j].1 && FileOf(platform, documents, moves[j].0, e2) {
          var j := var j :| 0 <= j < |moves| && s2 == moves[j].1 && FileOf(platform, documents, moves[j].0, e2); j;
          if i == j {
            SameFIsEquivalence(platform, t1, moves[i].0, t2);
          } else if i < j {
            assert !CollideF(platform, moves[i].1, moves[j].1);
          } else {
            assert !CollideF(platform, moves[j].1, moves[i].1);
            SameFIsEquivalence(platform, s2, s1, s2);
          }
        } else {
          assert row2.binding == documents[e2].binding;
          assert !SameF(platform, t2, moves[i].1);
          SameFIsEquivalence(platform, s2, s1, s2);
        }
      } else if exists j | 0 <= j < |moves| :: s2 == moves[j].1 && FileOf(platform, documents, moves[j].0, e2) {
        var j := var j :| 0 <= j < |moves| && s2 == moves[j].1 && FileOf(platform, documents, moves[j].0, e2); j;
        assert row1.binding == documents[e1].binding;
        assert !SameF(platform, t1, moves[j].1);
      } else {
        assert row1.binding == documents[e1].binding && row2.binding == documents[e2].binding;
      }
    }
  }

  // Where the rule clears the way, no two rows end bound to one name: the
  // head takes its name, every row bound in its way moves to a copy that
  // collides with nothing, and a row bound there whose file is missing
  // records the user's delete.
  lemma ClearWayKeepsNeverJoined(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    ensures NeverJoinedRows(platform, ClearWay(platform, documents, doc, r, input, revs).documents)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      // The rule defers: only the document's ahead changes.
      assert forall e | e in ruled.documents :: e in documents && ruled.documents[e].binding == documents[e].binding;
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    var rows := ruled.documents;
    assert rows == ClearRows(platform, documents, doc, r, input, moves, revs);
    assert rows[doc].binding.value.spelling == r.path;
    forall e1, e2 | e1 in rows && e2 in rows && e1 != e2 && rows[e1].binding.Some? && rows[e2].binding.Some?
      ensures !SameF(platform, rows[e1].binding.value.spelling, rows[e2].binding.value.spelling)
    {
      if e1 == doc {
        ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e2);
        SameFIsEquivalence(platform, r.path, rows[e2].binding.value.spelling, r.path);
      } else if e2 == doc {
        ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e1);
      } else {
        ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e1);
        ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e2);
        ClearedRowsApart(platform, documents, avoid, moves, e1, e2, rows[e1], rows[e2]);
      }
    }
  }

  lemma RuleKeepsNeverJoined(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    ensures NeverJoinedRows(platform, PathRule(platform, documents, doc, r, input, revs, first).documents)
  {
    var document := documents[doc];
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, BoundNames(documents), claims, revs[doc]);
    ApplyKeepsNeverJoined(platform, documents, doc, r, input, claims, revs[doc]);
    if HeldForName(document, applied, r) && !UnsavedCollides(platform, input.unsaved, r.path) {
      ClearWayKeepsNeverJoined(platform, documents, doc, r, input, revs);
    }
  }

  // ---------------------------------------------------------------------
  // Toward G3_DeleteSeen: a row the step binds is listed at its name after
  // the step's effects, or kept the unlisted name it had
  // ---------------------------------------------------------------------

  // A row after the step is bound at a name the listing after the effects
  // lists, or at the name it had before, which the listing before did not
  // list (a file already missing). Only while the listing stays distinct:
  // the round settles nothing past a listing that is not.
  ghost predicate ListedOrStale(platform: Platform, listing: Listing, listing': Listing, before: Document, after: Document) {
    Distinct(platform, listing') && after.binding.Some? ==>
      Listed(platform, listing', after.binding.value.spelling)
      || (before.binding.Some? && before.binding.value.spelling == after.binding.value.spelling
          && !Listed(platform, listing, after.binding.value.spelling))
  }

  // A listing that is not distinct stays as it is.
  lemma ListingAfterFrozen(platform: Platform, listing: Listing, effects: seq<Effect>)
    requires !Distinct(platform, listing)
    ensures ListingAfter(platform, listing, effects) == listing
    decreases |effects|
  {
    if |effects| > 0 { ListingAfterFrozen(platform, listing, effects[1..]); }
  }

  // A write creates the file where none is listed, and overwrites a listed
  // one in place: either way its name is listed after it.
  lemma WriteLists(platform: Platform, listing: Listing, effect: Effect)
    requires effect.Write? && Distinct(platform, ListingAfterEffect(platform, listing, effect))
    requires effect.precondition.None? || Listed(platform, listing, effect.path)
    ensures Listed(platform, ListingAfterEffect(platform, listing, effect), effect.path)
  {
    if !Distinct(platform, listing) {
      assert ListingAfterEffect(platform, listing, effect) == listing;
    } else if Listed(platform, listing, effect.path) {
      var k := ListedAt(platform, listing, effect.path);
      assert k in ListingAfterEffect(platform, listing, effect);
    } else {
      SameFIsEquivalence(platform, effect.path, effect.path, effect.path);
      assert effect.path in ListingAfterEffect(platform, listing, effect);
    }
  }

  // A move of a listed file lists its destination.
  lemma MoveLists(platform: Platform, listing: Listing, effect: Effect)
    requires effect.Move? && Distinct(platform, ListingAfterEffect(platform, listing, effect))
    requires Listed(platform, listing, effect.from)
    ensures Listed(platform, ListingAfterEffect(platform, listing, effect), effect.to)
  {
    if !Distinct(platform, listing) {
      assert ListingAfterEffect(platform, listing, effect) == listing;
    } else {
      SameFIsEquivalence(platform, effect.to, effect.to, effect.to);
      assert effect.to in ListingAfterEffect(platform, listing, effect);
    }
  }

  lemma ListingAfterOne(platform: Platform, listing: Listing, e1: Effect)
    ensures ListingAfter(platform, listing, [e1]) == ListingAfterEffect(platform, listing, e1)
  {
    assert [e1][1..] == [];
  }

  lemma ListingAfterTwo(platform: Platform, listing: Listing, e1: Effect, e2: Effect)
    ensures ListingAfter(platform, listing, [e1, e2]) == ListingAfterEffect(platform, ListingAfterEffect(platform, listing, e1), e2)
    ensures Distinct(platform, ListingAfter(platform, listing, [e1, e2])) ==> Distinct(platform, ListingAfterEffect(platform, listing, e1))
  {
    assert [e1, e2][1..] == [e2];
    ListingAfterOne(platform, ListingAfterEffect(platform, listing, e1), e2);
    var mid := ListingAfterEffect(platform, listing, e1);
    if !Distinct(platform, mid) { assert ListingAfterEffect(platform, mid, e2) == mid; }
  }

  // The head after the apply's effects of a document with no file here:
  // created, adopted or moved in at the revision's name, or held.
  lemma CreateHeadListed(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing) && document.binding.None?
    ensures var applied := Create(platform, doc, document, r, input, bound, claims, rev);
      ListedOrStale(platform, input.listing, ListingAfter(platform, input.listing, applied.effects), document, applied.document)
  {
    var applied := Create(platform, doc, document, r, input, bound, claims, rev);
    var listing' := ListingAfter(platform, input.listing, applied.effects);
    if |applied.effects| == 1 {
      ListingAfterOne(platform, input.listing, applied.effects[0]);
      if Distinct(platform, listing') && applied.effects[0].Write? { WriteLists(platform, input.listing, applied.effects[0]); }
    } else if |applied.effects| == 2 {
      ListingAfterTwo(platform, input.listing, applied.effects[0], applied.effects[1]);
      if Distinct(platform, listing') && applied.effects[1].Write? {
        WriteLists(platform, ListingAfterEffect(platform, input.listing, applied.effects[0]), applied.effects[1]);
      }
    } else if applied.document.binding.Some? {
      // Adoption: the untracked file at the name is the document's.
      assert applied.effects == [] && r.path in input.listing;
      SameFIsEquivalence(platform, r.path, r.path, r.path);
    }
  }

  // The head after the apply's effects is listed at its binding, or kept
  // the unlisted name it had.
  lemma {:isolate_assertions} ApplyHeadListed(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      ListedOrStale(platform, input.listing, ListingAfter(platform, input.listing, applied.effects), document, applied.document)
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    var listing' := ListingAfter(platform, input.listing, applied.effects);
    if !Newer(document, r) || SettlesIdentical(platform, document, r, input) || Acknowledges(document, r) {
      assert applied.effects == [];
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreateHeadListed(platform, doc, Revived(document), r, input, bound, claims, rev);
      }
    } else if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if |applied.effects| == 1 {
        ListingAfterOne(platform, input.listing, applied.effects[0]);
        if Distinct(platform, listing') && applied.effects[0].Write? {
          assert read.Some?;
          WriteLists(platform, input.listing, applied.effects[0]);
        }
      } else if |applied.effects| == 2 {
        ListingAfterTwo(platform, input.listing, applied.effects[0], applied.effects[1]);
        var mid := ListingAfterEffect(platform, input.listing, applied.effects[0]);
        if Distinct(platform, listing') {
          assert read.Some? && applied.effects[0].Write? && applied.effects[0].precondition.None?;
          ListingEffectKeepsListed(platform, input.listing, applied.effects[0], spelling);
          WriteLists(platform, mid, applied.effects[1]);
        }
      }
    } else if !r.deleted {
      CreateHeadListed(platform, doc, document, r, input, bound, claims, rev);
    }
  }

  // Another row the rule leaves at its name stays listed there: the rule
  // unlists only the head's file, an untracked one, or that of a row it
  // rebinds (RuleUnlistsOnlyChanged), and no other row shares the name.
  lemma {:isolate_assertions} RuleKeepsOtherListed(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in documents && e != doc && e in ruled.documents && documents[e].binding.Some? && ruled.documents[e].binding.Some?
      && ruled.documents[e].binding.value.spelling == documents[e].binding.value.spelling
      && Listed(platform, input.listing, documents[e].binding.value.spelling)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      Listed(platform, ListingAfter(platform, input.listing, ruled.effects), documents[e].binding.value.spelling)
  {
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var s := documents[e].binding.value.spelling;
    forall i | 0 <= i < |ruled.effects| ensures !Unlists(platform, ruled.effects[i], s) {
      if Unlists(platform, ruled.effects[i], s) {
        assert ruled.effects[i] in ruled.effects;
        RuleUnlistsOnlyChanged(platform, documents, doc, r, input, revs, first, s);
        SameFIsEquivalence(platform, s, s, s);
        assert s in BoundNames(documents);
        if documents[doc].binding.Some? && SameF(platform, documents[doc].binding.value.spelling, s) {
          assert false;
        }
        var e' :| e' in documents && e' != doc && FileOf(platform, documents, s, e') && e' in ruled.documents
           && (ruled.documents[e'].binding.None? || ruled.documents[e'].binding.value.spelling != documents[e'].binding.value.spelling);
        if e' != e {
          SameFIsEquivalence(platform, documents[e'].binding.value.spelling, s, s);
          assert false;
        }
      }
    }
    ListingAfterKeepsListed(platform, input.listing, ruled.effects, s);
  }

  lemma ListingAfterSnoc(platform: Platform, listing: Listing, effects: seq<Effect>, last: Effect)
    ensures ListingAfter(platform, listing, effects + [last]) == ListingAfterEffect(platform, ListingAfter(platform, listing, effects), last)
    decreases |effects|
  {
    if |effects| == 0 {
      ListingAfterOne(platform, listing, last);
    } else {
      assert (effects + [last])[1..] == effects[1..] + [last];
      ListingAfterSnoc(platform, ListingAfterEffect(platform, listing, effects[0]), effects[1..], last);
    }
  }

  // Where the rule clears the way, the head ends listed at the revision's
  // name: its last effect writes the head there or moves its own file
  // there, which the moves aside before it leave listed.
  lemma {:isolate_assertions} ClearWayHeadListed(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      doc in ruled.documents
      && ListedOrStale(platform, input.listing, ListingAfter(platform, input.listing, ruled.effects), documents[doc], ruled.documents[doc])
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      ListingAfterOne(platform, input.listing, ruled.effects[0]);
      assert ruled.documents[doc].binding == document.binding;
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    assert ruled.documents[doc] == HeadRow(platform, document, r, input, revs[doc]);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    if !Distinct(platform, listing') { return; }
    var init := ruled.effects[..|ruled.effects| - 1];
    var last := ruled.effects[|ruled.effects| - 1];
    assert ruled.effects == init + [last];
    ListingAfterSnoc(platform, input.listing, init, last);
    var before := ListingAfter(platform, input.listing, init);
    if !Distinct(platform, before) { assert ListingAfterEffect(platform, before, last) == before; assert false; }
    var row := ArrivingRow(platform, document, r, input);
    if keep.Some? && row.binding.Some? && !(CollideF(platform, keep.value, r.path) && !SameF(platform, keep.value, r.path)) {
      // Its own file moves to the name: nothing before unlists it.
      var own := keep.value;
      assert last.Move? && last.from == own && last.to == r.path;
      assert own in input.listing;
      SameFIsEquivalence(platform, own, own, own);
      forall i | 0 <= i < |init| ensures !Unlists(platform, init[i], own) {
        if i < |front| {
          assert front[i].from == moves[i].0 && moves[i].0 in way && moves[i].0 != own;
          assert !SameF(platform, front[i].from, own);
        }
      }
      ListingAfterKeepsListed(platform, input.listing, init, own);
      MoveLists(platform, before, last);
    } else {
      assert last.Write? && last.path == r.path && last.precondition.None?;
      WriteLists(platform, before, last);
    }
  }

  lemma ListingAfterAppend(platform: Platform, listing: Listing, a: seq<Effect>, b: seq<Effect>)
    ensures ListingAfter(platform, listing, a + b) == ListingAfter(platform, ListingAfter(platform, listing, a), b)
    decreases |a|
  {
    if |a| == 0 {
      assert a + b == b;
    } else {
      assert (a + b)[0] == a[0] && (a + b)[1..] == a[1..] + b;
      ListingAfterAppend(platform, ListingAfterEffect(platform, listing, a[0]), a[1..], b);
    }
  }

  // The head's arrival removes or moves only its own listed file.
  lemma ArriveUnlistsOnlyOwn(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, effect: Effect)
    requires ListingDistinct(platform, input.listing)
    requires effect in ArriveOf(platform, doc, document, r, input)
    ensures var keep := Keeps(platform, document, r, input);
      (effect.Remove? ==> keep.Some? && effect.path == keep.value && keep.value in input.listing)
      && (effect.Move? ==> keep.Some? && effect.from == keep.value && keep.value in input.listing)
  {}

  // A row moved aside ends listed at its copy: its file moves there, the
  // moves before it leave that file listed, and nothing after unlists the
  // copy, which collides with no file the round listed.
  lemma {:isolate_assertions} ClearWayMovedListed(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs,
                                                  keep: Option<Path>, moves: seq<(Path, Path, Hash)>, i: nat)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    requires keep == Keeps(platform, documents[doc], r, input)
    requires Aside(platform, input.listing, BoundNames(documents) + input.unsaved, AllClaims(documents), InTheWay(platform, input.listing, r.path, keep), r.path) == Some(moves)
    requires i < |moves|
    ensures var effects := MoveEffects(platform, documents, doc, moves) + ArriveOf(platform, doc, documents[doc], r, input);
      Distinct(platform, ListingAfter(platform, input.listing, effects)) ==> Listed(platform, ListingAfter(platform, input.listing, effects), moves[i].1)
  {
    var document := documents[doc];
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    var effects := front + arrive;
    var listing' := ListingAfter(platform, input.listing, effects);
    if !Distinct(platform, listing') { return; }
    var c := moves[i].1;
    var q := moves[i].0;
    // Before the move: q stays listed.
    var head := front[..i];
    forall j | 0 <= j < |head| ensures !Unlists(platform, head[j], q) {
      assert head[j] == front[j] && front[j].from == moves[j].0;
      assert moves[j].0 in input.listing && moves[j].0 != q;
    }
    SameFIsEquivalence(platform, q, q, q);
    ListingAfterKeepsListed(platform, input.listing, head, q);
    // The move itself, and what follows.
    var tail := front[i + 1..] + arrive;
    assert effects == head + [front[i]] + tail;
    ListingAfterAppend(platform, input.listing, head + [front[i]], tail);
    ListingAfterSnoc(platform, input.listing, head, front[i]);
    var before := ListingAfter(platform, input.listing, head);
    var after := ListingAfterEffect(platform, before, front[i]);
    assert listing' == ListingAfter(platform, after, tail);
    if !Distinct(platform, after) { ListingAfterFrozen(platform, after, tail); assert false; }
    MoveLists(platform, before, front[i]);
    forall j | 0 <= j < |tail| ensures !Unlists(platform, tail[j], c) {
      if j < |moves| - i - 1 {
        assert tail[j] == front[i + 1 + j] && tail[j].from == moves[i + 1 + j].0;
        assert moves[i + 1 + j].0 in input.listing;
        assert !CollideF(platform, moves[i + 1 + j].0, c);
      } else {
        assert tail[j] in arrive;
        ArriveUnlistsOnlyOwn(platform, doc, document, r, input, tail[j]);
        if tail[j].Remove? || tail[j].Move? {
          assert !CollideF(platform, keep.value, c);
        }
      }
    }
    ListingAfterKeepsListed(platform, after, tail, c);
  }

  // Another row where the rule clears the way: moved to its copy, listed
  // there, or left in place.
  lemma {:isolate_assertions} ClearWayOtherListed(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires PathRule(platform, documents, doc, r, input, revs, first) == ClearWay(platform, documents, doc, r, input, revs)
    requires e in documents && e != doc
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents
      && ListedOrStale(platform, input.listing, ListingAfter(platform, input.listing, ruled.effects), documents[e], ruled.documents[e])
  {
    var document := documents[doc];
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    var before := documents[e];
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert ruled.documents[e] == before;
    } else {
      var moves := aside.value;
      assert ruled.documents == ClearRows(platform, documents, doc, r, input, moves, revs);
      MoveRowsRecordNoDelete(platform, documents, doc, moves, revs);
      assert e in ruled.documents;
    }
    var after := ruled.documents[e];
    if !Distinct(platform, listing') || after.binding.None? { return; }
    if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      var moves := aside.value;
      ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e);
      if exists i | 0 <= i < |moves| :: after.binding.value.spelling == moves[i].1 && FileOf(platform, documents, moves[i].0, e) {
        var i :| 0 <= i < |moves| && after.binding.value.spelling == moves[i].1 && FileOf(platform, documents, moves[i].0, e);
        assert ruled.effects == MoveEffects(platform, documents, doc, moves) + ArriveOf(platform, doc, document, r, input);
        ClearWayMovedListed(platform, documents, doc, r, input, revs, keep, moves, i);
        return;
      }
    }
    assert after.binding == before.binding;
    if Listed(platform, input.listing, before.binding.value.spelling) {
      RuleKeepsOtherListed(platform, documents, doc, r, input, revs, first, e);
    }
  }

  // Every row after the rule is listed at its binding after the rule's
  // effects, or kept the unlisted name it had.
  lemma {:isolate_assertions} RuleRowsListed(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      ruled.documents.Keys == documents.Keys
      && forall e | e in documents ::
           ListedOrStale(platform, input.listing, ListingAfter(platform, input.listing, ruled.effects), documents[e], ruled.documents[e])
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    var listing' := ListingAfter(platform, input.listing, ruled.effects);
    RuleDeleteSeen(platform, documents, doc, r, input, revs, first);
    forall e | e in documents
      ensures ListedOrStale(platform, input.listing, listing', documents[e], ruled.documents[e])
    {
      if !HeldForName(document, applied, r) || UnsavedCollides(platform, input.unsaved, r.path) {
        if e == doc {
          if !HeldForName(document, applied, r) {
            ApplyHeadListed(platform, doc, document, r, input, bound, claims, revs[doc]);
          } else {
            assert |ruled.effects| == 1;
            ListingAfterOne(platform, input.listing, ruled.effects[0]);
            assert listing' == input.listing;
            HeldKeepsBinding(platform, doc, document, r, input, bound, claims, revs[doc]);
          }
        } else if ruled.documents[e].binding.Some? && Listed(platform, input.listing, documents[e].binding.value.spelling) {
          RuleKeepsOtherListed(platform, documents, doc, r, input, revs, first, e);
        }
      } else {
        assert ruled == ClearWay(platform, documents, doc, r, input, revs);
        if e == doc {
          ClearWayHeadListed(platform, documents, doc, r, input, revs);
        } else {
          ClearWayOtherListed(platform, documents, doc, r, input, revs, first, e);
        }
      }
    }
  }

  // A revision held for its name changes no binding but a revived one's,
  // which it drops.
  lemma HeldKeepsBinding(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      HeldForName(document, applied, r) ==> applied.document.binding.None? || applied.document.binding == document.binding
  {}

  // ---------------------------------------------------------------------
  // G3_DeleteSeen over the round: the pass invariant
  // ---------------------------------------------------------------------

  // A row the round left unbound as the user's delete is new, was one
  // already, or was bound at a name the round's listing `listing0` did not
  // list.
  ghost predicate DeleteJustified(platform: Platform, listing0: Listing, rows0: map<DocId, Document>, e: DocId) {
    e !in rows0
    || (rows0[e].binding.None? && rows0[e].absence == UserDeleted)
    || (rows0[e].binding.Some? && !Listed(platform, listing0, rows0[e].binding.value.spelling))
  }

  // A bound row is listed in the pass's listing, or kept the name it had
  // before the round, which `listing0` did not list.
  ghost predicate BoundListed(platform: Platform, listing0: Listing, rows0: map<DocId, Document>, listing: Listing, e: DocId, row: Document) {
    row.binding.Some? ==>
      Listed(platform, listing, row.binding.value.spelling)
      || (e in rows0 && rows0[e].binding.Some? && rows0[e].binding.value.spelling == row.binding.value.spelling
          && !Listed(platform, listing0, row.binding.value.spelling))
  }

  ghost predicate PassG3(platform: Platform, listing0: Listing, rows0: map<DocId, Document>, pass: RoundPass) {
    var rows := pass.journal.documents;
    NeverJoinedRows(platform, rows)
    && (forall e | e in rows && rows[e].binding.None? && rows[e].absence == UserDeleted :: DeleteJustified(platform, listing0, rows0, e))
    && (Distinct(platform, pass.listing) ==> forall e | e in rows :: BoundListed(platform, listing0, rows0, pass.listing, e, rows[e]))
  }

  lemma PassG3Start(platform: Platform, listing0: Listing, journal: Journal, start: RoundPass)
    requires NeverJoinedRows(platform, journal.documents)
    requires start.journal.documents == journal.documents && start.listing == listing0
    ensures PassG3(platform, listing0, journal.documents, start)
  {}

  // Settling one revision keeps the invariant.
  lemma {:isolate_assertions} SettleKeepsG3(platform: Platform, listing0: Listing, rows0: map<DocId, Document>, pass: RoundPass, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires PassG3(platform, listing0, rows0, pass)
    ensures PassG3(platform, listing0, rows0, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    if !Distinct(platform, pass.listing) { return; }
    if r.path in input.outOfScope {
      if Newer(row, r) {
        var rows' := settled.journal.documents;
        assert rows' == documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))];
        assert forall e | e in rows' :: (e in documents && rows'[e].binding == documents[e].binding && rows'[e].absence == documents[e].absence)
                                        || (rows'[e].binding.None? && rows'[e].absence == Never);
        assert settled.listing == pass.listing;
        assert NeverJoinedRows(platform, rows');
      }
      return;
    }
    var rows := documents[doc := row];
    assert NeverJoinedRows(platform, rows);
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    assert settled.journal.documents == ruled.documents;
    assert settled.listing == ListingAfter(platform, pass.listing, ruled.effects);
    RuleKeepsNeverJoined(platform, rows, doc, r, inner, revs', first);
    RuleDeleteSeen(platform, rows, doc, r, inner, revs', first);
    RuleRowsListed(platform, rows, doc, r, inner, revs', first);
    forall e | e in rows
      ensures (ruled.documents[e].binding.None? && ruled.documents[e].absence == UserDeleted) ==> DeleteJustified(platform, listing0, rows0, e)
      ensures Distinct(platform, settled.listing) ==> BoundListed(platform, listing0, rows0, settled.listing, e, ruled.documents[e])
    {
      assert DeleteSeenRow(platform, pass.listing, rows[e], ruled.documents[e]);
      assert ListedOrStale(platform, pass.listing, settled.listing, rows[e], ruled.documents[e]);
      assert BoundListed(platform, listing0, rows0, pass.listing, e, rows[e]);
    }
  }

  lemma SettlePulledKeepsG3(platform: Platform, listing0: Listing, rows0: map<DocId, Document>, pass: RoundPass, revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires PassG3(platform, listing0, rows0, pass)
    ensures PassG3(platform, listing0, rows0, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsG3(platform, listing0, rows0, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettlePulledKeepsG3(platform, listing0, rows0, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryWaitingKeepsG3(platform: Platform, listing0: Listing, rows0: map<DocId, Document>, pass: RoundPass, docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires PassG3(platform, listing0, rows0, pass)
    ensures PassG3(platform, listing0, rows0, RetryWaiting(platform, pass, docs, input, revs, first))
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      var pass' := pass;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert PassG3(platform, listing0, rows0, cleared);
        SettleKeepsG3(platform, listing0, rows0, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        pass' := SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first);
      }
      RetryWaitingKeepsG3(platform, listing0, rows0, pass', docs[1..], input, revs, first);
    }
  }

  // The push changes no binding or absence of a row it found, and a row it
  // creates is bound.
  lemma PushKeepsDeletes(platform: Platform, journal: Journal, input: RoundInput, revs: FreshRevs, e: DocId)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    requires var rows := OnPush(platform, journal, input, revs).0.documents;
      e in rows && rows[e].binding.None? && rows[e].absence == UserDeleted
    ensures e in journal.documents && journal.documents[e].binding.None? && journal.documents[e].absence == UserDeleted
  {}

  // G3_DeleteSeen of the round: it records a user's delete of a bound row
  // only where the device's disk had no file at the binding's name.
  lemma RoundG3DeleteSeen(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && RoundInputOf(pre, d, input) && G5_NeverJoined(pre)
    ensures G3_DeleteSeen(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    var device := pre.devices[d];
    var platform := device.platform;
    var journal := device.journal;
    var rows0 := journal.documents;
    assert step.event == SyncRound(d) && step.pre == pre;
    if !(forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs) {
      assert step.post.devices[d].journal == journal;
      return;
    }
    var feed := pre.server.feed;
    var behind := journal.cursor < |feed|;
    var pulled := if behind then Revisions(pre.server, feed[journal.cursor..]) else [];
    var cursor' := if behind then |feed| else journal.cursor;
    var anchor' := if behind then Some(feed[|feed| - 1]) else journal.anchor;
    var start := RoundPass(journal.(intents := []), input.listing, [Pull(journal.cursor)], 0);
    var first := RoundClaims(platform, journal, input);
    var retried := RetryWaiting(platform, start, WaitingRows(journal.documents), input, revs, first);
    var settled := SettlePulled(platform, retried, pulled, input, revs, first);
    var read := settled.journal.(cursor := cursor', anchor := anchor');
    var push := OnPush(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
    assert step.post.devices[d].journal == push.0;
    PassG3Start(platform, input.listing, journal, start);
    RetryWaitingKeepsG3(platform, input.listing, rows0, start, WaitingRows(journal.documents), input, revs, first);
    SettlePulledKeepsG3(platform, input.listing, rows0, retried, pulled, input, revs, first);
    forall doc | RecordsUserDelete(step, d, doc)
      ensures !HasFile(device, rows0[doc].binding.value.spelling)
    {
      PushKeepsDeletes(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs, doc);
      assert DeleteJustified(platform, input.listing, rows0, doc);
      var s := rows0[doc].binding.value.spelling;
      if HasFile(device, s) {
        var q :| q in device.disk && SameF(platform, q, s);
        assert q in input.listing;
        assert false;
      }
    }
  }

  // ---------------------------------------------------------------------
  // G7_MoveKeepsContents (#1094): a move that took effect leaves its
  // content at its new name, unless a later effect of the round acts on it
  // there conditional on exactly that content (RoundMovesKeepContents)
  // ---------------------------------------------------------------------

  // A move that took effect on `mid` puts its content at `to`; the effects
  // after it keep it there unless one of them matched it there.
  lemma MoveArrivesOrMovesOn(platform: Platform, effects: seq<Effect>, disk': map<Path, DiskFile>, i: int,
                             mid: map<Path, DiskFile>, q: Path)
    requires 0 <= i < |effects| && effects[i].Move?
    requires EffectsTake(platform, mid, effects[i..], disk')
    requires MovableTo(platform, mid, q, effects[i].from, effects[i].to, effects[i].expected)
    ensures var moved := effects[i];
      (moved.to in disk' && disk'[moved.to].content == moved.expected)
      || exists j :: i < j < |effects| && MatchedBy(platform, effects[j], moved.to, moved.expected)
  {
    var moved := effects[i];
    var m1: map<Path, DiskFile> := var m1: map<Path, DiskFile> :|
      EffectTakes(platform, mid, effects[i..][0], m1) && EffectsTake(platform, m1, effects[i..][1..], disk'); m1;
    assert effects[i..][0] == moved;
    assert effects[i..][1..] == effects[i + 1..];
    var q' := var q' :| MovableTo(platform, mid, q', moved.from, moved.to, moved.expected)
      && m1 == (mid - {q'})[moved.to := mid[q']]; q';
    assert moved.to in m1 && m1[moved.to].content == moved.expected;
    if moved.to !in disk' || disk'[moved.to] != m1[moved.to] {
      EffectsChangeOnlyMatched(platform, m1, effects[i + 1..], disk', moved.to);
      var effect: Effect := var effect: Effect :| effect in effects[i + 1..]
        && MatchedBy(platform, effect, moved.to, m1[moved.to].content); effect;
      var k := var k :| 0 <= k < |effects[i + 1..]| && effects[i + 1..][k] == effect; k;
      assert effects[i + 1 + k] == effect;
    }
  }

  lemma RoundG7MoveKeepsContents(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices
    ensures G7_MoveKeepsContents(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    var platform := pre.devices[d].platform;
    RoundOnlyTouchesDevice(pre, d, input, revs);
    forall i, mid, q | 0 <= i < |step.effects| && step.effects[i].Move?
        && EffectsTake(platform, step.pre.devices[d].disk, step.effects[..i], mid)
        && EffectsTake(platform, mid, step.effects[i..], step.post.devices[d].disk)
        && MovableTo(platform, mid, q, step.effects[i].from, step.effects[i].to, step.effects[i].expected)
      ensures (exists k :: k in step.post.devices[d].disk && SameF(platform, k, step.effects[i].to)
                 && step.post.devices[d].disk[k].content == step.effects[i].expected)
              || RoundMovesOn(step, i)
    {
      var moved := step.effects[i];
      MoveArrivesOrMovesOn(platform, step.effects, step.post.devices[d].disk, i, mid, q);
      if moved.to in step.post.devices[d].disk && step.post.devices[d].disk[moved.to].content == moved.expected {
        assert SameF(platform, moved.to, moved.to);
      } else {
        var j := var j :| i < j < |step.effects| && MatchedBy(platform, step.effects[j], moved.to, moved.expected); j;
        assert RoundMovesOn(step, i);
      }
    }
    assert RoundMovesKeepContents(step);
  }
}
