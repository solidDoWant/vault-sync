// Satisfiability witnesses and non-vacuity checks for the guarantees of
// Guarantees.dfy (#947). A witness shows a guarantee can be met by a
// non-trivial state or run, so no correct core is ruled out by a predicate
// that is too strong. A rejection shows a predicate fails on the failure its
// sentence rules out, so a broken core cannot pass it.
include "Guarantees.dfy"

abstract module GuaranteeWitnesses refines Guarantees {

  // ---------------------------------------------------------------------
  // Witnesses
  // ---------------------------------------------------------------------

  // A user writes a file on one of two devices, with the app running. The
  // run satisfies every trace guarantee, and the state after it every state
  // invariant: the device that has the new file has not finished syncing.
  lemma UserWriteRunSatisfiesGuarantees(d1: DeviceId, d2: DeviceId, platform: Platform, p: Path, f: DiskFile)
    requires d1 != d2
    ensures
      var platforms := map[d1 := platform, d2 := platform];
      var pre := Initial(platforms);
      var post := pre.(devices := pre.devices[d1 := pre.devices[d1].(disk := map[p := f])]);
      var trace := [Step(pre, User(d1, WriteFile(p, f.content, f.kind)), [], post)];
      Run(platforms, trace) && TraceGuarantees(trace) && StateInvariants(post)
  {
    var platforms := map[d1 := platform, d2 := platform];
    var pre := Initial(platforms);
    var post := pre.(devices := pre.devices[d1 := pre.devices[d1].(disk := map[p := f])]);
    var trace := [Step(pre, User(d1, WriteFile(p, f.content, f.kind)), [], post)];
    forall doc ensures Head(post.server, doc).None? {}
    assert !FinishedSyncing(post, d1) by {
      assert p in post.devices[d1].disk;
      assert !Tracked(post.devices[d1], p);
    }
    assert G9(post);
    assert G5(trace);
    assert G6(trace);
    assert G10(trace);
  }

  // Two devices that hold the same synced file satisfy every state
  // invariant, and both count as finished syncing.
  lemma SyncedDevicesSatisfyInvariants(
    d1: DeviceId, d2: DeviceId, platform: Platform, p: Path, doc: DocId, rev: Revision, f1: DiskFile, f2: DiskFile)
    requires d1 != d2
    requires rev.doc == doc && !rev.deleted && rev.path == p
    requires f1.content == rev.content && f2.content == rev.content
    ensures
      var server := Server(map[rev.id := rev], map[doc := [rev.id]], [rev.id], {}, map[rev.id := rev]);
      var document := Document(Some(Base(rev.id, 1, p, rev.content, rev.kind, false)), None,
                               Some(Binding(p, rev.content, false, None)), Never, None);
      var state := State(
        map[d1 := Device(platform, true, Journal(map[doc := document], 1, [], []), map[p := f1], {}, {}),
            d2 := Device(platform, true, Journal(map[doc := document], 1, [], []), map[p := f2], {}, {})],
        server);
      StateInvariants(state) && FinishedSyncing(state, d1) && FinishedSyncing(state, d2)
  {
    var server := Server(map[rev.id := rev], map[doc := [rev.id]], [rev.id], {}, map[rev.id := rev]);
    var document := Document(Some(Base(rev.id, 1, p, rev.content, rev.kind, false)), None,
                             Some(Binding(p, rev.content, false, None)), Never, None);
    var state := State(
      map[d1 := Device(platform, true, Journal(map[doc := document], 1, [], []), map[p := f1], {}, {}),
          d2 := Device(platform, true, Journal(map[doc := document], 1, [], []), map[p := f2], {}, {})],
      server);
    assert Head(server, doc) == Some(rev);
    forall other | other != doc ensures Head(server, other).None? {}
    assert InHistory(server, rev.id);
    assert G1_Retained(state);
    SameNameModuloFoldersRefl(platform, p);
    assert BoundTo(state.devices[d1], doc, p);
    assert BoundTo(state.devices[d2], doc, p);
    assert FinishedSyncing(state, d1);
    assert FinishedSyncing(state, d2);
    assert G9(state);
  }

  // A device whose user has written a file it has not been told of yet runs
  // two sync rounds while another device's revision waits on the feed. The
  // first round pulls and applies it; the second has nothing to do. The run
  // satisfies G10_NeverStalls: the pulled file is as the server has it, and
  // the user's file is not yet the engine's to settle.
  lemma TwoRoundsSatisfyNeverStalls(
    d: DeviceId, platform: Platform, p: Path, q: Path, doc: DocId, rev: Revision, f: DiskFile, g: DiskFile)
    requires rev.doc == doc && !rev.deleted && rev.path == p && f.content == rev.content
    requires !SameF(platform, p, q)
    ensures
      var server := Server(map[rev.id := rev], map[doc := [rev.id]], [rev.id], {}, map[rev.id := rev]);
      var document := Document(Some(Base(rev.id, 1, p, rev.content, rev.kind, false)), None,
                               Some(Binding(p, rev.content, false, None)), Never, None);
      var s0 := State(map[d := Device(platform, true, Journal(map[], 0, [], []), map[], {}, {})], server);
      var s1 := State(map[d := Device(platform, true, Journal(map[], 0, [], []), map[q := g], {}, {})], server);
      var s2 := State(map[d := Device(platform, true, Journal(map[doc := document], 1, [], []), map[q := g, p := f], {}, {})], server);
      var trace := [
        Step(s0, User(d, WriteFile(q, g.content, g.kind)), [], s1),
        Step(s1, SyncRound(d), [Pull(0), Write(Some(doc), p, rev.content, rev.kind, None)], s2),
        Step(s2, SyncRound(d), [Pull(1)], s2)];
      G10_NeverStalls(trace)
  {
    var server := Server(map[rev.id := rev], map[doc := [rev.id]], [rev.id], {}, map[rev.id := rev]);
    var document := Document(Some(Base(rev.id, 1, p, rev.content, rev.kind, false)), None,
                             Some(Binding(p, rev.content, false, None)), Never, None);
    var s0 := State(map[d := Device(platform, true, Journal(map[], 0, [], []), map[], {}, {})], server);
    var s1 := State(map[d := Device(platform, true, Journal(map[], 0, [], []), map[q := g], {}, {})], server);
    var s2 := State(map[d := Device(platform, true, Journal(map[doc := document], 1, [], []), map[q := g, p := f], {}, {})], server);
    var trace := [
      Step(s0, User(d, WriteFile(q, g.content, g.kind)), [], s1),
      Step(s1, SyncRound(d), [Pull(0), Write(Some(doc), p, rev.content, rev.kind, None)], s2),
      Step(s2, SyncRound(d), [Pull(1)], s2)];
    forall d', i, i2, n | (0 <= i < i2 <= n < |trace|
      && trace[i].event == SyncRound(d') && trace[i2].event == SyncRound(d')
      && QuietFor(trace, d', i + 1, i2) && QuietFor(trace, d', i2 + 1, n + 1)
      && (n + 1 == |trace| || !QuietFor(trace, d', n + 1, n + 2))
      && d' in trace[n].post.devices)
      ensures SettledExceptReported(trace[n].post, d',
                iset x | Unnoticed(trace, d', n, trace[n].post.devices[d'].platform, x))
    {
      assert d' == d && i == 1 && i2 == 2 && n == 2;
      var device := s2.devices[d];
      assert Unnoticed(trace, d, 2, platform, q) by {
        assert trace[0].event.User? && UserTouches(trace[0].event.action, platform, q);
      }
      assert AsServerHas(device, p) by {
        assert BoundTo(device, doc, p);
      }
      forall x | x in device.disk && x !in device.outOfScope && !Unnoticed(trace, d, 2, platform, x)
        ensures AsServerHas(device, x)
      {
        assert x == p;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Effect semantics (Engine.dfy, verified-core.md §2.3)
  // ---------------------------------------------------------------------

  // A device holds a synced file at p; a remote revision arrives and the
  // core overwrites the file, conditional on the content it last saw there.
  // The write applies: the same file holds the new content. The step's disk
  // follows its effects and the step keeps G2's step predicates.
  lemma ConditionalWriteFollowsEffects(
    d: DeviceId, platform: Platform, p: Path, doc: DocId, f: DiskFile, h: Hash, kind: Kind, rev: Revision)
    ensures
      var before := Document(None, None, Some(Binding(p, f.content, false, None)), Never, None);
      var after := Document(None, None, Some(Binding(p, h, false, None)), Never, None);
      var server := Server(map[], map[], [], {}, map[]);
      var pre := State(map[d := Device(platform, true, Journal(map[doc := before], 0, [], []), map[p := f], {}, {})], server);
      var post := State(map[d := Device(platform, true, Journal(map[doc := after], 0, [], []),
                                        map[p := DiskFile(h, kind, f.identity)], {}, {})], server);
      var step := Step(pre, RemoteRevision(d, rev), [Write(Some(doc), p, h, kind, Some(f.content))], post);
      DisksFollowEffects(step)
      && G2_OnlyWhatItSaw(step) && G2_Conditional(step) && G2_NoUntrackedDelete(step) && G2_UnsavedSafe(step)
  {
    var before := Document(None, None, Some(Binding(p, f.content, false, None)), Never, None);
    var after := Document(None, None, Some(Binding(p, h, false, None)), Never, None);
    var server := Server(map[], map[], [], {}, map[]);
    var pre := State(map[d := Device(platform, true, Journal(map[doc := before], 0, [], []), map[p := f], {}, {})], server);
    var post := State(map[d := Device(platform, true, Journal(map[doc := after], 0, [], []),
                                      map[p := DiskFile(h, kind, f.identity)], {}, {})], server);
    var write := Write(Some(doc), p, h, kind, Some(f.content));
    var step := Step(pre, RemoteRevision(d, rev), [write], post);
    var disk := map[p := f];
    var disk' := map[p := DiskFile(h, kind, f.identity)];
    assert Holds(platform, disk, p, p, f.content);
    assert disk' == disk[p := DiskFile(h, kind, disk[p].identity)];
    assert EffectTakes(platform, disk, write, disk');
    assert EffectsTake(platform, disk', [write][1..], disk');
    assert EffectsTake(platform, disk, [write], disk');
    assert BoundTo(pre.devices[d], doc, p);
    assert G2_OnlyWhatItSaw(step);
    assert write in step.effects;
    assert G2_Conditional(step);
  }

  // The same write, when the file no longer holds what the core last saw:
  // a post disk where it was performed anyway does not follow the effects.
  lemma DisksFollowEffectsRejectsUnmatchedWrite(
    d: DeviceId, platform: Platform, p: Path, doc: DocId, f: DiskFile, seen: Hash, h: Hash, kind: Kind,
    rev: Revision, journal: Journal)
    requires f.content != seen && h != f.content
    ensures
      var server := Server(map[], map[], [], {}, map[]);
      var pre := State(map[d := Device(platform, true, journal, map[p := f], {}, {})], server);
      var post := State(map[d := Device(platform, true, journal, map[p := DiskFile(h, kind, f.identity)], {}, {})], server);
      !DisksFollowEffects(Step(pre, RemoteRevision(d, rev), [Write(Some(doc), p, h, kind, Some(seen))], post))
  {
    var server := Server(map[], map[], [], {}, map[]);
    var pre := State(map[d := Device(platform, true, journal, map[p := f], {}, {})], server);
    var post := State(map[d := Device(platform, true, journal, map[p := DiskFile(h, kind, f.identity)], {}, {})], server);
    var write := Write(Some(doc), p, h, kind, Some(seen));
    var step := Step(pre, RemoteRevision(d, rev), [write], post);
    var disk := map[p := f];
    var disk' := map[p := DiskFile(h, kind, f.identity)];
    assert !exists q :: Holds(platform, disk, q, p, seen);
    forall mid: map<Path, DiskFile> | EffectTakes(platform, disk, write, mid) ensures mid != disk' {
      assert mid == disk;
      assert disk'[p] != disk[p];
    }
    assert !EffectsTake(platform, disk, [write], disk');
    assert d in step.pre.devices && d in step.post.devices && EventDevice(step.event) == Some(d);
  }

  // A write whose precondition holds, but which the post disk does not show
  // (the effect silently dropped), does not follow the effects either. The
  // step's guarantees alone do not rule this out: nothing on the disk
  // changed.
  lemma DisksFollowEffectsRejectsDroppedWrite(
    d: DeviceId, platform: Platform, p: Path, doc: DocId, f: DiskFile, h: Hash, kind: Kind,
    rev: Revision, journal: Journal)
    requires h != f.content
    ensures
      var pre := State(map[d := Device(platform, true, journal, map[p := f], {}, {})], Server(map[], map[], [], {}, map[]));
      !DisksFollowEffects(Step(pre, RemoteRevision(d, rev), [Write(Some(doc), p, h, kind, Some(f.content))], pre))
  {
    var write := Write(Some(doc), p, h, kind, Some(f.content));
    var disk := map[p := f];
    assert Holds(platform, disk, p, p, f.content);
    forall mid: map<Path, DiskFile> | EffectTakes(platform, disk, write, mid) ensures mid != disk {
      var q :| Holds(platform, disk, q, p, f.content) && mid == disk[q := DiskFile(h, kind, disk[q].identity)];
      assert q == p;
      assert mid[p].content == h;
    }
    assert !EffectsTake(platform, disk, [write], disk);
    var pre := State(map[d := Device(platform, true, journal, map[p := f], {}, {})], Server(map[], map[], [], {}, map[]));
    var step := Step(pre, RemoteRevision(d, rev), [write], pre);
    assert d in step.pre.devices && EventDevice(step.event) == Some(d);
  }

  // The effect semantics keep G2_Conditional's disk half: in a step that is
  // not the user's and keeps its devices, every file the effects change or
  // remove was named by an effect whose precondition matched it before the
  // step.
  // `effect` names the file at p (under F), conditional on its content.
  ghost predicate MatchedBy(platform: Platform, effect: Effect, p: Path, content: Hash) {
    (effect.Write? && SameF(platform, effect.path, p) && effect.precondition == Some(content))
    || (effect.Remove? && SameF(platform, effect.path, p) && effect.expected == content)
    || (effect.Move? && SameF(platform, effect.from, p) && effect.expected == content)
  }

  lemma EffectsChangeOnlyMatchedFiles(
    platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>, disk': map<Path, DiskFile>, p: Path)
    requires EffectsTake(platform, disk, effects, disk')
    requires p in disk && (p !in disk' || disk'[p] != disk[p])
    ensures exists effect :: effect in effects && MatchedBy(platform, effect, p, disk[p].content)
    decreases |effects|
  {
    var mid: map<Path, DiskFile> :| EffectTakes(platform, disk, effects[0], mid) && EffectsTake(platform, mid, effects[1..], disk');
    if p in mid && mid[p] == disk[p] {
      EffectsChangeOnlyMatchedFiles(platform, mid, effects[1..], disk', p);
      var effect :| effect in effects[1..] && MatchedBy(platform, effect, p, mid[p].content);
      assert effect in effects;
    } else {
      var effect := effects[0];
      assert effect in effects;
      match effect
      case Write(_, path, content, kind, precondition) =>
        if precondition.Some? {
          var q :| Holds(platform, disk, q, path, precondition.value)
                   && mid == disk[q := DiskFile(content, kind, disk[q].identity)];
          assert q == p;
        } else {
          assert CollideF(platform, p, p);
        }
      case Remove(_, path, expected) =>
        var q :| Holds(platform, disk, q, path, expected) && mid == disk - {q};
        assert q == p;
      case Move(_, from, to, expected) =>
        var q :| MovableTo(platform, disk, q, from, to, expected) && mid == (disk - {q})[to := disk[q]];
        if q != p {
          assert p in disk - {q};
          assert CollideF(platform, p, p);
          assert p != to;
        }
      case _ =>
    }
  }

  // Hence a step whose disks follow its effects, that is not the user's and
  // keeps its devices, satisfies G2_Conditional.
  lemma DisksFollowEffectsKeepsConditional(step: Step)
    requires DisksFollowEffects(step) && step.pre.devices.Keys == step.post.devices.Keys
    ensures G2_Conditional(step)
  {
    if !step.event.User? {
      forall d, p | (d in step.pre.devices && p in step.pre.devices[d].disk
        && (d !in step.post.devices || p !in step.post.devices[d].disk
            || step.post.devices[d].disk[p] != step.pre.devices[d].disk[p]))
        ensures EventDevice(step.event) == Some(d)
          && exists effect :: effect in step.effects
               && MatchedBy(step.pre.devices[d].platform, effect, p, step.pre.devices[d].disk[p].content)
      {
        EffectsChangeOnlyMatchedFiles(step.pre.devices[d].platform, step.pre.devices[d].disk, step.effects,
                                      step.post.devices[d].disk, p);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Collisions, fresh identities and crashes (Engine.dfy)
  // ---------------------------------------------------------------------

  // A rename that changes only the case of a name (two spellings with one F)
  // takes effect: the same file, with its content, is at the new spelling.
  lemma CaseOnlyRenameTakesEffect(platform: Platform, p: Path, to: Path, f: DiskFile, mover: Option<DocId>)
    requires p != to && SameF(platform, p, to)
    ensures EffectsTake(platform, map[p := f], [Move(mover, p, to, f.content)], map[to := f])
  {
    var disk := map[p := f];
    var move := Move(mover, p, to, f.content);
    assert MovableTo(platform, disk, p, p, to, f.content);
    assert map[to := f] == (disk - {p})[to := disk[p]];
    assert EffectTakes(platform, disk, move, map[to := f]);
    assert EffectsTake(platform, map[to := f], [move][1..], map[to := f]);
  }

  // A move of a file into a folder of its own name, or onto one of its own
  // folders, does not take effect: the disk stays as it was, and a disk
  // where the file moved does not follow the effect.
  lemma MoveIntoOwnFolderDoesNotTakeEffect(
    platform: Platform, p: Path, to: Path, f: DiskFile, mover: Option<DocId>, disk': map<Path, DiskFile>)
    requires p in Ancestors(to) || to in Ancestors(p)
    requires !SameF(platform, p, to)
    ensures EffectsTake(platform, map[p := f], [Move(mover, p, to, f.content)], disk') <==> disk' == map[p := f]
  {
    var disk := map[p := f];
    var move := Move(mover, p, to, f.content);
    assert CollideF(platform, p, to) by {
      if p in Ancestors(to) { assert SameF(platform, p, p); } else { assert SameF(platform, to, to); }
    }
    assert !exists q :: MovableTo(platform, disk, q, p, to, f.content);
    assert [move][1..] == [];
    if EffectsTake(platform, disk, [move], disk') {
      var mid :| EffectTakes(platform, disk, move, mid) && EffectsTake(platform, mid, [move][1..], disk');
      assert mid == disk;
    }
    if disk' == disk {
      assert EffectTakes(platform, disk, move, disk);
      assert EffectsTake(platform, disk, [move][1..], disk);
    }
  }

  // A create next to a file it does not collide with takes effect: a new
  // file, with an identity no file had, appears beside the other.
  lemma CreateNextToFileTakesEffect(
    platform: Platform, p: Path, to: Path, f: DiskFile, h: Hash, kind: Kind, target: Option<DocId>)
    requires !CollideF(platform, p, to)
    ensures exists identity: FileIdentity ::
              identity != f.identity
              && EffectsTake(platform, map[p := f], [Write(target, to, h, kind, None)],
                             map[p := f, to := DiskFile(h, kind, identity)])
  {
    var disk := map[p := f];
    var write := Write(target, to, h, kind, None);
    FreshIdentityExists({f.identity});
    var identity: FileIdentity :| identity !in {f.identity};
    var disk' := map[p := f, to := DiskFile(h, kind, identity)];
    assert FreeOn(platform, disk, to);
    assert disk' == disk[to := DiskFile(h, kind, identity)];
    assert EffectTakes(platform, disk, write, disk');
    assert EffectsTake(platform, disk', [write][1..], disk');
  }

  // A create at a name that collides with an existing file (another
  // spelling of its name under F, a folder of it, or a name under it) does
  // not take effect.
  lemma CreateCollidingDoesNotTakeEffect(
    platform: Platform, p: Path, to: Path, f: DiskFile, h: Hash, kind: Kind, target: Option<DocId>,
    disk': map<Path, DiskFile>)
    requires CollideF(platform, p, to) && p != to
    ensures EffectsTake(platform, map[p := f], [Write(target, to, h, kind, None)], disk') <==> disk' == map[p := f]
  {
    var disk := map[p := f];
    var write := Write(target, to, h, kind, None);
    assert !FreeOn(platform, disk, to);
    assert [write][1..] == [];
    if EffectsTake(platform, disk, [write], disk') {
      var mid :| EffectTakes(platform, disk, write, mid) && EffectsTake(platform, mid, [write][1..], disk');
      assert mid == disk;
    }
    if disk' == disk {
      assert EffectTakes(platform, disk, write, disk);
      assert EffectsTake(platform, disk, [write][1..], disk);
    }
  }

  // Every effect has an outcome on every disk, so no step's effects make
  // DisksFollowEffects unsatisfiable: a create that applies gets a fresh
  // identity (FreshIdentityExists).
  lemma EffectCanTake(platform: Platform, disk: map<Path, DiskFile>, effect: Effect)
    ensures exists disk' :: EffectTakes(platform, disk, effect, disk')
  {
    match effect
    case Write(_, path, content, kind, precondition) =>
      if precondition.Some? {
        if exists q :: Holds(platform, disk, q, path, precondition.value) {
          var q :| Holds(platform, disk, q, path, precondition.value);
          assert EffectTakes(platform, disk, effect, disk[q := DiskFile(content, kind, disk[q].identity)]);
        } else {
          assert EffectTakes(platform, disk, effect, disk);
        }
      } else if FreeOn(platform, disk, path) {
        var used := set q | q in disk :: disk[q].identity;
        FreshIdentityExists(used);
        var identity: FileIdentity :| identity !in used;
        assert forall q :: q in disk ==> disk[q].identity in used;
        assert EffectTakes(platform, disk, effect, disk[path := DiskFile(content, kind, identity)]);
      } else {
        assert EffectTakes(platform, disk, effect, disk);
      }
    case Remove(_, path, expected) =>
      if exists q :: Holds(platform, disk, q, path, expected) {
        var q :| Holds(platform, disk, q, path, expected);
        assert EffectTakes(platform, disk, effect, disk - {q});
      } else {
        assert EffectTakes(platform, disk, effect, disk);
      }
    case Move(_, from, to, expected) =>
      if exists q :: MovableTo(platform, disk, q, from, to, expected) {
        var q :| MovableTo(platform, disk, q, from, to, expected);
        assert EffectTakes(platform, disk, effect, (disk - {q})[to := disk[q]]);
      } else {
        assert EffectTakes(platform, disk, effect, disk);
      }
    case _ =>
      assert EffectTakes(platform, disk, effect, disk);
  }

  lemma EffectsCanTake(platform: Platform, disk: map<Path, DiskFile>, effects: seq<Effect>)
    ensures exists disk' :: EffectsTake(platform, disk, effects, disk')
    decreases |effects|
  {
    if |effects| == 0 {
      assert EffectsTake(platform, disk, effects, disk);
    } else {
      EffectCanTake(platform, disk, effects[0]);
      var mid :| EffectTakes(platform, disk, effects[0], mid);
      EffectsCanTake(platform, mid, effects[1..]);
      var disk' :| EffectsTake(platform, mid, effects[1..], disk');
      assert EffectsTake(platform, disk, effects, disk');
    }
  }

  // A crash that cut a sync round short after the first of the two effects
  // the core requested lists that one: a prefix of what was requested.
  lemma CrashAfterFirstEffectCutsShort(pre: State, post: State, d: DeviceId, first: Effect, second: Effect)
    ensures CrashCutsShort(Step(pre, Crash(d, Some(Cut(SyncRound(d), [first, second]))), [first], post))
  {
    assert [first] == [first, second][..1];
  }

  // A crash step fails CrashCutsShort when it lists an effect the core did
  // not request at that place (the second effect without the first), an
  // effect although it cut nothing short, or effects of another device's
  // step.
  lemma CrashCutsShortRejects(
    pre: State, post: State, d: DeviceId, other: DeviceId, first: Effect, second: Effect)
    requires first != second && other != d
    ensures !CrashCutsShort(Step(pre, Crash(d, Some(Cut(SyncRound(d), [first, second]))), [second], post))
    ensures !CrashCutsShort(Step(pre, Crash(d, None), [first], post))
    ensures !CrashCutsShort(Step(pre, Crash(d, Some(Cut(SyncRound(other), [first]))), [first], post))
  {
    assert [first, second][..1] == [first];
  }

  // A crash step fails CrashCutsShort when the step it claims to have cut
  // short is one the core does not handle: a user's action of the same
  // device, or another crash of it. Each lists a prefix of the requested
  // effects, so only the kind of the cut event rules it out.
  lemma CrashCutsShortRejectsUnhandledEvents(
    pre: State, post: State, d: DeviceId, action: UserAction, first: Effect, second: Effect)
    ensures !CrashCutsShort(Step(pre, Crash(d, Some(Cut(User(d, action), [first, second]))), [first], post))
    ensures !CrashCutsShort(Step(pre, Crash(d, Some(Cut(Crash(d, None), [first, second]))), [first], post))
  {
    assert [first, second][..1] == [first];
  }

  // ---------------------------------------------------------------------
  // Rejections
  // ---------------------------------------------------------------------

  // G9: two finished devices that disagree on a file's content fail it.
  lemma G9Rejects(
    d1: DeviceId, d2: DeviceId, platform: Platform, p: Path, doc: DocId, rev: Revision, f1: DiskFile, f2: DiskFile)
    requires d1 != d2
    requires rev.doc == doc && !rev.deleted && rev.path == p
    requires f1.content == rev.content && f2.content != rev.content
    requires forall q :: SameNameModuloFolders(platform, p, q) ==> q == p
    ensures
      var server := Server(map[rev.id := rev], map[doc := [rev.id]], [rev.id], {}, map[rev.id := rev]);
      var document := Document(Some(Base(rev.id, 1, p, rev.content, rev.kind, false)), None,
                               Some(Binding(p, rev.content, false, None)), Never, None);
      var other := Document(Some(Base(rev.id, 1, p, f2.content, rev.kind, false)), None,
                            Some(Binding(p, f2.content, false, None)), Never, None);
      !G9(State(
        map[d1 := Device(platform, true, Journal(map[doc := document], 1, [], []), map[p := f1], {}, {}),
            d2 := Device(platform, true, Journal(map[doc := other], 1, [], []), map[p := f2], {}, {})],
        server))
  {
    var server := Server(map[rev.id := rev], map[doc := [rev.id]], [rev.id], {}, map[rev.id := rev]);
    var document := Document(Some(Base(rev.id, 1, p, rev.content, rev.kind, false)), None,
                             Some(Binding(p, rev.content, false, None)), Never, None);
    var other := Document(Some(Base(rev.id, 1, p, f2.content, rev.kind, false)), None,
                          Some(Binding(p, f2.content, false, None)), Never, None);
    var state := State(
      map[d1 := Device(platform, true, Journal(map[doc := document], 1, [], []), map[p := f1], {}, {}),
          d2 := Device(platform, true, Journal(map[doc := other], 1, [], []), map[p := f2], {}, {})],
      server);
    assert BoundTo(state.devices[d1], doc, p);
    assert BoundTo(state.devices[d2], doc, p);
    assert FinishedSyncing(state, d1);
    assert FinishedSyncing(state, d2);
    assert !ReportedCannotHold(state, state.devices[d2], p);
  }

  // G3: a delete sync requests with no user delete before it fails it.
  lemma G3Rejects(platforms: map<DeviceId, Platform>, d: DeviceId, p: Path, doc: DocId, h: Hash, post: State)
    requires d in platforms
    ensures !G3([Step(Initial(platforms), SyncRound(d), [Remove(doc, p, h)], post)])
  {
    var trace := [Step(Initial(platforms), SyncRound(d), [Remove(doc, p, h)], post)];
    assert Remove(doc, p, h) in trace[0].effects;
  }

  // G10: a sync round that leaves a remote revision deferred behind local
  // changes, with no editor open and nothing rejected, fails it even if it
  // reports it.
  lemma G10Rejects(platform: Platform, d: DeviceId, doc: DocId, rev: Revision, pre: State)
    ensures
      var document := Document(None, Some(Ahead(rev, LocalChanges, false)), None, Never, None);
      var post := State(map[d := Device(platform, true, Journal(map[doc := document], 0, [], []), map[], {}, {})],
                        Server(map[], map[], [], {}, map[]));
      !G10_SettledOrReported(Step(pre, SyncRound(d), [Report(Some(doc), rev.path, "conflict")], post))
  {
    var document := Document(None, Some(Ahead(rev, LocalChanges, false)), None, Never, None);
    var post := State(map[d := Device(platform, true, Journal(map[doc := document], 0, [], []), map[], {}, {})],
                      Server(map[], map[], [], {}, map[]));
    assert Unsettled(post.devices[d], doc);
    assert !UserMustAct(post.devices[d], doc);
  }

  // G8: a start-up scan that forgets a missing file's document instead of
  // counting it as deleted by the user fails it.
  lemma G8Rejects(platform: Platform, d: DeviceId, doc: DocId, p: Path, h: Hash, base: Base)
    ensures
      var before := Document(Some(base), None, Some(Binding(p, h, false, None)), Never, None);
      var after := Document(Some(base), None, None, Released, None);
      var pre := State(map[d := Device(platform, false, Journal(map[doc := before], 0, [], []), map[], {}, {})],
                       Server(map[], map[], [], {}, map[]));
      var post := State(map[d := Device(platform, true, Journal(map[doc := after], 0, [], []), map[], {}, {})],
                        Server(map[], map[], [], {}, map[]));
      !G8_PicksUpOfflineChanges(Step(pre, Scan(d, map[]), [], post))
  {
    var before := Document(Some(base), None, Some(Binding(p, h, false, None)), Never, None);
    var pre := State(map[d := Device(platform, false, Journal(map[doc := before], 0, [], []), map[], {}, {})],
                     Server(map[], map[], [], {}, map[]));
    assert FileMissing(pre.devices[d], doc);
  }

  // G5: a remote create bound to a different local file of the same name
  // (one whose bytes are not the revision's) fails it.
  lemma G5RejectsJoinByName(d: DeviceId, platform: Platform, p: Path, doc: DocId, rev: Revision, f: DiskFile)
    requires rev.doc == doc && rev.path == p && rev.content != f.content
    ensures
      var pre := State(map[d := Device(platform, true, Journal(map[], 0, [], []), map[p := f], {}, {})],
                       Server(map[], map[], [], {}, map[]));
      var document := Document(Some(Base(rev.id, 1, p, rev.content, rev.kind, false)), None,
                               Some(Binding(p, rev.content, false, None)), Never, None);
      var post := State(map[d := Device(platform, true, Journal(map[doc := document], 1, [], []), map[p := f], {}, {})],
                        Server(map[], map[], [], {}, map[]));
      !G5_NeverMixedUp(Step(pre, RemoteRevision(d, rev), [], post))
  {
    var pre := State(map[d := Device(platform, true, Journal(map[], 0, [], []), map[p := f], {}, {})],
                     Server(map[], map[], [], {}, map[]));
    var document := Document(Some(Base(rev.id, 1, p, rev.content, rev.kind, false)), None,
                             Some(Binding(p, rev.content, false, None)), Never, None);
    var post := State(map[d := Device(platform, true, Journal(map[doc := document], 1, [], []), map[p := f], {}, {})],
                      Server(map[], map[], [], {}, map[]));
    assert p in post.devices[d].disk && SameF(platform, p, p);
    assert HasFile(post.devices[d], p);
    assert BoundFile(post.devices[d], doc) == Some(f);
    assert BoundIdentity(pre.devices[d], doc).None?;
  }

  // G5 on a user's step: the user renames an untracked file over a bound
  // one. The document's binding now names another file, which the user put
  // there; the run satisfies G5 (clause (g)), so the guarantee leaves the
  // user free to change the disk.
  lemma G5AllowsUserRenameOverBoundFile(
    d: DeviceId, platform: Platform, p: Path, q: Path, doc: DocId, h: Hash, f: DiskFile, g: DiskFile)
    requires !SameF(platform, p, q) && f.identity != g.identity
    ensures
      var journal := Journal(map[doc := Document(None, None, Some(Binding(p, h, false, None)), Never, None)], 0, [], []);
      var pre := State(map[d := Device(platform, true, journal, map[p := g, q := f], {}, {})],
                       Server(map[], map[], [], {}, map[]));
      var post := State(map[d := Device(platform, true, journal, map[p := f], {}, {})],
                        Server(map[], map[], [], {}, map[]));
      G5([Step(pre, User(d, RenameFile(q, p)), [], post)])
  {
    var journal := Journal(map[doc := Document(None, None, Some(Binding(p, h, false, None)), Never, None)], 0, [], []);
    var pre := State(map[d := Device(platform, true, journal, map[p := g, q := f], {}, {})],
                     Server(map[], map[], [], {}, map[]));
    var post := State(map[d := Device(platform, true, journal, map[p := f], {}, {})],
                      Server(map[], map[], [], {}, map[]));
    assert p in post.devices[d].disk && SameF(platform, p, p);
    assert BoundFile(post.devices[d], doc) == Some(f);
  }

  // G5 on a user's step does not excuse a binding moved to another file: a
  // user's step whose journal binds the document to a different file (an
  // untracked one) fails G5_NeverMixedUp.
  lemma G5RejectsRebindInUserStep(
    d: DeviceId, platform: Platform, p: Path, q: Path, doc: DocId, h: Hash, f: DiskFile, g: DiskFile)
    requires !SameF(platform, p, q) && f.identity != g.identity
    ensures
      var disk := map[p := g, q := f];
      var pre := State(map[d := Device(platform, true,
                         Journal(map[doc := Document(None, None, Some(Binding(p, h, false, None)), Never, None)], 0, [], []),
                         disk, {}, {})],
                       Server(map[], map[], [], {}, map[]));
      var post := State(map[d := Device(platform, true,
                          Journal(map[doc := Document(None, None, Some(Binding(q, h, false, None)), Never, None)], 0, [], []),
                          disk, {}, {})],
                        Server(map[], map[], [], {}, map[]));
      !G5_NeverMixedUp(Step(pre, User(d, EditBuffer(p, None)), [], post))
  {
    var disk := map[p := g, q := f];
    var pre := State(map[d := Device(platform, true,
                       Journal(map[doc := Document(None, None, Some(Binding(p, h, false, None)), Never, None)], 0, [], []),
                       disk, {}, {})],
                     Server(map[], map[], [], {}, map[]));
    var post := State(map[d := Device(platform, true,
                        Journal(map[doc := Document(None, None, Some(Binding(q, h, false, None)), Never, None)], 0, [], []),
                        disk, {}, {})],
                      Server(map[], map[], [], {}, map[]));
    assert SameF(platform, p, p) && SameF(platform, q, q);
    assert BoundFile(pre.devices[d], doc) == Some(g) by {
      forall r | r in disk && SameF(platform, r, p) ensures r == p {}
    }
    assert BoundFile(post.devices[d], doc) == Some(f) by {
      forall r | r in disk && SameF(platform, r, q) ensures r == q {}
    }
  }

  // G3: a reported delete of a bound file that is still at its name (a new
  // file was created there before the event arrived), recorded as the
  // user's delete, fails G3_DeleteSeen.
  lemma G3RejectsDeleteOfPresentFile(
    d: DeviceId, platform: Platform, p: Path, doc: DocId, h: Hash, f: DiskFile, outbox: Outbox)
    ensures
      var pre := State(map[d := Device(platform, true,
                         Journal(map[doc := Document(None, None, Some(Binding(p, h, false, None)), Never, None)], 0, [], []),
                         map[p := f], {}, {})],
                       Server(map[], map[], [], {}, map[]));
      var post := State(map[d := Device(platform, true,
                          Journal(map[doc := Document(None, None, None, UserDeleted, Some(outbox))], 0, [], []),
                          map[p := f], {}, {})],
                        Server(map[], map[], [], {}, map[]));
      !G3_DeleteSeen(Step(pre, Local(d, Deleted(p)), [], post))
  {
    var pre := State(map[d := Device(platform, true,
                       Journal(map[doc := Document(None, None, Some(Binding(p, h, false, None)), Never, None)], 0, [], []),
                       map[p := f], {}, {})],
                     Server(map[], map[], [], {}, map[]));
    var post := State(map[d := Device(platform, true,
                        Journal(map[doc := Document(None, None, None, UserDeleted, Some(outbox))], 0, [], []),
                        map[p := f], {}, {})],
                      Server(map[], map[], [], {}, map[]));
    assert RecordsUserDelete(Step(pre, Local(d, Deleted(p)), [], post), d, doc);
    assert p in pre.devices[d].disk && SameF(platform, p, p);
    assert HasFile(pre.devices[d], p);
  }

  // The server's step semantics (Engine.dfy, ServerFollowsEvent): a device
  // with a sealed outbox creating a new document gets it accepted; the
  // server appends that revision to the document's history, the feed and
  // what it accepted.
  lemma AcceptAppendsOutbox(d: DeviceId, platform: Platform, doc: DocId, o: Outbox, r: Revision)
    requires o.sealed && o.baseRev.None?
    requires r == Revision(o.rev, doc, 0, None, o.path, o.content, o.kind, o.deleted, d)
    ensures
      var empty := Server(map[], map[], [], {}, map[]);
      var device := Device(platform, true,
        Journal(map[doc := Document(None, None, None, Never, Some(o))], 0, [], []), map[], {}, {});
      var pre := State(map[d := device], empty);
      var post := State(map[d := device],
        Server(map[r.id := r], map[doc := [r.id]], [r.id], {}, map[r.id := r]));
      ServerFollowsEvent(Step(pre, Pushed(d, Accepted(doc, r)), [], post))
  {
    var empty := Server(map[], map[], [], {}, map[]);
    forall x ensures Head(empty, x).None? {}
    assert ParentIsHead(empty, doc, r.parent);
    assert Appendable(empty, doc, r);
    assert [] + [r.id] == [r.id];
    assert Appended(empty, doc, r) == Server(map[r.id := r], map[doc := [r.id]], [r.id], {}, map[r.id := r]);
  }

  // An accept that drops another revision from the server does not follow
  // its event.
  lemma ServerFollowsEventRejectsDroppingAccept(
    d: DeviceId, platform: Platform, doc: DocId, o: Outbox, r: Revision, prior: Revision)
    requires o.sealed && prior.id != r.id
    ensures
      var device := Device(platform, true,
        Journal(map[doc := Document(None, None, None, Never, Some(o))], 0, [], []), map[], {}, {});
      var pre := State(map[d := device],
        Server(map[prior.id := prior], map[prior.doc := [prior.id]], [prior.id], {}, map[prior.id := prior]));
      var post := State(map[d := device],
        Server(map[r.id := r], map[doc := [r.id]], [r.id], {}, map[r.id := r]));
      !ServerFollowsEvent(Step(pre, Pushed(d, Accepted(doc, r)), [], post))
  {
    var device := Device(platform, true,
      Journal(map[doc := Document(None, None, None, Never, Some(o))], 0, [], []), map[], {}, {});
    var pre := State(map[d := device],
      Server(map[prior.id := prior], map[prior.doc := [prior.id]], [prior.id], {}, map[prior.id := prior]));
    var post := State(map[d := device],
      Server(map[r.id := r], map[doc := [r.id]], [r.id], {}, map[r.id := r]));
    assert prior.id in Appended(pre.server, doc, r).revisions;
    assert prior.id !in post.server.revisions;
  }

  // A push answered "head moved" leaves the server unchanged: a step where
  // the server gained a revision anyway does not follow its event.
  lemma ServerFollowsEventRejectsChangeOnHeadMoved(d: DeviceId, doc: DocId, r: Revision, s: State)
    ensures
      var pre := s.(server := Server(map[], map[], [], {}, map[]));
      var post := s.(server := Server(map[r.id := r], map[doc := [r.id]], [r.id], {}, map[r.id := r]));
      !ServerFollowsEvent(Step(pre, Pushed(d, HeadMoved(doc)), [], post))
  {
    var post := s.(server := Server(map[r.id := r], map[doc := [r.id]], [r.id], {}, map[r.id := r]));
    assert r.id in post.server.revisions;
  }

  // G4: device A edits its file, then deletes it and pushes the tombstone;
  // A's later live commit on that tombstone, with nothing else in between,
  // fails it: A's own delete overruled the edit (m <= k).
  lemma G4RejectsOverruledEdit(
    a: DeviceId, platform: Platform, p: Path, doc: DocId, h: Hash, kind: Kind,
    tomb: Revision, live: Revision, s: State, t: State)
    requires tomb.doc == doc && tomb.deleted && live.doc == doc && !live.deleted
    ensures
      var document := Document(None, None, Some(Binding(p, h, false, None)), Never, None);
      var s0 := State(map[a := Device(platform, true, Journal(map[doc := document], 0, [], []), map[], {}, {})],
                      Server(map[], map[], [], {}, map[]));
      var s2 := State(map[], Server(map[tomb.id := tomb], map[doc := [tomb.id]], [tomb.id], {}, map[tomb.id := tomb]));
      !G4([
        Step(s0, User(a, WriteFile(p, h, kind)), [], s),
        Step(s, Pushed(a, Accepted(doc, tomb)), [], t),
        Step(s2, Pushed(a, Accepted(doc, live)), [], t)])
  {
    var document := Document(None, None, Some(Binding(p, h, false, None)), Never, None);
    var s0 := State(map[a := Device(platform, true, Journal(map[doc := document], 0, [], []), map[], {}, {})],
                    Server(map[], map[], [], {}, map[]));
    var s2 := State(map[], Server(map[tomb.id := tomb], map[doc := [tomb.id]], [tomb.id], {}, map[tomb.id := tomb]));
    var trace := [
      Step(s0, User(a, WriteFile(p, h, kind)), [], s),
      Step(s, Pushed(a, Accepted(doc, tomb)), [], t),
      Step(s2, Pushed(a, Accepted(doc, live)), [], t)];
    assert Head(s2.server, doc) == Some(tomb);
    assert Resurrects(trace[2]);
    assert CommittedBy(trace[1], a, doc);
  }

  // G1: a sync step that removes an accepted revision from the server, with
  // no copy of its bytes anywhere, fails it.
  lemma G1Rejects(rev: Revision, d: DeviceId)
    ensures
      var pre := State(map[], Server(map[rev.id := rev], map[rev.doc := [rev.id]], [rev.id], {}, map[rev.id := rev]));
      var post := State(map[], Server(map[], map[], [], {}, map[rev.id := rev]));
      !G1_OnlyRetentionRemoves(Step(pre, SyncRound(d), [], post))
  {
    var pre := State(map[], Server(map[rev.id := rev], map[rev.doc := [rev.id]], [rev.id], {}, map[rev.id := rev]));
    var post := State(map[], Server(map[], map[], [], {}, map[rev.id := rev]));
    assert rev.doc in pre.server.history && pre.server.history[rev.doc][0] == rev.id;
    assert InHistory(pre.server, rev.id);
    assert Retrievable(pre, rev.id);
    forall x ensures Head(post.server, x).None? {}
    assert !Retrievable(post, rev.id);
  }
}

// FreshIdentityExists is consistent: with natural numbers as identities,
// one more than the largest used is unused.
abstract module NatIdentities refines EngineModel {
  type FileIdentity = nat

  lemma Bound(used: set<nat>) returns (bound: nat)
    ensures forall i :: i in used ==> i < bound
    decreases used
  {
    if used == {} {
      bound := 0;
    } else {
      var i :| i in used;
      var rest := Bound(used - {i});
      bound := if i + 1 > rest then i + 1 else rest;
      forall j | j in used ensures j < bound {
        if j != i { assert j in used - {i}; }
      }
    }
  }

  lemma FreshIdentityExists(used: set<FileIdentity>)
    ensures exists identity: FileIdentity :: identity !in used
  {
    var bound := Bound(used);
    assert bound !in used;
  }
}
