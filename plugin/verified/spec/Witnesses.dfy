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
}
