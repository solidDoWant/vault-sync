// The push half of the sync round (#991, docs/design/verified-core.md §3.8):
// it creates a document for every untracked file the round's listing names,
// with an id from the shell's supply of fresh document ids, and seals and
// sends every outbox waiting to be sent. The step theorem of the whole
// round, which composes this half with the pull apply (#990), is #982's.
//
// The lemmas prove, on the push function itself:
// - every new document's id comes from the round's fresh ids and is new to
//   the journal (RoundInputOf), and every row, new or changed, keeps the
//   core's row invariant (CoreInv: AheadOfBase and OutboxCurrent included);
// - every commit the push requests sends a sealed outbox that an earlier
//   PersistJournal effect holds (#977's obligation, verified-core.md §3.2):
//   the commit in flight is on record before the request, so an accept in
//   the model always answers it.
include "RemoteEvents.dfy"

abstract module PushCore refines RemoteCore {

  // ---------------------------------------------------------------------
  // A deterministic order (compiled)
  // ---------------------------------------------------------------------

  // Effects are a sequence and fresh ids are handed out in order, but paths
  // and document ids are abstract. The core takes untracked files and
  // commits in a fixed order so that it is a function of its input. Any
  // strict total order will do: the compiled core uses string comparison.
  function PathBefore(a: Path, b: Path): bool
  function DocBefore(a: DocId, b: DocId): bool

  ghost predicate StrictTotal<T(!new)>(before: (T, T) -> bool) {
    (forall a :: !before(a, a))
    && (forall a, b, c :: before(a, b) && before(b, c) ==> before(a, c))
    && (forall a, b :: a != b ==> before(a, b) || before(b, a))
  }

  // Sound because every type has a strict total order; string comparison
  // is one for the compiled core's paths and ids.
  lemma {:axiom} PathOrder()
    ensures StrictTotal((a, b) => PathBefore(a, b))

  lemma {:axiom} DocOrder()
    ensures StrictTotal((a, b) => DocBefore(a, b))

  ghost predicate IsLeast<T(!new)>(before: (T, T) -> bool, s: set<T>, x: T) {
    x in s && forall y :: y in s && y != x ==> before(x, y)
  }

  lemma LeastExists<T(!new)>(before: (T, T) -> bool, s: set<T>)
    requires StrictTotal(before) && s != {}
    ensures exists x :: IsLeast(before, s, x)
    decreases |s|
  {
    var y := var y0 :| y0 in s; y0;
    if s - {y} == {} {
      assert forall z :: z in s ==> z == y by {
        forall z | z in s ensures z == y {
          if z != y { assert z in s - {y}; }
        }
      }
      assert IsLeast(before, s, y);
    } else {
      LeastExists(before, s - {y});
      var x := var x0 :| IsLeast(before, s - {y}, x0); x0;
      if before(x, y) {
        assert IsLeast(before, s, x);
      } else {
        assert IsLeast(before, s, y);
      }
    }
  }

  lemma LeastUnique<T(!new)>(before: (T, T) -> bool, s: set<T>, x: T, x': T)
    requires StrictTotal(before) && IsLeast(before, s, x) && IsLeast(before, s, x')
    ensures x == x'
  {
    if x != x' {
      assert before(x, x') && before(x', x);
      assert before(x, x);
    }
  }

  predicate LeastPathOf(s: set<Path>, x: Path) {
    x in s && forall y | y in s && y != x :: PathBefore(x, y)
  }

  lemma LeastPathFacts(s: set<Path>)
    requires s != {}
    ensures exists x :: LeastPathOf(s, x)
    ensures forall x, x' :: LeastPathOf(s, x) && LeastPathOf(s, x') ==> x == x'
  {
    PathOrder();
    var before := (a, b) => PathBefore(a, b);
    LeastExists(before, s);
    var least := var x0 :| IsLeast(before, s, x0); x0;
    assert LeastPathOf(s, least);
    forall x, x' | LeastPathOf(s, x) && LeastPathOf(s, x') ensures x == x' {
      LeastUnique(before, s, x, x');
    }
  }

  function LeastPath(s: set<Path>): (x: Path)
    requires s != {}
    ensures x in s
  {
    LeastPathFacts(s);
    var x :| LeastPathOf(s, x); x
  }

  predicate LeastDocOf(s: set<DocId>, x: DocId) {
    x in s && forall y | y in s && y != x :: DocBefore(x, y)
  }

  lemma LeastDocFacts(s: set<DocId>)
    requires s != {}
    ensures exists x :: LeastDocOf(s, x)
    ensures forall x, x' :: LeastDocOf(s, x) && LeastDocOf(s, x') ==> x == x'
  {
    DocOrder();
    var before := (a, b) => DocBefore(a, b);
    LeastExists(before, s);
    var least := var x0 :| IsLeast(before, s, x0); x0;
    assert LeastDocOf(s, least);
    forall x, x' | LeastDocOf(s, x) && LeastDocOf(s, x') ensures x == x' {
      LeastUnique(before, s, x, x');
    }
  }

  function LeastDoc(s: set<DocId>): (x: DocId)
    requires s != {}
    ensures x in s
  {
    LeastDocFacts(s);
    var x :| LeastDocOf(s, x); x
  }

  // The document ids of `s` in order.
  function DocsInOrder(s: set<DocId>): (docs: seq<DocId>)
    ensures forall doc :: doc in docs <==> doc in s
    decreases |s|
  {
    if s == {} then []
    else
      var doc := LeastDoc(s);
      [doc] + DocsInOrder(s - {doc})
  }

  // ---------------------------------------------------------------------
  // New documents (compiled)
  // ---------------------------------------------------------------------

  // The listed files no document is bound to (under F): the push creates
  // their documents (verified-core.md §3.3).
  function Untracked(platform: Platform, docs: map<DocId, Document>, listing: Listing): set<Path> {
    set p | p in listing && !TrackedIn(platform, docs, p)
  }

  // A new document for the untracked file at `p`: bound to it, with an
  // outbox that creates it on the server (no base, so no parent). The
  // document's kind is the file's.
  function NewDocument(p: Path, file: (Hash, Kind), rev: RevId): Document {
    Document(None, None, Some(Binding(p, file.0, false, None)), Never,
             Some(Outbox(rev, None, p, file.0, file.1, false, false, false)))
  }

  // The new documents: the untracked files in order, each with the next
  // fresh id, until the files or the ids run out (the files left wait for
  // the next round's ids).
  function Creates(files: set<Path>, ids: seq<DocId>): (creates: map<DocId, Path>)
    ensures creates.Keys <= set i | 0 <= i < |ids| :: ids[i]
    ensures forall doc :: doc in creates ==> creates[doc] in files
    decreases |ids|
  {
    if files == {} || |ids| == 0 then map[]
    else
      var p := LeastPath(files);
      var rest := Creates(files - {p}, ids[1..]);
      assert forall doc :: doc in rest.Keys ==> doc in ids;
      rest[ids[0] := p]
  }

  function Created(platform: Platform, journal: Journal, input: RoundInput, revs: FreshRevs): map<DocId, Document>
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
  {
    var creates := Creates(Untracked(platform, journal.documents, input.listing), input.freshDocs);
    map doc | doc in journal.documents.Keys + creates.Keys ::
      if doc in journal.documents then journal.documents[doc]
      else NewDocument(creates[doc], input.listing[creates[doc]], revs[doc])
  }

  // ---------------------------------------------------------------------
  // Sealing and sending (compiled)
  // ---------------------------------------------------------------------

  // An outbox the push sends: one not in flight yet, and not refused as
  // invalid (a rejected outbox waits for a local change, SPEC.md §6.2).
  predicate Sendable(document: Document) {
    document.outbox.Some? && !document.outbox.value.sealed && !document.outbox.value.rejected
  }

  // Sealing makes the outbox the commit in flight: it is no longer edited
  // (Send), and an answer to it is an answer to this commit.
  function Seal(document: Document): Document {
    if Sendable(document) then document.(outbox := Some(document.outbox.value.(sealed := true)))
    else document
  }

  function Commits(docs: seq<DocId>, journal: Journal): seq<Effect>
    requires forall doc :: doc in docs ==> doc in journal.documents && journal.documents[doc].outbox.Some?
  {
    seq(|docs|, i requires 0 <= i < |docs| => Commit(docs[i], journal.documents[docs[i]].outbox.value))
  }

  // The push half's answer: the journal with the new documents and every
  // sendable outbox sealed, persisted, and only then the commits of the
  // outboxes it sealed, in order.
  function OnPush(platform: Platform, journal: Journal, input: RoundInput, revs: FreshRevs): (Journal, seq<Effect>)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
  {
    var docs := Created(platform, journal, input, revs);
    var sending := set doc | doc in docs && Sendable(docs[doc]);
    var journal' := journal.(documents := map doc | doc in docs :: Seal(docs[doc]));
    (journal', [PersistJournal(journal')] + Commits(DocsInOrder(sending), journal'))
  }

  // ---------------------------------------------------------------------
  // New documents: fresh ids, and the row invariant
  // ---------------------------------------------------------------------

  // The ids of the documents the push created.
  ghost function NewDocs(journal: Journal, journal': Journal): set<DocId> {
    journal'.documents.Keys - journal.documents.Keys
  }

  lemma CreatesFacts(files: set<Path>, ids: seq<DocId>)
    ensures forall doc :: doc in Creates(files, ids) ==> exists i :: 0 <= i < |ids| && ids[i] == doc
  {}

  // A round's fresh ids are new to the device's journal (RoundInputOf: no
  // device's journal uses them).
  lemma RoundIdsAreNew(state: State, d: DeviceId, input: RoundInput)
    requires RoundInputOf(state, d, input)
    ensures forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] !in state.devices[d].journal.documents
  {
    forall i | 0 <= i < |input.freshDocs|
      ensures input.freshDocs[i] !in state.devices[d].journal.documents
    {
      if input.freshDocs[i] in state.devices[d].journal.documents {
        assert DocIdUsed(state, input.freshDocs[i]);
      }
    }
  }

  // Criterion 1: every document the push creates has an id from the shell's
  // supply of fresh ids, and is bound to an untracked listed file; every
  // row, new or old, keeps RowInv when it did before (so CoreInv, including
  // AheadOfBase and OutboxCurrent, is kept).
  lemma PushCreatesFromFreshIds(platform: Platform, journal: Journal, input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    requires forall doc :: doc in journal.documents ==> RowInv(journal.documents[doc])
    ensures var journal' := OnPush(platform, journal, input, revs).0;
      journal.documents.Keys <= journal'.documents.Keys
      && (forall doc :: doc in NewDocs(journal, journal') ==>
            (exists i :: 0 <= i < |input.freshDocs| && input.freshDocs[i] == doc)
            && journal'.documents[doc].binding.Some?
            && var p := journal'.documents[doc].binding.value.spelling;
            p in input.listing && !TrackedIn(platform, journal.documents, p)
            && journal'.documents[doc].binding.value.seen == input.listing[p].0
            && journal'.documents[doc].base.None? && journal'.documents[doc].ahead.None?
            && journal'.documents[doc].outbox
               == Some(Outbox(revs[doc], None, p, input.listing[p].0, input.listing[p].1, false, true, false)))
      && (forall doc :: doc in journal.documents ==> journal'.documents[doc] == Seal(journal.documents[doc]))
      && (forall doc :: doc in journal'.documents ==> RowInv(journal'.documents[doc]))
  {
    var files := Untracked(platform, journal.documents, input.listing);
    var creates := Creates(files, input.freshDocs);
    CreatesFacts(files, input.freshDocs);
    var docs := Created(platform, journal, input, revs);
    var journal' := OnPush(platform, journal, input, revs).0;
    forall doc | doc in docs ensures RowInv(docs[doc]) {
      if doc !in journal.documents {
        }
    }
    forall doc | doc in journal'.documents ensures RowInv(journal'.documents[doc]) {
      SealKeepsRow(docs[doc]);
    }
    forall doc | doc in NewDocs(journal, journal')
      ensures doc in creates && journal'.documents[doc] == Seal(NewDocument(creates[doc], input.listing[creates[doc]], revs[doc]))
    {}
    forall doc | doc in NewDocs(journal, journal') ensures creates[doc] in files {
    }
  }

  // CoreInv is kept on the round's device: with the round's input, and
  // whatever the other devices' journals hold.
  lemma PushKeepsCoreInv(pre: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires CoreInv(pre) && RoundInputOf(pre, d, input)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures CoreInv(After(pre, d, OnPush(pre.devices[d].platform, pre.devices[d].journal, input, revs).0))
  {
    var device := pre.devices[d];
    var post := After(pre, d, OnPush(device.platform, device.journal, input, revs).0);
    CoreInvRows(pre);
    PushCreatesFromFreshIds(device.platform, device.journal, input, revs);
    CoreInvRows(post);
  }

  lemma SealKeepsRow(document: Document)
    requires RowInv(document)
    ensures RowInv(Seal(document))
  {}

  // With the round's input, the ids are those of RoundInputOf: fresh to the
  // device's journal, so every new document is one the journal did not
  // know, and it has the id the shell supplied.
  lemma RoundCreatesFreshDocuments(state: State, d: DeviceId, input: RoundInput, revs: FreshRevs)
    requires RoundInputOf(state, d, input)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures var journal := state.devices[d].journal;
      var journal' := OnPush(state.devices[d].platform, journal, input, revs).0;
      forall doc :: doc in journal'.documents && doc !in journal.documents ==>
        exists i :: 0 <= i < |input.freshDocs| && input.freshDocs[i] == doc && !DocIdUsed(state, doc)
  {}

  // ---------------------------------------------------------------------
  // Sealed commits, persisted before they are sent (#977)
  // ---------------------------------------------------------------------

  // Every commit in `effects` sends a sealed outbox, and an earlier effect
  // persists a journal that holds that outbox as the document's.
  ghost predicate CommitsPersistedFirst(effects: seq<Effect>) {
    forall i :: 0 <= i < |effects| && effects[i].Commit? ==>
      effects[i].outbox.sealed
      && exists j :: 0 <= j < i && effects[j].PersistJournal?
           && effects[i].doc in effects[j].journal.documents
           && effects[j].journal.documents[effects[i].doc].outbox == Some(effects[i].outbox)
  }

  // Criterion 2: every commit the push requests is the document's sealed
  // outbox, which the journal persisted by its first effect holds.
  lemma PushCommitsSealedPersisted(platform: Platform, journal: Journal, input: RoundInput, revs: FreshRevs)
    requires forall i :: 0 <= i < |input.freshDocs| ==> input.freshDocs[i] in revs
    ensures var answer := OnPush(platform, journal, input, revs);
      CommitsPersistedFirst(answer.1)
      && (forall i :: 0 <= i < |answer.1| && answer.1[i].Commit? ==>
            answer.1[i].doc in answer.0.documents
            && answer.0.documents[answer.1[i].doc].outbox == Some(answer.1[i].outbox))
  {
    var docs := Created(platform, journal, input, revs);
    var sending := set doc | doc in docs && Sendable(docs[doc]);
    var answer := OnPush(platform, journal, input, revs);
    var journal' := answer.0;
    var order := DocsInOrder(sending);
    var commits := Commits(order, journal');
    assert answer.1 == [PersistJournal(journal')] + commits;
    forall i | 0 <= i < |answer.1| && answer.1[i].Commit?
      ensures answer.1[i].outbox.sealed
      ensures answer.1[i].doc in journal'.documents
      ensures journal'.documents[answer.1[i].doc].outbox == Some(answer.1[i].outbox)
      ensures answer.1[0].PersistJournal? && answer.1[0].journal == journal'
    {
      assert i > 0;
      var doc := order[i - 1];
      assert answer.1[i] == commits[i - 1];
      assert doc in sending;
    }
  }
}
