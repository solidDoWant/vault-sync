// The verified core's handling of a remote revision delivered outside a sync
// round (#949, docs/design/verified-core.md §3.4). It builds on the local
// core (#948): the same step shape (only the event's device's journal is
// replaced, disks follow the effects) and the same invariant CoreInv.
//
// Status: first part. A remote revision newer than everything the device
// knows of its document is recorded as the document's `ahead`; the core
// requests no disk effect for it yet. Applying it to disk needs the single
// path-conflict function (#962), and push results need the server's accept
// semantics, a design gap recorded on #949.
include "LocalEvents.dfy"

abstract module RemoteCore {
  import opened L : LocalCore
  import opened L.P

  // ---------------------------------------------------------------------
  // The core (compiled)
  // ---------------------------------------------------------------------

  // The newest server position of a document the device knows: its ahead,
  // else its base.
  function KnownPosition(document: Document): Option<nat> {
    if document.ahead.Some? then Some(document.ahead.value.revision.position)
    else if document.base.Some? then Some(document.base.value.position)
    else None
  }

  // The revision is newer than everything the device knows of its document.
  predicate Newer(document: Document, revision: Revision) {
    KnownPosition(document).None? || KnownPosition(document).value < revision.position
  }

  // The device has a change of the document the server has not got (in the
  // journal: something to send, or a user's delete).
  predicate JournalChange(document: Document) {
    document.outbox.Some? || document.absence == UserDeleted
  }

  // Why a newer revision waits: local changes, or (for now) the apply that
  // needs the path rule of #962, marked postponed.
  function Waiting(document: Document, revision: Revision): Ahead {
    if JournalChange(document) then Ahead(revision, LocalChanges, false)
    else Ahead(revision, PathHeld, true)
  }

  // One document's row after a remote revision of it.
  function RemoteDoc(document: Document, revision: Revision): Document {
    if Newer(document, revision) then document.(ahead := Some(Waiting(document, revision)))
    else document
  }

  function RemoteJournal(journal: Journal, revision: Revision): Journal {
    var doc := revision.doc;
    var document := if doc in journal.documents then journal.documents[doc]
                    else Document(None, None, None, Never, None);
    var document' := RemoteDoc(document, revision);
    if doc !in journal.documents && document' == document then journal
    else journal.(documents := journal.documents[doc := document'])
  }

  // The core's answer to a remote revision: the new journal, and the effects.
  function OnRemote(journal: Journal, revision: Revision): (Journal, seq<Effect>) {
    var journal' := RemoteJournal(journal, revision);
    (journal', [PersistJournal(journal')])
  }

  // ---------------------------------------------------------------------
  // The step
  // ---------------------------------------------------------------------

  ghost function RemoteStep(pre: State, d: DeviceId, revision: Revision): Step
    requires d in pre.devices
  {
    var answer := OnRemote(pre.devices[d].journal, revision);
    Step(pre, RemoteRevision(d, revision), answer.1, After(pre, d, answer.0))
  }

  // ---------------------------------------------------------------------
  // The theorem for remote revisions
  // ---------------------------------------------------------------------

  lemma RemoteRevisionSafe(pre: State, d: DeviceId, revision: Revision)
    requires d in pre.devices
    requires StateInvariants(pre) && CoreInv(pre)
    ensures var step := RemoteStep(pre, d, revision);
      StateInvariants(step.post) && CoreInv(step.post) && StepGuarantees(step)
  {
    var step := RemoteStep(pre, d, revision);
    var journal := pre.devices[d].journal;
    var journal' := RemoteJournal(journal, revision);
    assert step.post == After(pre, d, journal');
    assert step.effects == [PersistJournal(journal')];
    forall doc | doc in journal'.documents
      ensures doc in journal.documents ==> AheadOnlyRow(journal.documents[doc], journal'.documents[doc])
      ensures doc !in journal.documents ==> NewAheadRow(journal'.documents[doc])
    {}
    AheadOnlyStep(step, d, journal');
  }

  // ---------------------------------------------------------------------
  // Steps that only record what the server has
  // ---------------------------------------------------------------------

  // A row update that only records a newer server revision as waiting, for
  // a reason that is not "cannot hold" (so the device has not finished).
  ghost predicate AheadOnlyRow(before: Document, after: Document) {
    after == before
    || (after == before.(ahead := after.ahead) && after.ahead.Some? && !CannotHold(after.ahead.value.blocker))
  }

  // A new row that only records a waiting server revision.
  ghost predicate NewAheadRow(after: Document) {
    after.base.None? && after.binding.None? && after.absence == Never && after.outbox.None?
    && after.ahead.Some? && !CannotHold(after.ahead.value.blocker)
  }

  // A step whose post is pre with d's journal replaced by `journal'`, whose
  // only effect persists the journal, and which changes rows only by
  // recording a waiting revision, keeps every invariant and satisfies every
  // step predicate.
  lemma AheadOnlyStep(step: Step, d: DeviceId, journal': Journal)
    requires d in step.pre.devices && EventDevice(step.event) == Some(d)
    requires !step.event.User? && !step.event.Restart? && !step.event.SyncRound?
    requires !step.event.Local? && !step.event.Scan?
    requires step.post == After(step.pre, d, journal') && step.effects == [PersistJournal(journal')]
    requires StateInvariants(step.pre) && CoreInv(step.pre)
    requires var journal := step.pre.devices[d].journal;
      journal.documents.Keys <= journal'.documents.Keys
      && journal' == journal.(documents := journal'.documents)
      && (forall doc :: doc in journal.documents ==> AheadOnlyRow(journal.documents[doc], journal'.documents[doc]))
      && (forall doc :: doc in journal'.documents && doc !in journal.documents ==> NewAheadRow(journal'.documents[doc]))
    ensures StateInvariants(step.post) && CoreInv(step.post) && StepGuarantees(step)
  {
    var pre := step.pre;
    var post := step.post;
    var journal := pre.devices[d].journal;
    var before := pre.devices[d];
    var after := post.devices[d];
    assert forall x :: x in pre.devices ==> x in post.devices && post.devices[x].disk == pre.devices[x].disk;
    forall x | x in post.devices && x != d ensures post.devices[x] == pre.devices[x] {}
    // G1: no disk and no server changed.
    forall rev | rev in pre.server.accepted
      ensures Retrievable(pre, rev) <==> Retrievable(post, rev)
    {
      var version := pre.server.accepted[rev];
      if exists x :: x in pre.devices && OnDisk(pre.devices[x], version.content) {
        var x :| x in pre.devices && OnDisk(pre.devices[x], version.content);
        assert OnDisk(post.devices[x], version.content);
      }
      if exists x :: x in post.devices && OnDisk(post.devices[x], version.content) {
        var x :| x in post.devices && OnDisk(post.devices[x], version.content);
        assert OnDisk(pre.devices[x], version.content);
      }
    }
    assert G1_Retained(post);
    assert G7_OneFilePerName(post);
    // Bindings are unchanged, so every binding-reading predicate carries over.
    assert forall doc :: (doc in journal'.documents && journal'.documents[doc].binding.Some?) <==>
                         (doc in journal.documents && journal.documents[doc].binding.Some?);
    assert forall doc :: doc in journal.documents && journal.documents[doc].binding.Some? ==>
                         journal'.documents[doc].binding == journal.documents[doc].binding;
    assert after.disk == before.disk && after.platform == before.platform;
    forall doc ensures BoundIdentity(after, doc) == BoundIdentity(before, doc) {
      if doc in journal.documents && journal.documents[doc].binding.Some? {
        var s := journal.documents[doc].binding.value.spelling;
        assert after.journal.documents[doc].binding.value.spelling == s;
        assert HasFile(after, s) == HasFile(before, s);
        if HasFile(before, s) { SameFileOnSameDisk(before, after, s); }
      } else {
        assert BoundFile(before, doc).None?;
        assert !(doc in after.journal.documents && after.journal.documents[doc].binding.Some?);
      }
      assert BoundFile(after, doc) == BoundFile(before, doc);
    }
    forall p ensures Tracked(after, p) == Tracked(before, p) {
      if Tracked(after, p) { var doc :| BoundTo(after, doc, p); assert BoundTo(before, doc, p); }
      if Tracked(before, p) { var doc :| BoundTo(before, doc, p); assert BoundTo(after, doc, p); }
    }
    assert G5_NeverJoined(post);
    assert G5_NeverMixedUp(step);
    // G6: no base changes, so no step settles anything.
    forall x, doc, remote | SettlesConcurrent(step, x, doc, remote)
      ensures G6_Settle(step, x, doc, remote)
    {
      assert x == d;
      assert doc in journal.documents;
      assert false;
    }
    // G9: either nothing changed, or d waits on a revision it can hold.
    if journal' == journal {
      assert post == pre;
    } else {
      var doc :| doc in journal'.documents && (doc !in journal.documents || journal'.documents[doc] != journal.documents[doc]) by {
        if forall doc :: doc in journal'.documents ==> doc in journal.documents && journal'.documents[doc] == journal.documents[doc] {
          assert journal'.documents == journal.documents;
          assert journal' == journal;
        }
      }
      assert journal'.documents[doc].ahead.Some? && !CannotHold(journal'.documents[doc].ahead.value.blocker);
      assert !FinishedSyncing(post, d);
      forall d1, d2, p | FinishedSyncing(post, d1) && FinishedSyncing(post, d2)
        && p in post.devices[d1].disk && p !in post.devices[d1].outOfScope && p !in post.devices[d2].outOfScope
        ensures (exists q :: q in post.devices[d2].disk
                   && (SameNameModuloFolders(post.devices[d1].platform, p, q) || SameNameModuloFolders(post.devices[d2].platform, p, q))
                   && post.devices[d2].disk[q].content == post.devices[d1].disk[p].content)
                || ReportedCannotHold(post, post.devices[d2], p)
      {
        assert d1 != d && d2 != d;
        assert FinishedSyncing(pre, d1) && FinishedSyncing(pre, d2);
      }
    }
    // DisksFollowEffects: the one effect leaves the disk as it is.
    var disk := before.disk;
    assert EffectTakes(before.platform, disk, PersistJournal(journal'), disk);
    assert EffectsTake(before.platform, disk, step.effects[1..], disk);
    assert EffectsTake(before.platform, disk, step.effects, disk);
  }
}
