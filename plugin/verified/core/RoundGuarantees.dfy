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
include "RoundClaims.dfy"

abstract module RoundGuarantees refines RoundClaimsCore {

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
  // content p had before all of them. Any effect sequence, so any prefix of
  // a round's effects (a crash cut, #1098).
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
  // after it keep it there unless one of them matched it there. It holds of
  // any effect sequence, so of any prefix of a round's effects too (a crash
  // that cut the round short, #1098).
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

  // ---------------------------------------------------------------------
  // G2_NoUntrackedDelete (#1094): where each binding's file came from
  // ---------------------------------------------------------------------

  // The effect writes, removes or moves a file at `s` (either end).
  ghost predicate Touches(platform: Platform, effect: Effect, s: Path) {
    (effect.Write? && SameF(platform, effect.path, s))
    || (effect.Remove? && SameF(platform, effect.path, s))
    || (effect.Move? && (SameF(platform, effect.from, s) || SameF(platform, effect.to, s)))
  }

  // How the apply leaves its row's binding: at a name an effect of its
  // own puts a tracked file at; at the name it had, untouched, having seen
  // what it saw or what the listing reads there; or adopting the listed
  // file at its name that holds exactly the live revision, untouched.
  ghost predicate AppliedOrigin(platform: Platform, listing: Listing, e: DocId, document: Document, r: Revision, after: Document, effects: seq<Effect>, adopt: bool)
    requires ListingDistinct(platform, listing)
  {
    after.binding.Some? ==>
      var s := after.binding.value.spelling;
      var seen := after.binding.value.seen;
      (exists effect :: effect in effects && PutsFor(platform, effect, e, s))
      || (document.binding.Some? && s == document.binding.value.spelling
          && (seen == document.binding.value.seen
              || (ListedRead(platform, listing, s).Some? && seen == ListedRead(platform, listing, s).value.0))
          && forall effect :: effect in effects ==> !Touches(platform, effect, s))
      || (adopt && !r.deleted && seen == r.content && ListedRead(platform, listing, s) == Some((r.content, r.kind))
          && forall effect :: effect in effects ==> !Touches(platform, effect, s))
  }

  // The effect writes or moves document `e`'s file to `p` (G5 (b)).
  ghost predicate PutsFor(platform: Platform, effect: Effect, e: DocId, p: Path) {
    (effect.Write? && effect.target == Some(e) && SameF(platform, effect.path, p))
    || (effect.Move? && effect.mover == Some(e) && SameF(platform, effect.to, p))
  }

  // A listed name is its own listed spelling.
  lemma ListedAtSelf(platform: Platform, listing: Listing, p: Path)
    requires ListingDistinct(platform, listing) && p in listing
    ensures Listed(platform, listing, p) && ListedAt(platform, listing, p) == p
  {
    assert SameF(platform, p, p);
  }

  // Create binds only at the head's name: written there, adopted there, or
  // not at all (the row keeps its binding and nothing is written).
  lemma {:isolate_assertions} CreateOrigin(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing) && !r.deleted
    ensures var applied := Create(platform, doc, document, r, input, bound, claims, rev);
      applied.document.binding.Some? ==>
        var s := applied.document.binding.value.spelling;
        (exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, s))
        || (applied.document.binding == document.binding
            && forall effect :: effect in applied.effects ==> !Touches(platform, effect, s))
        || (!r.deleted && applied.document.binding.value.seen == r.content
            && ListedRead(platform, input.listing, s) == Some((r.content, r.kind))
            && forall effect :: effect in applied.effects ==> !Touches(platform, effect, s))
  {
    var applied := Create(platform, doc, document, r, input, bound, claims, rev);
    assert SameF(platform, r.path, r.path);
    if UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path) {
    } else if FreeIn(platform, input.listing, r.path) {
      assert applied.effects[0] in applied.effects;
    } else if Adoptable(platform, document, input, r) {
      ListedAtSelf(platform, input.listing, r.path);
      assert applied.effects == [];
      assert applied.document.binding == Some(Binding(r.path, r.content, false, None));
      assert ListedRead(platform, input.listing, r.path) == Some(input.listing[r.path]);
      assert input.listing[r.path] == (r.content, r.kind);
    } else {
      var held := Colliders(platform, input.listing, r.path);
      if |held| == 1 && !BoundName(platform, bound, LeastPath(held))
         && !UnsavedCollides(platform, input.unsaved, LeastPath(held)) {
        var q := LeastPath(held);
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, q, r.path);
        if copy.Some? {
          var write := Write(Some(doc), r.path, r.content, r.kind, None);
          assert applied.effects == [Move(None, q, copy.value, input.listing[q].0), write];
          assert applied.document.binding.value.spelling == r.path;
          assert write in applied.effects && PutsFor(platform, write, doc, r.path);
        }
      }
    }
  }

  // The settlement of a concurrent edit binds where it was bound: written
  // there, or taking what the listing reads there.
  lemma {:isolate_assertions} SettleOrigin(platform: Platform, doc: DocId, document: Document, read: (Hash, Kind), r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    requires document.binding.Some? && document.base.Some?
    requires ListedRead(platform, input.listing, document.binding.value.spelling) == Some(read)
    ensures var applied := Settle(platform, doc, document, read, r, input, bound, claims, rev);
      AppliedOrigin(platform, input.listing, doc, document, r, applied.document, applied.effects, true)
  {
    var applied := Settle(platform, doc, document, read, r, input, bound, claims, rev);
    var spelling := document.binding.value.spelling;
    var b := document.base.value.content;
    var l := read.0;
    assert SameF(platform, spelling, spelling);
    if l == b && l == document.binding.value.seen {
      assert applied.effects[0] in applied.effects;
    } else if r.content == b {
    } else if l != b && read.1 == Note && r.kind == Note && Merge(b, l, r.content).Some? {
      assert applied.effects[0] in applied.effects;
    } else {
      var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, spelling, spelling);
      if copy.Some? {
        assert applied.effects[1] in applied.effects;
      }
    }
  }

  lemma {:isolate_assertions} ApplyOrigin(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      AppliedOrigin(platform, input.listing, doc, document, r, applied.document, applied.effects, true)
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    if !Newer(document, r) {
    } else if SettlesIdentical(platform, document, r, input) {
    } else if Acknowledges(document, r) {
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreateOrigin(platform, doc, Revived(document), r, input, bound, claims, rev);
      }
    } else if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      assert SameF(platform, spelling, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
      } else if r.deleted && read.None? {
      } else if Concurrent(document, read, r) {
        SettleOrigin(platform, doc, document, read.value, r, input, bound, claims, rev);
      } else if MovedAgainstChange(document, read, r) {
      } else if EditedAgainstDelete(document, read, r) {
      } else if !Clean(platform, document, read) && !r.deleted && read.Some?
              && document.base.Some? && document.base.value.rev == r.id {
      } else if !Clean(platform, document, read) {
      } else if r.deleted {
      } else if r.path == spelling {
        assert applied.effects[0] in applied.effects;
      }
    } else if r.deleted {
    } else {
      CreateOrigin(platform, doc, document, r, input, bound, claims, rev);
    }
  }

  // The apply touches no name another row is bound at: it writes and
  // removes only at its own binding, creates only where nothing is bound,
  // moves only an untracked file, and names copies away from every bound
  // name.
  lemma {:isolate_assertions} CreateLeavesOthers(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, s: Path)
    requires ListingDistinct(platform, input.listing) && s in bound
    ensures forall effect :: effect in Create(platform, doc, document, r, input, bound, claims, rev).effects ==> !Touches(platform, effect, s)
  {
    if !(UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path)) {
      assert !SameF(platform, s, r.path);
      if !FreeIn(platform, input.listing, r.path) && !Adoptable(platform, document, input, r) {
        var held := Colliders(platform, input.listing, r.path);
        if |held| == 1 && !BoundName(platform, bound, LeastPath(held)) {
          assert !SameF(platform, s, LeastPath(held));
        }
      }
    }
  }

  lemma {:isolate_assertions} SettleLeavesOthers(platform: Platform, doc: DocId, document: Document, read: (Hash, Kind), r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, s: Path)
    requires ListingDistinct(platform, input.listing) && s in bound
    requires document.binding.Some? && document.base.Some? && !SameF(platform, document.binding.value.spelling, s)
    ensures forall effect :: effect in Settle(platform, doc, document, read, r, input, bound, claims, rev).effects ==> !Touches(platform, effect, s)
  {}

  lemma {:isolate_assertions} ApplyLeavesOthers(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId, s: Path)
    requires ListingDistinct(platform, input.listing) && s in bound
    requires document.binding.Some? ==> !SameF(platform, document.binding.value.spelling, s)
    ensures forall effect :: effect in ApplyRevision(platform, doc, document, r, input, bound, claims, rev).effects ==> !Touches(platform, effect, s)
  {
    if !Newer(document, r) {
    } else if SettlesIdentical(platform, document, r, input) {
    } else if Acknowledges(document, r) {
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreateLeavesOthers(platform, doc, Revived(document), r, input, bound, claims, rev, s);
      }
    } else if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
      } else if r.deleted && read.None? {
      } else if Concurrent(document, read, r) {
        SettleLeavesOthers(platform, doc, document, read.value, r, input, bound, claims, rev, s);
      }
    } else if !r.deleted {
      CreateLeavesOthers(platform, doc, document, r, input, bound, claims, rev, s);
    }
  }

  // The arrival puts the head's file at its name for the document.
  lemma ArrivePutsHead(platform: Platform, doc: DocId, document: Document, a: Revision, own: Option<Path>)
    ensures exists effect :: effect in Arrive(platform, doc, document, a, own) && PutsFor(platform, effect, doc, a.path)
  {
    var effects := Arrive(platform, doc, document, a, own);
    assert SameF(platform, a.path, a.path);
    assert effects[|effects| - 1] in effects;
  }

  // ...and touches only the document's own file and the head's name.
  lemma ArriveTouchesOnly(platform: Platform, doc: DocId, document: Document, a: Revision, own: Option<Path>, s: Path)
    requires own.Some? ==> !SameF(platform, own.value, s)
    requires !SameF(platform, a.path, s)
    ensures forall effect :: effect in Arrive(platform, doc, document, a, own) ==> !Touches(platform, effect, s)
  {}

  lemma {:isolate_assertions} ClearWayOrigin(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents && e in ClearWay(platform, documents, doc, r, input, revs).documents
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      AppliedOrigin(platform, input.listing, e, documents[e], r, ruled.documents[e], ruled.effects, e == doc)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      assert ruled.documents[e].binding == documents[e].binding;
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    var rows := ruled.documents;
    assert rows == ClearRows(platform, documents, doc, r, input, moves, revs);
    if rows[e].binding.None? { return; }
    var s := rows[e].binding.value.spelling;
    if e == doc {
      assert s == r.path;
      var a := Arriving(platform, document, r, input);
      ArrivePutsHead(platform, doc, ArrivingRow(platform, document, r, input), a, keep);
      var effect := var effect :| effect in arrive && PutsFor(platform, effect, doc, a.path); effect;
      assert effect in ruled.effects;
      return;
    }
    ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e);
    if exists i | 0 <= i < |moves| :: s == moves[i].1 && FileOf(platform, documents, moves[i].0, e) {
      var i := var i :| 0 <= i < |moves| && s == moves[i].1 && FileOf(platform, documents, moves[i].0, e); i;
      MoveRowsRow(platform, documents, doc, moves, revs, input.listing, e);
      var moved := MoveRows(platform, documents, doc, moves, revs);
      assert moved[e] == MovedAside(documents[e], moves[i].1, revs[e]);
      var recorded := RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs);
      assert rows[e] == recorded[e];
      assert recorded[e] == moved[e] || recorded[e].binding.None?;
      assert LocallyPlaced(documents[e]);
      MoveEffectsMover(platform, documents, doc, moves, i, e);
      assert SameF(platform, front[i].to, s);
      assert front[i] in ruled.effects && PutsFor(platform, front[i], e, s);
    } else {
      assert rows[e].binding == documents[e].binding;
      var t := documents[e].binding.value.spelling;
      assert t == s && t in avoid;
      forall effect | effect in ruled.effects
        ensures !Touches(platform, effect, s)
      {
        if effect in front {
          var i := var i :| 0 <= i < |front| && front[i] == effect; i;
          assert !FileOf(platform, documents, moves[i].0, e);
          assert !SameF(platform, t, moves[i].1);
        } else {
          assert effect in arrive;
          var own := keep;
          if own.Some? {
            var b := document.binding.value.spelling;
            assert SameF(platform, own.value, b);
            assert !SameF(platform, b, t);
          }
          ArriveTouchesOnly(platform, doc, ArrivingRow(platform, document, r, input), Arriving(platform, document, r, input), keep, s);
        }
      }
    }
  }

  lemma {:isolate_assertions} RuleOrigin(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents && AppliedOrigin(platform, input.listing, e, documents[e], r, ruled.documents[e], ruled.effects, e == doc)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    RuleRowsListed(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      if e == doc {
        ApplyOrigin(platform, doc, document, r, input, bound, claims, revs[doc]);
      } else if documents[e].binding.Some? {
        var t := documents[e].binding.value.spelling;
        assert t in bound;
        ApplyLeavesOthers(platform, doc, document, r, input, bound, claims, revs[doc], t);
      }
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      HeldKeepsBinding(platform, doc, document, r, input, bound, claims, revs[doc]);
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
    } else {
      ClearWayOrigin(platform, documents, doc, r, input, revs, e);
    }
  }

  // The listing at a name no effect touches stays as it was.
  lemma ListingEffectUntouched(platform: Platform, listing: Listing, effect: Effect, s: Path)
    requires Distinct(platform, listing) && !Touches(platform, effect, s)
    ensures var after := ListingAfterEffect(platform, listing, effect);
      Distinct(platform, after) ==>
        (Listed(platform, after, s) <==> Listed(platform, listing, s))
        && (Listed(platform, listing, s) ==> ListedRead(platform, after, s) == ListedRead(platform, listing, s))
  {
    var after := ListingAfterEffect(platform, listing, effect);
    if Distinct(platform, after) {
      if Listed(platform, listing, s) {
        var k := ListedAt(platform, listing, s);
        match effect
        case Write(_, path, _, _, precondition) =>
          if Listed(platform, listing, path) {
            var q := ListedAt(platform, listing, path);
            SameFIsEquivalence(platform, q, path, s);
            SameFIsEquivalence(platform, k, s, q);
          }
        case Remove(_, path, _) =>
          if Listed(platform, listing, path) {
            var q := ListedAt(platform, listing, path);
            SameFIsEquivalence(platform, q, path, s);
            SameFIsEquivalence(platform, k, s, q);
          }
        case Move(_, from, to, _) =>
          if Listed(platform, listing, from) {
            var q := ListedAt(platform, listing, from);
            SameFIsEquivalence(platform, q, from, s);
            SameFIsEquivalence(platform, k, s, q);
          }
        case _ =>
        assert k in after && SameF(platform, k, s);
        assert ListedAt(platform, after, s) == k;
      } else {
        match effect
        case Write(_, path, _, _, _) =>
          SameFIsEquivalence(platform, path, s, path);
        case Move(_, from, to, _) =>
          SameFIsEquivalence(platform, to, s, to);
        case _ =>
      }
    }
  }

  lemma ListingAfterUntouched(platform: Platform, listing: Listing, effects: seq<Effect>, s: Path)
    requires Distinct(platform, listing) && forall effect :: effect in effects ==> !Touches(platform, effect, s)
    ensures var after := ListingAfter(platform, listing, effects);
      Distinct(platform, after) ==>
        (Listed(platform, after, s) <==> Listed(platform, listing, s))
        && (Listed(platform, listing, s) ==> ListedRead(platform, after, s) == ListedRead(platform, listing, s))
    decreases |effects|
  {
    if |effects| > 0 {
      var mid := ListingAfterEffect(platform, listing, effects[0]);
      assert effects[0] in effects;
      ListingEffectUntouched(platform, listing, effects[0], s);
      if Distinct(platform, mid) {
        ListingAfterUntouched(platform, mid, effects[1..], s);
      } else {
        ListingAfterFrozen(platform, mid, effects[1..]);
      }
    }
  }

  // The rule removes only its document's own bound file, expecting what it
  // last saw there or what the listing reads there.
  ghost predicate RemovesOwn(platform: Platform, listing: Listing, document: Document, effect: Effect)
    requires ListingDistinct(platform, listing)
  {
    effect.Remove? ==>
      document.binding.Some? && SameF(platform, document.binding.value.spelling, effect.path)
      && (effect.expected == document.binding.value.seen
          || (ListedRead(platform, listing, document.binding.value.spelling).Some?
              && effect.expected == ListedRead(platform, listing, document.binding.value.spelling).value.0))
  }

  lemma {:isolate_assertions} RuleRemovesOwn(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing)
    ensures forall effect :: effect in PathRule(platform, documents, doc, r, input, revs, first).effects ==>
      (effect.Remove? ==> effect.doc == doc) && RemovesOwn(platform, input.listing, documents[doc], effect)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if document.binding.Some? {
      assert SameF(platform, document.binding.value.spelling, document.binding.value.spelling);
    }
    if !HeldForName(document, applied, r) {
      assert ruled.effects == applied.effects;
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
    } else {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      if aside.Some? && ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        MoveEffectsShape(platform, documents, doc, aside.value);
        var front := MoveEffects(platform, documents, doc, aside.value);
        var arrive := ArriveOf(platform, doc, document, r, input);
        reveal ArrivingRow();
        forall effect | effect in ruled.effects && effect.Remove?
          ensures effect.doc == doc && RemovesOwn(platform, input.listing, document, effect)
        {
          if effect in front {
            var i := var i :| 0 <= i < |front| && front[i] == effect; i;
          }
          assert effect in arrive;
          assert keep.Some?;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // G2_NoUntrackedDelete over the round: the pass invariant
  // ---------------------------------------------------------------------

  // Some live revision of `e` the server accepted has content `c`.
  ghost predicate AcceptedContent(accepted: map<RevId, Revision>, e: DocId, c: Hash) {
    exists rev :: rev in accepted && accepted[rev].doc == e && !accepted[rev].deleted && accepted[rev].content == c
  }

  // Where a row's bound file came from: a name tracked before the round, a
  // name an earlier effect of the round put a tracked file at, or a file
  // holding what the binding saw, a live revision of the document the
  // server accepted (adopted, or synced).
  ghost predicate RowOrigin(platform: Platform, device0: Device, accepted: map<RevId, Revision>, effects: seq<Effect>,
                            listing: Listing, e: DocId, row: Document) {
    row.binding.Some? ==>
      var s := row.binding.value.spelling;
      var seen := row.binding.value.seen;
      Tracked(device0, s)
      || (exists j :: 0 <= j < |effects| && PutsTracked(platform, effects[j], s))
      || (AcceptedContent(accepted, e, seen)
          && (Distinct(platform, listing) && Listed(platform, listing, s) ==> ListedRead(platform, listing, s).value.0 == seen))
  }

  // A remove so far is of a name tracked before the round, of a live
  // accepted revision's content, or of a name an earlier effect put a
  // tracked file at.
  ghost predicate RemoveOK(platform: Platform, device0: Device, accepted: map<RevId, Revision>, effects: seq<Effect>, i: int)
    requires 0 <= i < |effects|
  {
    effects[i].Remove? ==>
      Tracked(device0, effects[i].path) || AcceptedContent(accepted, effects[i].doc, effects[i].expected)
      || exists j :: 0 <= j < i && PutsTracked(platform, effects[j], effects[i].path)
  }

  ghost predicate PassNUD(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass) {
    var rows := pass.journal.documents;
    NeverJoinedRows(platform, rows) && RowsNameAccepted(accepted, rows)
    && (forall e | e in rows :: RowOrigin(platform, device0, accepted, pass.effects, pass.listing, e, rows[e]))
    && (forall i | 0 <= i < |pass.effects| :: RemoveOK(platform, device0, accepted, pass.effects, i))
  }

  lemma {:isolate_assertions} SettleKeepsNUD(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                                             doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass) && AcceptedAs(accepted, r) && r.doc == doc
    ensures PassNUD(platform, device0, accepted, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    SettleNamesAccepted(platform, accepted, pass, doc, r, input, revs, first);
    if !Distinct(platform, pass.listing) { return; }
    if r.path in input.outOfScope {
      if Newer(row, r) {
        var rows' := settled.journal.documents;
        assert rows' == documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))];
        assert forall e | e in rows' :: (e in documents && rows'[e].binding == documents[e].binding)
                                        || rows'[e].binding.None?;
        assert settled.listing == pass.listing && settled.effects == pass.effects;
        assert NeverJoinedRows(platform, rows');
      }
      return;
    }
    var rows := documents[doc := row];
    assert NeverJoinedRows(platform, rows);
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    var intents := IntentsFor(doc, r, ruled.effects, pass.n);
    var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
    var effects' := pass.effects + guard + ruled.effects;
    var listing' := ListingAfter(platform, pass.listing, ruled.effects);
    assert settled.journal.documents == ruled.documents && settled.effects == effects' && settled.listing == listing';
    RuleKeepsNeverJoined(platform, rows, doc, r, inner, revs', first);
    RuleRowsListed(platform, rows, doc, r, inner, revs', first);
    var base := |pass.effects| + |guard|;
    assert forall m | 0 <= m < |ruled.effects| :: effects'[base + m] == ruled.effects[m];
    assert forall j | 0 <= j < |pass.effects| :: effects'[j] == pass.effects[j];
    // Every row keeps an origin.
    forall e | e in ruled.documents
      ensures RowOrigin(platform, device0, accepted, effects', listing', e, ruled.documents[e])
    {
      RuleOrigin(platform, rows, doc, r, inner, revs', first, e);
      var after := ruled.documents[e];
      if after.binding.Some? {
        var s := after.binding.value.spelling;
        if exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, s) {
          var effect :| effect in ruled.effects && PutsFor(platform, effect, e, s);
          assert PutsTracked(platform, effect, s);
          var m := var m :| 0 <= m < |ruled.effects| && ruled.effects[m] == effect; m;
          assert effects'[base + m] == effect;
        } else {
          ListingAfterUntouched(platform, pass.listing, ruled.effects, s);
          if rows[e].binding.Some? && s == rows[e].binding.value.spelling
             && forall effect :: effect in ruled.effects ==> !Touches(platform, effect, s) {
            assert e in documents;
            assert RowOrigin(platform, device0, accepted, pass.effects, pass.listing, e, rows[e]);
            if exists j :: 0 <= j < |pass.effects| && PutsTracked(platform, pass.effects[j], s) {
              var j :| 0 <= j < |pass.effects| && PutsTracked(platform, pass.effects[j], s);
              assert PutsTracked(platform, effects'[j], s);
            }
          } else {
            assert e == doc;
            assert AcceptedContent(accepted, doc, r.content) by { assert accepted[r.id] == r; }
          }
        }
      }
    }
    // Every remove keeps its justification.
    forall i | 0 <= i < |effects'|
      ensures RemoveOK(platform, device0, accepted, effects', i)
    {
      if i < |pass.effects| {
        assert RemoveOK(platform, device0, accepted, pass.effects, i);
      } else if i >= base && effects'[i].Remove? {
        var effect := effects'[i];
        assert effect == ruled.effects[i - base];
        assert effect in ruled.effects;
        RuleRemovesOwn(platform, rows, doc, r, inner, revs', first);
        assert effect.doc == doc && RemovesOwn(platform, pass.listing, rows[doc], effect);
        var s := rows[doc].binding.value.spelling;
        assert doc in documents;
        assert RowOrigin(platform, device0, accepted, pass.effects, pass.listing, doc, rows[doc]);
        if Tracked(device0, s) {
          var x :| BoundTo(device0, x, s);
          SameFIsEquivalence(platform, device0.journal.documents[x].binding.value.spelling, s, effect.path);
          assert BoundTo(device0, x, effect.path);
        } else if exists j :: 0 <= j < |pass.effects| && PutsTracked(platform, pass.effects[j], s) {
          var j :| 0 <= j < |pass.effects| && PutsTracked(platform, pass.effects[j], s);
          var t := if pass.effects[j].Write? then pass.effects[j].path else pass.effects[j].to;
          SameFIsEquivalence(platform, t, s, effect.path);
          assert PutsTracked(platform, effects'[j], effect.path);
        } else {
          assert AcceptedContent(accepted, doc, rows[doc].binding.value.seen);
        }
      }
    }
  }

  lemma SettlePulledKeepsNUD(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                             revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass)
    requires forall i | 0 <= i < |revisions| :: AcceptedAs(accepted, revisions[i])
    ensures PassNUD(platform, device0, accepted, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsNUD(platform, device0, accepted, pass, revisions[0].doc, revisions[0], input, revs, first);
      assert forall i | 0 <= i < |revisions[1..]| :: revisions[1..][i] == revisions[i + 1];
      SettlePulledKeepsNUD(platform, device0, accepted, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsNUD(platform: Platform, device0: Device, accepted: map<RevId, Revision>, pass: RoundPass,
                      docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassNUD(platform, device0, accepted, pass)
    ensures PassNUD(platform, device0, accepted, RetryWaiting(platform, pass, docs, input, revs, first))
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert NeverJoinedRows(platform, cleared.journal.documents);
        assert PassNUD(platform, device0, accepted, cleared);
        SettleKeepsNUD(platform, device0, accepted, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryKeepsNUD(platform, device0, accepted, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsNUD(platform, device0, accepted, pass, docs[1..], input, revs, first);
      }
    }
  }

  // G2_NoUntrackedDelete of the round: it removes a file only at a name
  // tracked before the round, at a name an earlier effect of the round put
  // a tracked file at, or where the file holds exactly a live revision of
  // the removed document the server accepted.
  lemma {:isolate_assertions} RoundG2NoUntrackedDelete(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires d in pre.devices && G5_NeverJoined(pre) && JournalsNameAccepted(pre)
    requires RevisionsKeyed(pre.server) && RevisionsAccepted(pre.server)
    ensures G2_NoUntrackedDelete(RoundStepOf(pre, d, input, revs))
  {
    var step := RoundStepOf(pre, d, input, revs);
    var device := pre.devices[d];
    var platform := device.platform;
    var journal := device.journal;
    var accepted := pre.server.accepted;
    assert step.event == SyncRound(d) && step.pre == pre;
    RoundOnlyTouchesDevice(pre, d, input, revs);
    if !(forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs) {
      assert step.effects == [];
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
    assert step.effects == settled.effects + push.1;
    // The pass invariant from the start, through the retry and the pull.
    assert RowsNameAccepted(accepted, journal.documents);
    forall e | e in start.journal.documents
      ensures RowOrigin(platform, device, accepted, start.effects, start.listing, e, start.journal.documents[e])
    {
      if journal.documents[e].binding.Some? {
        assert SameF(platform, journal.documents[e].binding.value.spelling, journal.documents[e].binding.value.spelling);
        assert BoundTo(device, e, journal.documents[e].binding.value.spelling);
      }
    }
    assert PassNUD(platform, device, accepted, start);
    RetryKeepsNUD(platform, device, accepted, start, WaitingRows(journal.documents), input, revs, first);
    if behind {
      var ids := feed[journal.cursor..];
      RevisionsHeld(pre.server, ids);
      forall i | 0 <= i < |pulled| ensures AcceptedAs(accepted, pulled[i]) {
        assert pulled[i] in pulled;
      }
    }
    SettlePulledKeepsNUD(platform, device, accepted, retried, pulled, input, revs, first);
    PushTouchesNoFile(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
    forall effect | effect in step.effects && effect.Remove?
      ensures Tracked(device, effect.path)
              || exists i :: 0 <= i < |step.effects| && step.effects[i] == effect
                   && RoundTracked(step, i, effect.doc, effect.path, effect.expected)
    {
      var i := var i :| 0 <= i < |step.effects| && step.effects[i] == effect; i;
      if i >= |settled.effects| {
        assert step.effects[i] in push.1;
        assert false;
      }
      assert settled.effects[i] == effect;
      assert RemoveOK(platform, device, accepted, settled.effects, i);
      if !Tracked(device, effect.path) {
        if AcceptedContent(accepted, effect.doc, effect.expected) {
          assert DocVersion(step, effect.doc, effect.expected);
        } else {
          var j := var j :| 0 <= j < i && PutsTracked(platform, settled.effects[j], effect.path); j;
          assert step.effects[j] == settled.effects[j];
        }
        assert RoundTracked(step, i, effect.doc, effect.path, effect.expected);
      }
    }
  }

  // ---------------------------------------------------------------------
  // G5_NeverMixedUp: the disk frame (#1094)
  // ---------------------------------------------------------------------

  // A file at a name no effect touches (under F) stays as it was, the same
  // file, and no file arrives there. With EffectsUntouchedKeepFile, this
  // holds of any effect sequence, so of any prefix of a round's effects (a
  // crash cut, #1098).
  lemma EffectUntouchedKeepsFile(platform: Platform, disk: map<Path, DiskFile>, effect: Effect, disk': map<Path, DiskFile>, s: Path, x: Path)
    requires EffectTakes(platform, disk, effect, disk')
    requires !Touches(platform, effect, s) && SameF(platform, x, s)
    ensures (x in disk <==> x in disk') && (x in disk ==> disk'[x] == disk[x])
  {
    match effect
    case Write(_, path, content, kind, precondition) =>
      if precondition.Some? {
        if exists q :: Holds(platform, disk, q, path, precondition.value) {
          var q := var q :| Holds(platform, disk, q, path, precondition.value)
            && disk' == disk[q := DiskFile(content, kind, disk[q].identity)]; q;
          if q == x { SameFIsEquivalence(platform, path, x, s); SameFIsEquivalence(platform, x, path, s); }
        }
      } else if FreeOn(platform, disk, path) {
        if x == path { SameFIsEquivalence(platform, path, x, s); }
      }
    case Remove(_, path, expected) =>
      if exists q :: Holds(platform, disk, q, path, expected) {
        var q := var q :| Holds(platform, disk, q, path, expected) && disk' == disk - {q}; q;
        if q == x { SameFIsEquivalence(platform, x, path, s); }
      }
    case Move(_, from, to, expected) =>
      if exists q :: MovableTo(platform, disk, q, from, to, expected) {
        var q := var q :| MovableTo(platform, disk, q, from, to, expected) && disk' == (disk - {q})[to := disk[q]]; q;
        if q == x { SameFIsEquivalence(platform, x, from, s); }
        if to == x { SameFIsEquivalence(platform, to, x, s); }
      }
    case _ =>
  }

  lemma EffectsUntouchedKeepFile(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>, s: Path, x: Path)
    requires EffectsTake(platform, disk, effects, disk')
    requires (forall effect :: effect in effects ==> !Touches(platform, effect, s)) && SameF(platform, x, s)
    ensures (x in disk <==> x in disk') && (x in disk ==> disk'[x] == disk[x])
    decreases |effects|
  {
    if |effects| > 0 {
      var mid: map<Path, DiskFile> := var mid: map<Path, DiskFile> :|
        EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk'); mid;
      assert effects[0] in effects;
      EffectUntouchedKeepsFile(platform, disk, effects[0], mid, s, x);
      assert forall effect :: effect in effects[1..] ==> effect in effects;
      EffectsUntouchedKeepFile(platform, mid, effects[1..], disk', s, x);
    }
  }

  // ---------------------------------------------------------------------
  // G5_NeverMixedUp: the pass invariant (#1094, in progress)
  // ---------------------------------------------------------------------

  // Before the pass's effects so far, `e`'s own file is at `p`: bound to
  // it before the round where nothing touched the name since, or written
  // or moved there for it (RoundOwnName, read on the pass).
  ghost predicate OwnNameIn(platform: Platform, device0: Device, effects: seq<Effect>, e: DocId, p: Path) {
    match RoundPut(platform, effects, p)
    case Untouched => BoundTo(device0, e, p)
    case Freed => false
    case By(j) => (effects[j].Write? && effects[j].target == Some(e)) || (effects[j].Move? && effects[j].mover == Some(e))
  }

  // The file at `p` may be taken as untracked as the pass left it
  // (UntrackedThen, read on the pass; the end of the round decides which
  // case): on disk before the round and untouched since (untracked before
  // the round, or let go: RoundLetGo), or last put there by the pass (for
  // no document, RoundLeftUntracked, or for one that lets it go,
  // RoundLetGo).
  ghost predicate UntrackedIn(platform: Platform, device0: Device, effects: seq<Effect>, p: Path) {
    match RoundPut(platform, effects, p)
    case Untouched => HasFile(device0, p)
    case Freed => false
    case By(j) => true
  }

  // Where a row's bound file came from, for G5: its own file
  // (OwnNameIn), or a file it adopted or took as a new document at a name
  // untracked as the pass left it.
  ghost predicate RowG5(platform: Platform, device0: Device, effects: seq<Effect>, e: DocId, row: Document) {
    row.binding.Some? ==>
      OwnNameIn(platform, device0, effects, e, row.binding.value.spelling)
      || UntrackedIn(platform, device0, effects, row.binding.value.spelling)
  }

  ghost predicate PassG5(platform: Platform, device0: Device, pass: RoundPass) {
    var rows := pass.journal.documents;
    NeverJoinedRows(platform, rows)
    && (forall e | e in rows :: RowG5(platform, device0, pass.effects, e, rows[e]))
    && ListedTaken(platform, device0, pass.effects, pass.listing)
  }

  // The invariant holds at the start of the round: every binding names
  // the file bound before it, and a row whose file is missing had none.
  lemma PassG5Start(device0: Device, start: RoundPass, cursor: nat)
    requires start.journal.documents == device0.journal.documents
    requires start.listing == ListingOf(device0) && ListingDistinct(device0.platform, start.listing)
    requires start.effects == [Pull(cursor)]
    requires NeverJoinedRows(device0.platform, start.journal.documents)
    ensures PassG5(device0.platform, device0, start)
  {
    var platform := device0.platform;
    var rows := start.journal.documents;
    ListedTakenStart(device0, cursor);
    forall e | e in rows ensures RowG5(platform, device0, start.effects, e, rows[e]) {
      if rows[e].binding.Some? {
        var s := rows[e].binding.value.spelling;
        assert RoundPut(platform, start.effects, s).Untouched?;
        SameFIsEquivalence(platform, s, s, s);
        assert BoundTo(device0, e, s);
        if !Listed(platform, start.listing, s) {
          assert ListedRead(platform, start.listing, s).None?;
          UnlistedNotOnDisk(device0, s);
        }
      }
    }
  }

  // Create binds without putting the document's file only by adoption.
  lemma {:isolate_assertions} CreateAdoption(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing) && !r.deleted && document.binding.None?
    ensures var applied := Create(platform, doc, document, r, input, bound, claims, rev);
      (applied.document.binding.Some?
       && !(exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, applied.document.binding.value.spelling))) ==>
        applied.effects == [] && applied.document.binding.value.spelling == r.path
        && !BoundName(platform, bound, r.path)
        && ListedRead(platform, input.listing, r.path) == Some((r.content, r.kind))
        && applied.document.base == Some(BaseOf(r))
        && (document.base.None? || document.base.value.rev != r.id)
  {
    var applied := Create(platform, doc, document, r, input, bound, claims, rev);
    assert SameF(platform, r.path, r.path);
    if UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path) {
    } else if FreeIn(platform, input.listing, r.path) {
      assert applied.effects[0] in applied.effects;
    } else if Adoptable(platform, document, input, r) {
      ListedAtSelf(platform, input.listing, r.path);
      assert ListedRead(platform, input.listing, r.path) == Some(input.listing[r.path]);
    } else {
      var held := Colliders(platform, input.listing, r.path);
      if |held| == 1 && !BoundName(platform, bound, LeastPath(held))
         && !UnsavedCollides(platform, input.unsaved, LeastPath(held)) {
        var q := LeastPath(held);
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, q, r.path);
        if copy.Some? {
          assert applied.effects[1] in applied.effects;
        }
      }
    }
  }

  // The apply changes its row's binding without an effect only by
  // adoption (G5 (d)): the row had no file in the listing, and the file
  // at the head's name, bound to no row, holds exactly the head, which
  // becomes the base.
  lemma {:isolate_assertions} ApplyAdoption(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      (applied.document.binding.Some?
       && !(exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, applied.document.binding.value.spelling))
       && (document.binding.None? || applied.document.binding.value.spelling != document.binding.value.spelling)) ==>
        var s := applied.document.binding.value.spelling;
        applied.effects == []
        && (document.binding.None? || ListedRead(platform, input.listing, document.binding.value.spelling).None?)
        && !BoundName(platform, bound, s) && s == r.path && !r.deleted
        && ListedRead(platform, input.listing, s) == Some((r.content, r.kind))
        && applied.document.base == Some(BaseOf(r))
        && (document.base.None? || document.base.value.rev != r.id)
  {
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
    if !Newer(document, r) {
    } else if SettlesIdentical(platform, document, r, input) {
    } else if Acknowledges(document, r) {
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreateAdoption(platform, doc, Revived(document), r, input, bound, claims, rev);
      }
    } else if document.binding.Some? {
      // The binding keeps its name, or is dropped.
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
      } else if r.deleted && read.None? {
      } else if Concurrent(document, read, r) {
        var settled := Settle(platform, doc, document, read.value, r, input, bound, claims, rev);
        assert settled.document.binding.None? || settled.document.binding.value.spelling == spelling;
      }
    } else if r.deleted {
    } else {
      CreateAdoption(platform, doc, document, r, input, bound, claims, rev);
    }
  }

  // The rule binds a row to a file it did not put there for it, at a name
  // other than the row's untouched own, only by the apply's adoption.
  lemma {:isolate_assertions} RuleAdopt(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents
      && var after := ruled.documents[e];
      (after.binding.Some?
       && !(exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, after.binding.value.spelling))
       && !(documents[e].binding.Some? && after.binding.value.spelling == documents[e].binding.value.spelling
            && forall effect :: effect in ruled.effects ==> !Touches(platform, effect, after.binding.value.spelling))) ==>
        var s := after.binding.value.spelling;
        var document := documents[doc];
        e == doc && ruled.effects == []
        && (document.binding.None? || ListedRead(platform, input.listing, document.binding.value.spelling).None?)
        && !BoundName(platform, BoundNames(documents), s) && s == r.path && !r.deleted
        && ListedRead(platform, input.listing, s) == Some((r.content, r.kind))
        && after.base == Some(BaseOf(r))
        && (document.base.None? || document.base.value.rev != r.id)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    RuleOrigin(platform, documents, doc, r, input, revs, first, e);
    if !HeldForName(document, applied, r) {
      if e == doc {
        ApplyAdoption(platform, doc, document, r, input, bound, claims, revs[doc]);
        var after := ruled.documents[e];
        ApplyOrigin(platform, doc, document, r, input, bound, claims, revs[doc]);
      }
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      HeldKeepsBinding(platform, doc, document, r, input, bound, claims, revs[doc]);
    } else if e == doc {
      var keep := Keeps(platform, document, r, input);
      var way := InTheWay(platform, input.listing, r.path, keep);
      var avoid := BoundNames(documents) + input.unsaved;
      var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
      assert ruled == ClearWay(platform, documents, doc, r, input, revs);
      if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
        assert ruled.documents[e].binding == documents[e].binding;
        return;
      }
      var moves := aside.value;
      var front := MoveEffects(platform, documents, doc, moves);
      var arrive := ArriveOf(platform, doc, document, r, input);
      assert ruled.effects == front + arrive;
      assert ruled.documents == ClearRows(platform, documents, doc, r, input, moves, revs);
      assert ruled.documents[doc].binding.Some? && ruled.documents[doc].binding.value.spelling == r.path;
      var a := Arriving(platform, document, r, input);
      ArrivePutsHead(platform, doc, ArrivingRow(platform, document, r, input), a, keep);
      var effect := var effect :| effect in arrive && PutsFor(platform, effect, doc, a.path); effect;
      assert effect in ruled.effects;
    }
  }

  // Effects that do not touch `s` leave what the earlier ones put there.
  lemma RoundPutUntouchedTail(platform: Platform, a: seq<Effect>, b: seq<Effect>, s: Path)
    requires forall effect :: effect in b ==> !Touches(platform, effect, s)
    ensures RoundPut(platform, a + b, s) == RoundPut(platform, a, s)
    decreases |b|
  {
    if |b| > 0 {
      var ab := a + b;
      assert ab[..|ab| - 1] == a + b[..|b| - 1];
      assert b[|b| - 1] in b;
      assert forall effect :: effect in b[..|b| - 1] ==> effect in b;
      RoundPutUntouchedTail(platform, a, b[..|b| - 1], s);
    } else {
      assert a + b == a;
    }
  }

  // The last effect that touches `s` decides what is there.
  lemma RoundPutLastTouch(platform: Platform, a: seq<Effect>, b: seq<Effect>, s: Path, m: nat)
    requires m < |b| && Touches(platform, b[m], s)
    requires forall k | m < k < |b| :: !Touches(platform, b[k], s)
    ensures RoundPut(platform, a + b, s) == RoundPut(platform, a + b[..m + 1], s)
    ensures var put := RoundPut(platform, a + b[..m + 1], s);
      (PutsTracked(platform, b[m], s) || (b[m].Write? && SameF(platform, b[m].path, s)) || (b[m].Move? && SameF(platform, b[m].to, s)))
        ==> put == By(|a| + m)
  {
    var c := a + b[..m + 1];
    var d := b[m + 1..];
    SplitAt(a, b, m);
    TailUntouched(platform, b, s, m);
    RoundPutUntouchedTail(platform, c, d, s);
    RoundPutLastIs(platform, c, s);
  }

  lemma SplitAt(a: seq<Effect>, b: seq<Effect>, m: nat)
    requires m < |b|
    ensures a + b == (a + b[..m + 1]) + b[m + 1..]
    ensures |a + b[..m + 1]| == |a| + m + 1 && (a + b[..m + 1])[|a| + m] == b[m]
  {
    assert b == b[..m + 1] + b[m + 1..];
  }

  lemma TailUntouched(platform: Platform, b: seq<Effect>, s: Path, m: nat)
    requires m < |b|
    requires forall k | m < k < |b| :: !Touches(platform, b[k], s)
    ensures forall effect :: effect in b[m + 1..] ==> !Touches(platform, effect, s)
  {
    forall effect | effect in b[m + 1..] ensures !Touches(platform, effect, s) {
      var k :| 0 <= k < |b[m + 1..]| && b[m + 1..][k] == effect;
      assert effect == b[m + 1 + k];
    }
  }

  // A last effect that puts a file at `s` is what is there.
  lemma RoundPutLastIs(platform: Platform, c: seq<Effect>, s: Path)
    requires |c| > 0
    ensures var last := c[|c| - 1];
      ((last.Write? && SameF(platform, last.path, s)) || (last.Move? && SameF(platform, last.to, s)))
        ==> RoundPut(platform, c, s) == By(|c| - 1)
  {}


  // Where the apply puts the document's file at its new binding, that put
  // is its last effect: a write of the document's file at that name.
  lemma {:isolate_assertions} CreatePutsLast(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := Create(platform, doc, document, r, input, bound, claims, rev);
      (applied.document.binding.Some?
       && exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, applied.document.binding.value.spelling)) ==>
        |applied.effects| > 0
        && applied.effects[|applied.effects| - 1].Write?
        && applied.effects[|applied.effects| - 1].target == Some(doc)
        && applied.effects[|applied.effects| - 1].path == applied.document.binding.value.spelling
  {
    var applied := Create(platform, doc, document, r, input, bound, claims, rev);
    if UnsavedAt(platform, input.unsaved, r.path) || BoundName(platform, bound, r.path) {
    } else if FreeIn(platform, input.listing, r.path) {
    } else if Adoptable(platform, document, input, r) {
    } else {
      var held := Colliders(platform, input.listing, r.path);
      if |held| == 1 && !BoundName(platform, bound, LeastPath(held))
         && !UnsavedCollides(platform, input.unsaved, LeastPath(held)) {
        var q := LeastPath(held);
        var copy := PathConflictCopy(platform, input.listing, bound + input.unsaved, claims, q, r.path);
      }
    }
  }

  lemma {:isolate_assertions} ApplyPutsLast(platform: Platform, doc: DocId, document: Document, r: Revision, input: RoundInput, bound: set<Path>, claims: Claims, rev: RevId)
    requires ListingDistinct(platform, input.listing)
    ensures var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, rev);
      (applied.document.binding.Some?
       && exists effect :: effect in applied.effects && PutsFor(platform, effect, doc, applied.document.binding.value.spelling)) ==>
        |applied.effects| > 0
        && applied.effects[|applied.effects| - 1].Write?
        && applied.effects[|applied.effects| - 1].target == Some(doc)
        && applied.effects[|applied.effects| - 1].path == applied.document.binding.value.spelling
  {
    if !Newer(document, r) {
    } else if SettlesIdentical(platform, document, r, input) {
    } else if Acknowledges(document, r) {
    } else if Revives(platform, document, r, input) {
      if !KeepsUntracked(platform, document, r, input) {
        CreatePutsLast(platform, doc, Revived(document), r, input, bound, claims, rev);
      }
    } else if document.binding.Some? {
      var spelling := document.binding.value.spelling;
      var read := ListedRead(platform, input.listing, spelling);
      if UnsavedAt(platform, input.unsaved, spelling) {
      } else if r.deleted && read.None? {
      } else if Concurrent(document, read, r) {
        var settled := Settle(platform, doc, document, read.value, r, input, bound, claims, rev);
        assert settled.document.binding.None? || settled.document.binding.value.spelling == spelling;
      }
    } else if r.deleted {
    } else {
      CreatePutsLast(platform, doc, document, r, input, bound, claims, rev);
    }
  }

  // The arrival ends with the put of the document's file at the head's name.
  lemma ArriveLast(platform: Platform, doc: DocId, document: Document, a: Revision, own: Option<Path>)
    ensures var effects := Arrive(platform, doc, document, a, own);
      |effects| > 0
      && var last := effects[|effects| - 1];
      (last.Write? && last.target == Some(doc) && last.path == a.path)
      || (last.Move? && last.mover == Some(doc) && last.to == a.path)
  {}

  // A move aside moves the file of the row it names, if any.
  lemma MoveEffectsMoverOwns(platform: Platform, documents: map<DocId, Document>, doc: DocId, moves: seq<(Path, Path, Hash)>, i: nat, x: DocId)
    requires i < |moves|
    requires var effects := MoveEffects(platform, documents, doc, moves);
      i < |effects| && effects[i].Move? && effects[i].mover == Some(x)
    ensures x != doc && FileOf(platform, documents, moves[i].0, x)
    decreases |moves|
  {
    MoveEffectsShape(platform, documents, doc, moves);
    if i > 0 {
      assert MoveEffects(platform, documents, doc, moves)[i] == MoveEffects(platform, documents, doc, moves[1..])[i - 1];
      MoveEffectsShape(platform, documents, doc, moves[1..]);
      MoveEffectsMoverOwns(platform, documents, doc, moves[1..], i - 1, x);
    } else {
      var q := moves[0].0;
      var keepers := set e' | e' in documents && e' != doc && FileOf(platform, documents, q, e') && LocallyPlaced(documents[e']);
      assert keepers != {};
      assert x == LeastDoc(keepers);
    }
  }

  // The arrival writes and moves only the document's own file.
  lemma ArriveFor(platform: Platform, doc: DocId, document: Document, a: Revision, own: Option<Path>)
    ensures forall effect :: effect in Arrive(platform, doc, document, a, own) ==>
      (effect.Write? ==> effect.target == Some(doc)) && (effect.Move? ==> effect.mover == Some(doc))
  {}

  // Where the rule clears the way, the effect that puts a row's file at
  // its new binding is the last one touching that name.
  lemma {:isolate_assertions} ClearWayPutsLast(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents
    ensures var ruled := ClearWay(platform, documents, doc, r, input, revs);
      e in ruled.documents
      && var after := ruled.documents[e];
      (after.binding.Some?
       && exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, after.binding.value.spelling)) ==>
        var s := after.binding.value.spelling;
        exists m :: 0 <= m < |ruled.effects|
          && ((ruled.effects[m].Write? && ruled.effects[m].target == Some(e) && SameF(platform, ruled.effects[m].path, s))
              || (ruled.effects[m].Move? && ruled.effects[m].mover == Some(e) && SameF(platform, ruled.effects[m].to, s)))
          && forall k | m < k < |ruled.effects| :: !Touches(platform, ruled.effects[k], s)
  {
    var document := documents[doc];
    var ruled := ClearWay(platform, documents, doc, r, input, revs);
    var keep := Keeps(platform, document, r, input);
    var way := InTheWay(platform, input.listing, r.path, keep);
    var avoid := BoundNames(documents) + input.unsaved;
    var aside := Aside(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    if aside.None? || !ClearsWith(platform, documents, doc, r, input, keep, aside.value) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
      return;
    }
    var moves := aside.value;
    AsideFacts(platform, input.listing, avoid, AllClaims(documents), way, r.path);
    MoveEffectsShape(platform, documents, doc, moves);
    var front := MoveEffects(platform, documents, doc, moves);
    var a := Arriving(platform, document, r, input);
    var arrive := ArriveOf(platform, doc, document, r, input);
    assert ruled.effects == front + arrive;
    var rows := ruled.documents;
    assert rows == ClearRows(platform, documents, doc, r, input, moves, revs);
    MoveRowsRow(platform, documents, doc, moves, revs, input.listing, e);
    if rows[e].binding.None? { return; }
    var s := rows[e].binding.value.spelling;
    if !exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, s) { return; }
    if e == doc {
      assert s == r.path;
      ArriveLast(platform, doc, ArrivingRow(platform, document, r, input), a, keep);
      var m := |ruled.effects| - 1;
      assert ruled.effects[m] == arrive[|arrive| - 1];
      assert SameF(platform, r.path, r.path);
      return;
    }
    ClearWayRow(platform, documents, doc, r, input, revs, keep, moves, e);
    if exists i | 0 <= i < |moves| :: s == moves[i].1 && FileOf(platform, documents, moves[i].0, e) {
      var i := var i :| 0 <= i < |moves| && s == moves[i].1 && FileOf(platform, documents, moves[i].0, e); i;
      var moved := MoveRows(platform, documents, doc, moves, revs);
      assert LocallyPlaced(documents[e]) by {
        if !LocallyPlaced(documents[e]) {
          assert moved[e] == MovedAside(documents[e], moves[i].1, revs[e]);
          var recorded := RecordMissing(platform, input.listing, documents, doc, r.path, moved, revs);
          assert rows[e] == recorded[e];
        }
      }
      MoveEffectsMover(platform, documents, doc, moves, i, e);
      assert ruled.effects[i] == front[i];
      assert SameF(platform, moves[i].1, s);
      forall k | i < k < |ruled.effects| ensures !Touches(platform, ruled.effects[k], s) {
        if k < |front| {
          assert ruled.effects[k] == front[k];
          assert !CollideF(platform, moves[i].1, moves[k].1);
          assert moves[k].0 in input.listing;
          assert !CollideF(platform, moves[k].0, moves[i].1);
        } else {
          var t := documents[e].binding.value.spelling;
          assert ruled.effects[k] in arrive;
          assert !CollideF(platform, moves[i].1, r.path);
          if keep.Some? {
            var b := document.binding.value.spelling;
            assert SameF(platform, keep.value, b);
            assert b in avoid;
            assert !SameF(platform, b, moves[i].1);
            if SameF(platform, keep.value, s) { SameFIsEquivalence(platform, b, keep.value, s); }
          }
          ArriveTouchesOnly(platform, doc, ArrivingRow(platform, document, r, input), a, keep, s);
        }
      }
    } else {
      // Left as it was: no effect puts its file anywhere for it.
      assert rows[e].binding == documents[e].binding;
      ArriveFor(platform, doc, ArrivingRow(platform, document, r, input), a, keep);
      forall effect | effect in ruled.effects ensures !PutsFor(platform, effect, e, s) {
        if effect in front {
          var i := var i :| 0 <= i < |front| && front[i] == effect; i;
          if effect.mover == Some(e) {
            MoveEffectsMoverOwns(platform, documents, doc, moves, i, e);
          }
        } else {
          assert effect in arrive;
        }
      }
    }
  }

  // The effect that puts a row's file at its binding is the rule's last
  // one touching that name (OwnNameIn's By(j), read on the pass).
  lemma {:isolate_assertions} RulePutsLast(platform: Platform, documents: map<DocId, Document>, doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims, e: DocId)
    requires doc in documents && documents.Keys <= revs.Keys
    requires ListingDistinct(platform, input.listing) && NeverJoinedRows(platform, documents)
    requires e in documents
    ensures var ruled := PathRule(platform, documents, doc, r, input, revs, first);
      e in ruled.documents
      && var after := ruled.documents[e];
      (after.binding.Some?
       && exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, after.binding.value.spelling)) ==>
        var s := after.binding.value.spelling;
        exists m :: 0 <= m < |ruled.effects|
          && ((ruled.effects[m].Write? && ruled.effects[m].target == Some(e) && SameF(platform, ruled.effects[m].path, s))
              || (ruled.effects[m].Move? && ruled.effects[m].mover == Some(e) && SameF(platform, ruled.effects[m].to, s)))
          && forall k | m < k < |ruled.effects| :: !Touches(platform, ruled.effects[k], s)
  {
    var document := documents[doc];
    var bound := BoundNames(documents);
    var claims := ApplyClaims(documents, first);
    var applied := ApplyRevision(platform, doc, document, r, input, bound, claims, revs[doc]);
    var ruled := PathRule(platform, documents, doc, r, input, revs, first);
    if !HeldForName(document, applied, r) {
      if e == doc {
        ApplyPutsLast(platform, doc, document, r, input, bound, claims, revs[doc]);
        var after := ruled.documents[e];
        if after.binding.Some? && exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, after.binding.value.spelling) {
          assert SameF(platform, after.binding.value.spelling, after.binding.value.spelling);
          assert ruled.effects[|ruled.effects| - 1] == applied.effects[|applied.effects| - 1];
        }
      } else if documents[e].binding.Some? {
        var t := documents[e].binding.value.spelling;
        assert t in bound;
        ApplyLeavesOthers(platform, doc, document, r, input, bound, claims, revs[doc], t);
        assert ruled.documents[e] == documents[e];
      }
    } else if UnsavedCollides(platform, input.unsaved, r.path) {
      assert |ruled.effects| == 1 && ruled.effects[0].Report?;
    } else {
      ClearWayPutsLast(platform, documents, doc, r, input, revs, e);
    }
  }

  // A put for `e` at `s` that no later effect touches makes `s` e's own
  // name after all of them.
  lemma LastPutOwnName(platform: Platform, device0: Device, a: seq<Effect>, b: seq<Effect>, e: DocId, s: Path, m: nat)
    requires m < |b|
    requires (b[m].Write? && b[m].target == Some(e) && SameF(platform, b[m].path, s))
             || (b[m].Move? && b[m].mover == Some(e) && SameF(platform, b[m].to, s))
    requires forall k | m < k < |b| :: !Touches(platform, b[k], s)
    ensures OwnNameIn(platform, device0, a + b, e, s)
  {
    assert Touches(platform, b[m], s);
    RoundPutLastTouch(platform, a, b, s, m);
    assert (a + b)[|a| + m] == b[m];
  }

  // Effects that do not touch `s` keep what the pass read at `s`.
  lemma UntouchedTailKeepsReadings(platform: Platform, device0: Device, a: seq<Effect>, b: seq<Effect>, e: DocId, s: Path)
    requires forall effect :: effect in b ==> !Touches(platform, effect, s)
    ensures OwnNameIn(platform, device0, a + b, e, s) == OwnNameIn(platform, device0, a, e, s)
    ensures UntrackedIn(platform, device0, a + b, s) == UntrackedIn(platform, device0, a, s)
  {
    RoundPutUntouchedTail(platform, a, b, s);
    var put := RoundPut(platform, a, s);
    if put.By? { assert (a + b)[put.index] == a[put.index]; }
  }

  // Names the same under F read the same.
  lemma RoundPutSameF(platform: Platform, effects: seq<Effect>, p: Path, q: Path)
    requires SameF(platform, p, q)
    ensures RoundPut(platform, effects, p) == RoundPut(platform, effects, q)
    decreases |effects|
  {
    if |effects| > 0 {
      var last := effects[|effects| - 1];
      SameFIsEquivalence(platform, p, q, q);
      if last.Write? { SameFIsEquivalence(platform, last.path, p, q); SameFIsEquivalence(platform, last.path, q, p); }
      if last.Remove? { SameFIsEquivalence(platform, last.path, p, q); SameFIsEquivalence(platform, last.path, q, p); }
      if last.Move? {
        SameFIsEquivalence(platform, last.to, p, q); SameFIsEquivalence(platform, last.to, q, p);
        SameFIsEquivalence(platform, last.from, p, q); SameFIsEquivalence(platform, last.from, q, p);
      }
      RoundPutSameF(platform, effects[..|effects| - 1], p, q);
    }
  }

  // Every name the pass's listing lists may be taken as untracked as the
  // pass left it (UntrackedIn): a listed name is never freed, and listed
  // and untouched it is on disk before the round.
  ghost predicate ListedTaken(platform: Platform, device0: Device, effects: seq<Effect>, listing: Listing) {
    Distinct(platform, listing) ==> forall s :: Listed(platform, listing, s) ==> UntrackedIn(platform, device0, effects, s)
  }

  lemma ListedTakenStart(device0: Device, cursor: nat)
    requires ListingDistinct(device0.platform, ListingOf(device0))
    ensures ListedTaken(device0.platform, device0, [Pull(cursor)], ListingOf(device0))
  {
    forall s | Listed(device0.platform, ListingOf(device0), s)
      ensures UntrackedIn(device0.platform, device0, [Pull(cursor)], s)
    {
      var q :| q in ListingOf(device0) && SameF(device0.platform, q, s);
      assert q in device0.disk;
      assert RoundPut(device0.platform, [Pull(cursor)], s).Untouched?;
    }
  }

  // A freed name is not listed after the effect that freed it.
  lemma FreedUnlisted(platform: Platform, listing: Listing, effect: Effect, s: Path)
    requires Distinct(platform, listing)
    requires (effect.Remove? && SameF(platform, effect.path, s))
             || (effect.Move? && SameF(platform, effect.from, s) && !SameF(platform, effect.to, s))
    ensures !Listed(platform, ListingAfterEffect(platform, listing, effect), s)
  {
    var after := ListingAfterEffect(platform, listing, effect);
    var p := if effect.Remove? then effect.path else effect.from;
    if k :| k in after && SameF(platform, k, s) {
      SameFIsEquivalence(platform, k, s, p);
      SameFIsEquivalence(platform, p, s, k);
      if Listed(platform, listing, p) {
        var q := ListedAt(platform, listing, p);
        SameFIsEquivalence(platform, q, p, k);
        if effect.Move? && k == effect.to {
          SameFIsEquivalence(platform, k, s, s);
        }
      } else {
        assert k in listing;
      }
    }
  }

  lemma ListedTakenStep(platform: Platform, device0: Device, effects: seq<Effect>, listing: Listing, effect: Effect)
    requires ListedTaken(platform, device0, effects, listing)
    ensures ListedTaken(platform, device0, effects + [effect], ListingAfterEffect(platform, listing, effect))
  {
    var after := ListingAfterEffect(platform, listing, effect);
    var effects' := effects + [effect];
    assert effects'[..|effects'| - 1] == effects;
    assert effects'[|effects'| - 1] == effect;
    if Distinct(platform, after) && Distinct(platform, listing) {
      forall s | Listed(platform, after, s) ensures UntrackedIn(platform, device0, effects', s) {
        if !Touches(platform, effect, s) {
          ListingEffectUntouched(platform, listing, effect, s);
          assert RoundPut(platform, effects', s) == RoundPut(platform, effects, s);
        } else if (effect.Write? && SameF(platform, effect.path, s)) || (effect.Move? && SameF(platform, effect.to, s)) {
          assert RoundPut(platform, effects', s).By?;
        } else {
          FreedUnlisted(platform, listing, effect, s);
        }
      }
    } else if !Distinct(platform, listing) {
      assert after == listing;
    }
  }

  lemma ListedTakenAfter(platform: Platform, device0: Device, effects: seq<Effect>, listing: Listing, more: seq<Effect>)
    requires ListedTaken(platform, device0, effects, listing)
    ensures ListedTaken(platform, device0, effects + more, ListingAfter(platform, listing, more))
    decreases |more|
  {
    if |more| == 0 {
      assert effects + more == effects;
    } else {
      ListedTakenStep(platform, device0, effects, listing, more[0]);
      ListedTakenAfter(platform, device0, effects + [more[0]], ListingAfterEffect(platform, listing, more[0]), more[1..]);
      assert (effects + [more[0]]) + more[1..] == effects + more;
    }
  }

  // Settling one revision keeps the G5 pass invariant: a row the rule
  // puts a file for owns its name (RulePutsLast, LastPutOwnName), a row
  // the rule left at an untouched name keeps what the pass read there,
  // and an adoption takes a listed name (RuleAdopt, ListedTaken).
  lemma {:isolate_assertions} SettleKeepsG5(platform: Platform, device0: Device, pass: RoundPass,
                                            doc: DocId, r: Revision, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass)
    ensures PassG5(platform, device0, SettleRevision(platform, pass, doc, r, input, revs, first))
  {
    var documents := pass.journal.documents;
    var row := if doc in documents then documents[doc] else NoRow();
    var settled := SettleRevision(platform, pass, doc, r, input, revs, first);
    if !Distinct(platform, pass.listing) { return; }
    if r.path in input.outOfScope {
      if Newer(row, r) {
        var rows' := settled.journal.documents;
        assert rows' == documents[doc := row.(ahead := Some(Ahead(r, OutOfScope, false)))];
        assert forall e | e in rows' :: (e in documents && rows'[e].binding == documents[e].binding)
                                        || rows'[e].binding.None?;
        assert settled.listing == pass.listing && settled.effects == pass.effects;
        assert NeverJoinedRows(platform, rows');
        forall e | e in rows' ensures RowG5(platform, device0, settled.effects, e, rows'[e]) {
          if rows'[e].binding.Some? { assert RowG5(platform, device0, pass.effects, e, documents[e]); }
        }
      }
      return;
    }
    var rows := documents[doc := row];
    assert NeverJoinedRows(platform, rows);
    forall e | e in rows ensures RowG5(platform, device0, pass.effects, e, rows[e]) {
      if e in documents && rows[e] == documents[e] { assert RowG5(platform, device0, pass.effects, e, documents[e]); }
    }
    var inner := input.(listing := pass.listing);
    var revs' := RevsFor(rows, revs, r);
    var ruled := PathRule(platform, rows, doc, r, inner, revs', first);
    var intents := IntentsFor(doc, r, ruled.effects, pass.n);
    var guard := if |intents| > 0 then [PersistJournal(pass.journal.(intents := intents))] else [];
    var effects' := pass.effects + guard + ruled.effects;
    var listing' := ListingAfter(platform, pass.listing, ruled.effects);
    assert settled.journal.documents == ruled.documents && settled.effects == effects' && settled.listing == listing';
    RuleKeepsNeverJoined(platform, rows, doc, r, inner, revs', first);
    RuleDeleteSeen(platform, rows, doc, r, inner, revs', first);
    forall effect | effect in guard ensures !Touches(platform, effect, r.path) && effect.PersistJournal? { }
    assert ListingAfter(platform, pass.listing, guard) == pass.listing;
    ListedTakenAfter(platform, device0, pass.effects, pass.listing, guard);
    ListedTakenAfter(platform, device0, pass.effects + guard, pass.listing, ruled.effects);
    forall e | e in ruled.documents ensures RowG5(platform, device0, effects', e, ruled.documents[e]) {
      var after := ruled.documents[e];
      if after.binding.Some? {
        var s := after.binding.value.spelling;
        if exists effect :: effect in ruled.effects && PutsFor(platform, effect, e, s) {
          RulePutsLast(platform, rows, doc, r, inner, revs', first, e);
          var m :| 0 <= m < |ruled.effects|
            && ((ruled.effects[m].Write? && ruled.effects[m].target == Some(e) && SameF(platform, ruled.effects[m].path, s))
                || (ruled.effects[m].Move? && ruled.effects[m].mover == Some(e) && SameF(platform, ruled.effects[m].to, s)))
            && forall k | m < k < |ruled.effects| :: !Touches(platform, ruled.effects[k], s);
          LastPutOwnName(platform, device0, pass.effects + guard, ruled.effects, e, s, m);
        } else if rows[e].binding.Some? && s == rows[e].binding.value.spelling
                  && forall effect :: effect in ruled.effects ==> !Touches(platform, effect, s) {
          assert RowG5(platform, device0, pass.effects, e, rows[e]);
          forall effect | effect in guard + ruled.effects ensures !Touches(platform, effect, s) {
            if effect in guard { assert effect.PersistJournal?; } else { assert effect in ruled.effects; }
          }
          UntouchedTailKeepsReadings(platform, device0, pass.effects, guard + ruled.effects, e, s);
          assert effects' == pass.effects + (guard + ruled.effects);
        } else {
          RuleAdopt(platform, rows, doc, r, inner, revs', first, e);
          assert ruled.effects == [] && s == r.path;
          assert Listed(platform, pass.listing, s);
          assert listing' == pass.listing;
        }
      }
    }
  }

  lemma SettlePulledKeepsG5(platform: Platform, device0: Device, pass: RoundPass,
                            revisions: seq<Revision>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass)
    ensures PassG5(platform, device0, SettlePulled(platform, pass, revisions, input, revs, first))
    decreases |revisions|
  {
    if |revisions| > 0 {
      SettleKeepsG5(platform, device0, pass, revisions[0].doc, revisions[0], input, revs, first);
      SettlePulledKeepsG5(platform, device0, SettleRevision(platform, pass, revisions[0].doc, revisions[0], input, revs, first), revisions[1..], input, revs, first);
    }
  }

  lemma RetryKeepsG5(platform: Platform, device0: Device, pass: RoundPass,
                     docs: seq<DocId>, input: RoundInput, revs: FreshRevs, first: Claims)
    requires device0.platform == platform
    requires PassG5(platform, device0, pass)
    ensures PassG5(platform, device0, RetryWaiting(platform, pass, docs, input, revs, first))
    decreases |docs|
  {
    if |docs| > 0 {
      var documents := pass.journal.documents;
      if docs[0] in documents && documents[docs[0]].ahead.Some? {
        var row := documents[docs[0]];
        var cleared := pass.(journal := pass.journal.(documents := documents[docs[0] := row.(ahead := None)]));
        assert NeverJoinedRows(platform, cleared.journal.documents);
        forall e | e in cleared.journal.documents
          ensures RowG5(platform, device0, cleared.effects, e, cleared.journal.documents[e])
        {
          assert RowG5(platform, device0, pass.effects, e, documents[e]);
        }
        assert PassG5(platform, device0, cleared);
        SettleKeepsG5(platform, device0, cleared, docs[0], row.ahead.value.revision, input, revs, first);
        RetryKeepsG5(platform, device0, SettleRevision(platform, cleared, docs[0], row.ahead.value.revision, input, revs, first), docs[1..], input, revs, first);
      } else {
        RetryKeepsG5(platform, device0, pass, docs[1..], input, revs, first);
      }
    }
  }

  // The push keeps where each row's bound file came from: it seals
  // outboxes, and a new document is bound to a listed name of the pass
  // (ListedTaken), and its effects touch no file.
  lemma {:isolate_assertions} PushKeepsG5(platform: Platform, device0: Device, settled: RoundPass, read: Journal, input: RoundInput, revs: FreshRevs)
    requires device0.platform == platform
    requires PassG5(platform, device0, settled) && read.documents == settled.journal.documents
    requires Distinct(platform, settled.listing)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures var push := OnPush(platform, read, input.(listing := InScope(settled.listing, input.outOfScope)), revs);
      forall e | e in push.0.documents :: RowG5(platform, device0, settled.effects + push.1, e, push.0.documents[e])
  {
    var input' := input.(listing := InScope(settled.listing, input.outOfScope));
    var push := OnPush(platform, read, input', revs);
    var created := Created(platform, read, input', revs);
    PushTouchesNoFile(platform, read, input', revs);
    forall e | e in push.0.documents ensures RowG5(platform, device0, settled.effects + push.1, e, push.0.documents[e]) {
      assert push.0.documents[e] == Seal(created[e]);
      var row := push.0.documents[e];
      if row.binding.Some? {
        var s := row.binding.value.spelling;
        forall effect | effect in push.1 ensures !Touches(platform, effect, s) { }
        UntouchedTailKeepsReadings(platform, device0, settled.effects, push.1, e, s);
        if e in read.documents {
          assert RowG5(platform, device0, settled.effects, e, settled.journal.documents[e]);
        } else {
          var creates := Creates(Untracked(platform, read.documents, input'.listing), input'.freshDocs);
          assert s == creates[e];
          assert s in settled.listing;
          SameFIsEquivalence(platform, s, s, s);
          assert Listed(platform, settled.listing, s);
        }
      }
    }
  }

  // A name the round's effects left untouched (RoundPut) is touched by
  // none of them.
  lemma UntouchedNoTouch(platform: Platform, effects: seq<Effect>, s: Path)
    requires RoundPut(platform, effects, s).Untouched?
    ensures forall effect :: effect in effects ==> !Touches(platform, effect, s)
    decreases |effects|
  {
    if |effects| > 0 {
      var init := effects[..|effects| - 1];
      UntouchedNoTouch(platform, init, s);
      assert effects == init + [effects[|effects| - 1]];
    }
  }

  // At a name the round's effects left untouched, the device after holds
  // the same file as before, or none as before (disks distinct under F).
  lemma UntouchedSameFile(before: Device, after: Device, effects: seq<Effect>, s: Path)
    requires after.platform == before.platform
    requires EffectsTake(before.platform, before.disk, effects, after.disk)
    requires ListingDistinct(before.platform, ListingOf(before)) && ListingDistinct(after.platform, ListingOf(after))
    requires RoundPut(before.platform, effects, s).Untouched?
    ensures HasFile(before, s) <==> HasFile(after, s)
    ensures HasFile(before, s) ==> FileAt(before, s) == FileAt(after, s)
  {
    var platform := before.platform;
    UntouchedNoTouch(platform, effects, s);
    forall x | SameF(platform, x, s) ensures (x in before.disk <==> x in after.disk) && (x in before.disk ==> after.disk[x] == before.disk[x]) {
      EffectsUntouchedKeepFile(platform, before.disk, effects, after.disk, s, x);
    }
    if HasFile(before, s) {
      var q :| q in before.disk && SameF(platform, q, s) && FileAt(before, s) == before.disk[q];
      var k :| k in after.disk && SameF(platform, k, s) && FileAt(after, s) == after.disk[k];
      assert q in ListingOf(after) && k in ListingOf(after);
      if q != k {
        SameFIsEquivalence(platform, q, s, k);
        SameFIsEquivalence(platform, k, s, q);
      }
    }
  }
}
