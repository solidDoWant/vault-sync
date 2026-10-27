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
