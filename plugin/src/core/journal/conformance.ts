import type { ConflictRecord, DeferredRevision, DocumentState, Journal, JournalChanges, PendingOperation } from "./journal";

/**
 * Shared Journal conformance suite, run against every implementation (the
 * in-memory journal and the IndexedDB one, under vitest and inside
 * Obsidian). It is framework-agnostic (no vitest or Node imports), like the
 * VaultAdapter suite. Each case gets a fresh, empty journal from the harness
 * factory and throws on failure.
 */
export interface JournalHarness {
  journal: Journal;
  /**
   * The same journal as a restarted app sees it: for a durable journal, a new
   * connection to the same storage. A case calls it after its writes, so
   * everything it checks must have survived the restart. Omit for a journal
   * that is not durable; the case then keeps checking the original one.
   */
  reopen?: () => Promise<Journal>;
  /** Releases the journal after the case. */
  dispose?: () => Promise<void> | void;
}

export type JournalFactory = () => Promise<JournalHarness> | JournalHarness;

export interface JournalConformanceCase {
  name: string;
  /** `reopen` returns the journal to check after the case's writes (the same object for a non-durable journal). */
  run: (journal: Journal, reopen: () => Promise<Journal>) => Promise<void>;
}

/** Runs one case against a fresh journal from `factory`, disposing it afterwards. */
export async function runJournalConformanceCase(testCase: JournalConformanceCase, factory: JournalFactory): Promise<void> {
  const harness = await factory();
  try {
    await testCase.run(harness.journal, harness.reopen ?? (() => Promise.resolve(harness.journal)));
  } finally {
    await harness.dispose?.();
  }
}

export class JournalConformanceFailure extends Error {
  override readonly name = "JournalConformanceFailure";
}

/** JSON with bigints marked and object keys sorted, so equal values describe equally. */
export function describeValue(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (typeof item === "bigint") return `${String(item)}n`;
    if (item === undefined) return "<undefined>";
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (describeValue(actual) !== describeValue(expected)) {
    throw new JournalConformanceFailure(`${what}: expected ${describeValue(expected)}, got ${describeValue(actual)}`);
  }
}

async function assertRejects(promise: Promise<unknown>, errorType: new (...args: never[]) => Error, what: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof errorType) return;
    throw new JournalConformanceFailure(`${what}: expected ${errorType.name}, got ${String(error)}`);
  }
  throw new JournalConformanceFailure(`${what}: expected ${errorType.name}, but it succeeded`);
}

export const sampleDocument = (overrides: Partial<DocumentState> = {}): DocumentState => ({
  documentId: "doc-1",
  path: "note.md",
  revisionId: "rev-1",
  seq: 1n,
  baseHash: "aa",
  size: 2n,
  kind: "text",
  deleted: false,
  ...overrides,
});

export const samplePending = (overrides: Partial<PendingOperation> = {}): PendingOperation => ({
  revisionId: "rev-2",
  documentId: "doc-1",
  baseRevisionId: "rev-1",
  path: "note.md",
  contentHash: "bb",
  size: 2n,
  kind: "text",
  deleted: false,
  ...overrides,
});

export const sampleDeferred = (documentId: string, revisionId: string, overrides: Partial<DeferredRevision> = {}): DeferredRevision => ({
  reason: "local-changes",
  revision: {
    revisionId,
    documentId,
    seq: 7n,
    parentRevisionId: "rev-1",
    kind: "text",
    path: "note.md",
    deleted: false,
    contentHash: "cc",
    size: 3n,
  },
  ...overrides,
});

export const sampleConflict = (id: string, overrides: Partial<ConflictRecord> = {}): ConflictRecord => ({
  id,
  documentId: "doc-1",
  path: "note.md",
  reason: "overlapping-edits",
  copyPath: "note (conflict laptop 2026-10-18 040506).md",
  copyHash: "ee",
  remoteRevisionId: "rev-3",
  at: 1,
  ...overrides,
});

const ids = (states: { documentId: string }[]) => states.map((state) => state.documentId).sort();

export const journalConformance: readonly JournalConformanceCase[] = [
  {
    name: "cursor starts at zero",
    run: async (journal) => {
      assertEqual(await journal.getCursor(), 0n, "initial cursor");
    },
  },
  {
    name: "cursor advances and never moves backwards",
    run: async (journal, reopen) => {
      await journal.setCursor(5n);
      await journal.setCursor(5n);
      await assertRejects(journal.setCursor(4n), RangeError, "setCursor below the cursor");
      const reopened = await reopen();
      assertEqual(await reopened.getCursor(), 5n, "cursor after a refused move backwards");
      await assertRejects(reopened.setCursor(4n), RangeError, "setCursor below the stored cursor");
    },
  },
  {
    name: "cursor moves backwards only through an explicit reset",
    run: async (journal, reopen) => {
      await journal.setCursor(9n);
      await journal.resetCursor(3n);
      assertEqual(await (await reopen()).getCursor(), 3n, "cursor after reset");
    },
  },
  {
    name: "cursor anchor is stored with the cursor and replaced or cleared with it",
    run: async (initial, reopen) => {
      let journal = initial;
      assertEqual(await journal.getCursorAnchor(), undefined, "initial anchor");
      const first = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const second = new Uint8Array(16).fill(7);
      await journal.setCursor(5n, first);
      first.fill(0);
      journal = await reopen();
      assertEqual(await journal.getCursorAnchor(), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), "anchor after a reopen, not aliased to the caller's array");
      await journal.setCursor(6n, second);
      journal = await reopen();
      assertEqual(await journal.getCursorAnchor(), second, "anchor of the advanced cursor");
      await journal.setCursor(7n);
      journal = await reopen();
      assertEqual(await journal.getCursorAnchor(), undefined, "a cursor set without an anchor has none");
      await journal.resetCursor(3n, second);
      journal = await reopen();
      assertEqual(await journal.getCursorAnchor(), second, "anchor of a reset cursor");
      await assertRejects(journal.setCursor(2n, first), RangeError, "setCursor below the cursor");
      journal = await reopen();
      assertEqual(await journal.getCursorAnchor(), second, "a refused move keeps the anchor");
      await journal.resetCursor(1n);
      journal = await reopen();
      assertEqual(await journal.getCursorAnchor(), undefined, "a cursor reset without an anchor has none");
    },
  },
  {
    name: "cursor keeps the full range of seq values",
    run: async (journal, reopen) => {
      const max = 2n ** 63n - 1n;
      await journal.setCursor(max);
      assertEqual(await (await reopen()).getCursor(), max, "cursor at the largest seq");
    },
  },
  {
    name: "stores, replaces and finds document state by id and path",
    run: async (journal, reopen) => {
      await journal.putDocument(sampleDocument());
      await journal.putDocument(sampleDocument({ documentId: "doc-2", path: "other.md" }));
      await journal.putDocument(sampleDocument({ path: "renamed.md", revisionId: "rev-3" }));

      const reopened = await reopen();
      assertEqual(await reopened.getDocument("doc-1"), sampleDocument({ path: "renamed.md", revisionId: "rev-3" }), "replaced document");
      assertEqual(await reopened.findDocumentByPath("renamed.md"), sampleDocument({ path: "renamed.md", revisionId: "rev-3" }), "document by its new path");
      assertEqual(await reopened.findDocumentByPath("note.md"), undefined, "document by its old path");
      assertEqual(await reopened.getDocument("missing"), undefined, "unknown document");
      assertEqual(ids(await reopened.listDocuments()), ["doc-1", "doc-2"], "listed documents");
    },
  },
  {
    name: "keeps every field of document state, including large sizes and seqs",
    run: async (journal, reopen) => {
      const state = sampleDocument({ seq: 2n ** 62n + 1n, size: 2n ** 53n + 1n, kind: "blob", deleted: true, path: "a/b c/ü.png" });
      await journal.putDocument(state);
      const read = await (await reopen()).getDocument("doc-1");
      assertEqual(read, state, "stored document");
      assertEqual(typeof read?.seq, "bigint", "type of seq");
    },
  },
  {
    name: "keeps a document state's anchor, not aliased to the caller's array, and none when it has none",
    run: async (journal, reopen) => {
      const anchor = new Uint8Array(16).fill(9);
      await journal.putDocument(sampleDocument({ anchor }));
      await journal.putDocument(sampleDocument({ documentId: "doc-2", path: "other.md" }));
      anchor.fill(0);
      const reopened = await reopen();
      assertEqual((await reopened.getDocument("doc-1"))?.anchor, new Uint8Array(16).fill(9), "stored anchor");
      assertEqual((await reopened.listDocuments()).map((state) => state.anchor), [new Uint8Array(16).fill(9), undefined], "listed anchors");
      const read = await reopened.getDocument("doc-1");
      read?.anchor?.fill(1);
      assertEqual((await reopened.getDocument("doc-1"))?.anchor, new Uint8Array(16).fill(9), "anchor after the caller changed a read copy");
    },
  },
  {
    name: "does not let callers mutate stored document state",
    run: async (journal) => {
      const state = sampleDocument();
      await journal.putDocument(state);
      state.path = "mutated.md";
      const read = await journal.getDocument("doc-1");
      if (read !== undefined) read.revisionId = "mutated";
      const listed = await journal.listDocuments();
      for (const entry of listed) entry.revisionId = "mutated";
      assertEqual(await journal.getDocument("doc-1"), sampleDocument(), "stored document");
    },
  },
  // Regression for #129: the lookup returned whichever document was stored first, tombstones included.
  ...(["tombstone first", "live document first"] as const).map(
    (order): JournalConformanceCase => ({
      name: `finds the live document when a tombstone shares its path (${order})`,
      run: async (journal, reopen) => {
        const ids = order === "tombstone first" ? ["old", "new"] : ["new", "old"];
        for (const id of ids) {
          await journal.putDocument(sampleDocument({ documentId: id, path: "a.md", revisionId: `r-${id}`, deleted: id === "old" }));
        }
        assertEqual((await (await reopen()).findDocumentByPath("a.md"))?.documentId, "new", "document at a.md");
      },
    }),
  ),
  {
    name: "lists documents in document id order, whatever order they were stored in",
    run: async (journal, reopen) => {
      for (const id of ["b", "c", "a", "B"]) await journal.putDocument(sampleDocument({ documentId: id, path: `${id}.md` }));
      // UTF-16 code unit order: upper case before lower case.
      const listed = (await (await reopen()).listDocuments()).map((state) => state.documentId);
      assertEqual(listed, ["B", "a", "b", "c"], "listed documents, in order");
    },
  },
  {
    name: "finds the live document with the lowest document id when two live documents share a path",
    run: async (journal, reopen) => {
      for (const id of ["b", "a", "c"]) await journal.putDocument(sampleDocument({ documentId: id, path: "a.md", revisionId: `r-${id}` }));
      assertEqual((await (await reopen()).findDocumentByPath("a.md"))?.documentId, "a", "document at a.md");
    },
  },
  {
    name: "never returns a tombstone by path, even when it is the only document at the path",
    run: async (journal, reopen) => {
      await journal.putDocument(sampleDocument({ path: "a.md", deleted: true }));
      assertEqual(await (await reopen()).findDocumentByPath("a.md"), undefined, "document at a.md");
    },
  },
  {
    name: "compares paths exactly",
    run: async (journal, reopen) => {
      await journal.putDocument(sampleDocument({ path: "Note.md" }));
      const reopened = await reopen();
      assertEqual(await reopened.findDocumentByPath("note.md"), undefined, "document at another case");
      assertEqual(await reopened.findDocumentByPath("Note.md "), undefined, "document at a longer path");
      assertEqual((await reopened.findDocumentByPath("Note.md"))?.documentId, "doc-1", "document at its path");
    },
  },
  {
    name: "keeps pending operations in insertion order until removed",
    run: async (journal, reopen) => {
      await journal.addPending(samplePending({ revisionId: "b" }));
      await journal.addPending(samplePending({ revisionId: "a" }));
      await journal.addPending(samplePending({ revisionId: "c" }));
      await journal.removePending("a");
      await journal.removePending("a");
      await journal.removePending("never-added");
      const reopened = await reopen();
      assertEqual(
        (await reopened.listPending()).map((pending) => pending.revisionId),
        ["b", "c"],
        "pending after removal",
      );
      await reopened.addPending(samplePending({ revisionId: "a" }));
      assertEqual(
        (await reopened.listPending()).map((pending) => pending.revisionId),
        ["b", "c", "a"],
        "a re-added operation goes last",
      );
    },
  },
  {
    name: "keeps every field of a pending operation",
    run: async (journal, reopen) => {
      const operation = samplePending({ baseRevisionId: "", size: 2n ** 53n + 1n, kind: "yjs", deleted: true });
      await journal.addPending(operation);
      assertEqual(await (await reopen()).listPending(), [operation], "pending operations");
    },
  },
  {
    name: "rejects a duplicate pending revision id instead of silently replacing it",
    run: async (journal, reopen) => {
      await journal.addPending(samplePending());
      await assertRejects(journal.addPending(samplePending({ path: "other.md" })), Error, "duplicate addPending");
      const reopened = await reopen();
      assertEqual(await reopened.listPending(), [samplePending()], "pending operations");
      await assertRejects(reopened.addPending(samplePending({ path: "other.md" })), Error, "duplicate addPending after reopening");
    },
  },
  {
    name: "does not let callers mutate stored pending operations",
    run: async (journal) => {
      const operation = samplePending();
      await journal.addPending(operation);
      operation.path = "mutated.md";
      const [read] = await journal.listPending();
      if (read !== undefined) read.revisionId = "mutated";
      assertEqual(await journal.listPending(), [samplePending()], "pending operations");
    },
  },
  {
    name: "keeps the newest deferred revision per document until it is removed",
    run: async (journal, reopen) => {
      await journal.putDeferred(sampleDeferred("doc-1", "r2"));
      await journal.putDeferred(sampleDeferred("doc-2", "r3"));
      await journal.putDeferred(sampleDeferred("doc-1", "r4", { reason: "path-conflict" }));

      const reopened = await reopen();
      assertEqual(await reopened.getDeferred("doc-1"), sampleDeferred("doc-1", "r4", { reason: "path-conflict" }), "replaced deferral");
      assertEqual(
        (await reopened.listDeferred()).map((entry) => entry.revision.revisionId).sort(),
        ["r3", "r4"],
        "listed deferrals",
      );

      await reopened.removeDeferred("doc-1");
      await reopened.removeDeferred("doc-1");
      const again = await reopen();
      assertEqual(await again.getDeferred("doc-1"), undefined, "removed deferral");
      assertEqual(await again.listDeferred(), [sampleDeferred("doc-2", "r3")], "remaining deferrals");
    },
  },
  {
    name: "does not let callers mutate stored deferred revisions",
    run: async (journal) => {
      const entry = sampleDeferred("doc-1", "r2");
      await journal.putDeferred(entry);
      entry.revision.path = "mutated.md";
      const read = await journal.getDeferred("doc-1");
      if (read !== undefined) read.revision.revisionId = "mutated";
      assertEqual(await journal.getDeferred("doc-1"), sampleDeferred("doc-1", "r2"), "stored deferral");
    },
  },
  {
    name: "keeps whether a deferred revision descends from the base, and drops it when the deferral is replaced",
    run: async (journal, reopen) => {
      await journal.putDeferred(sampleDeferred("doc-1", "r2", { descendsFromBase: true }));
      const reopened = await reopen();
      assertEqual(await reopened.getDeferred("doc-1"), sampleDeferred("doc-1", "r2", { descendsFromBase: true }), "descending deferral");
      await reopened.putDeferred(sampleDeferred("doc-1", "r4"));
      assertEqual((await (await reopen()).getDeferred("doc-1"))?.descendsFromBase, undefined, "descent of the replaced deferral");
    },
  },
  {
    name: "keeps why a deferred revision is unmaterializable, and drops it when the deferral is replaced",
    run: async (journal, reopen) => {
      await journal.putDeferred(sampleDeferred("doc-1", "r2", { reason: "unmaterializable", unmaterializable: "reserved-name" }));
      const reopened = await reopen();
      assertEqual(await reopened.getDeferred("doc-1"), sampleDeferred("doc-1", "r2", { reason: "unmaterializable", unmaterializable: "reserved-name" }), "unmaterializable deferral");
      assertEqual((await reopened.listDeferred()).map((deferred) => deferred.unmaterializable), ["reserved-name"], "listed reason");
      await reopened.putDeferred(sampleDeferred("doc-1", "r4"));
      assertEqual((await (await reopen()).getDeferred("doc-1"))?.unmaterializable, undefined, "reason of the replaced deferral");
    },
  },
  {
    name: "starts with an empty conflict log",
    run: async (journal) => {
      assertEqual(await journal.listConflicts(), [], "conflict log");
    },
  },
  {
    name: "lists conflicts oldest first and replaces a record with the same id in place",
    run: async (journal, reopen) => {
      await journal.putConflict(sampleConflict("c1"));
      await journal.putConflict(sampleConflict("c2", { reason: "binary" }));
      await journal.putConflict(sampleConflict("c1", { copyPath: null }));
      await journal.putConflict(sampleConflict("c0", { reason: "path-taken", remoteRevisionId: "" }));

      const reopened = await reopen();
      assertEqual(
        await reopened.listConflicts(),
        [sampleConflict("c1", { copyPath: null }), sampleConflict("c2", { reason: "binary" }), sampleConflict("c0", { reason: "path-taken", remoteRevisionId: "" })],
        "conflict log",
      );

      // Order and in-place replacement survive a restart.
      await reopened.putConflict(sampleConflict("c2", { reason: "concurrent-create", at: 2 ** 41 }));
      await reopened.putConflict(sampleConflict("c3"));
      assertEqual(
        (await (await reopen()).listConflicts()).map((conflict) => [conflict.id, conflict.reason, conflict.at]),
        [
          ["c1", "overlapping-edits", 1],
          ["c2", "concurrent-create", 2 ** 41],
          ["c0", "path-taken", 1],
          ["c3", "overlapping-edits", 1],
        ],
        "conflict log after replacing and adding",
      );
    },
  },
  {
    name: "does not let callers mutate stored conflicts",
    run: async (journal) => {
      const entry = sampleConflict("c1");
      await journal.putConflict(entry);
      entry.path = "mutated.md";
      const [read] = await journal.listConflicts();
      if (read !== undefined) read.copyHash = "mutated";
      assertEqual(await journal.listConflicts(), [sampleConflict("c1")], "conflict log");
    },
  },
  {
    name: "keeps a document's binding and absence, copied, and none where none was given",
    run: async (journal, reopen) => {
      const bound = sampleDocument({ binding: { spelling: "Note.md", fileKey: "NOTE.MD", seen: "aa" }, absence: null });
      const released = sampleDocument({ documentId: "doc-2", path: "con.md", deleted: true, binding: null, absence: "released" });
      await journal.putDocument(bound);
      await journal.putDocument(released);
      await journal.putDocument(sampleDocument({ documentId: "doc-3", path: "other.md" }));
      // A binding rule W's displace made (design §4.1, #802).
      const displaced = sampleDocument({ documentId: "doc-4", path: "s.md", deleted: true, binding: { spelling: "s (copy).md", fileKey: "s (copy).md", seen: "bb", displaced: true }, absence: null });
      await journal.putDocument(displaced);
      if (bound.binding) bound.binding.spelling = "mutated.md";
      const reopened = await reopen();
      const read = await reopened.getDocument("doc-1");
      assertEqual(read, sampleDocument({ binding: { spelling: "Note.md", fileKey: "NOTE.MD", seen: "aa" }, absence: null }), "bound document");
      assertEqual(await reopened.getDocument("doc-4"), displaced, "displaced binding");
      if (read?.binding) read.binding.seen = "mutated";
      assertEqual(
        (await reopened.listDocuments()).map((state) => [state.documentId, state.binding, state.absence]),
        [
          ["doc-1", { spelling: "Note.md", fileKey: "NOTE.MD", seen: "aa" }, null],
          ["doc-2", null, "released"],
          ["doc-3", undefined, undefined],
          ["doc-4", { spelling: "s (copy).md", fileKey: "s (copy).md", seen: "bb", displaced: true }, null],
        ],
        "listed bindings and absences",
      );
    },
  },
  {
    name: "finds a document by its binding's file key, not by its path",
    run: async (journal, reopen) => {
      const binding = (spelling: string, fileKey: string) => ({ spelling, fileKey, seen: "aa" });
      await journal.putDocument(sampleDocument({ documentId: "b", path: "base.md", binding: binding("Moved.md", "MOVED.MD"), absence: null }));
      await journal.putDocument(sampleDocument({ documentId: "a", path: "x.md", binding: binding("moved.md", "MOVED.MD"), absence: null }));
      await journal.putDocument(sampleDocument({ documentId: "c", path: "plain.md" }));
      await journal.putDocument(sampleDocument({ documentId: "d", path: "gone.md", deleted: true, binding: null, absence: "user-deleted" }));
      await journal.putDocument(sampleDocument({ documentId: "e", path: "kept.md", binding: binding("kept.md", "KEPT.MD"), absence: null }));
      await journal.putDocument(sampleDocument({ documentId: "e", path: "kept.md", binding: binding("Elsewhere.md", "ELSEWHERE.MD"), absence: null }));
      const reopened = await reopen();
      assertEqual((await reopened.documentByFileKey("MOVED.MD"))?.documentId, "a", "the lowest document id of two bound to one file key");
      assertEqual(await reopened.documentByFileKey("base.md"), undefined, "a base path is no file key");
      assertEqual(await reopened.documentByFileKey("plain.md"), undefined, "a document without a binding");
      assertEqual(await reopened.documentByFileKey("gone.md"), undefined, "a document whose binding is null");
      assertEqual(await reopened.documentByFileKey("KEPT.MD"), undefined, "the file key of a replaced binding");
      assertEqual(await reopened.documentByFileKey("ELSEWHERE.MD"), sampleDocument({ documentId: "e", path: "kept.md", binding: binding("Elsewhere.md", "ELSEWHERE.MD"), absence: null }), "document by its binding's file key");
      assertEqual(await reopened.documentByFileKey("moved.md"), undefined, "file keys compare exactly");
      assertEqual((await reopened.documentsByFileKey("MOVED.MD")).map((state) => state.documentId), ["a", "b"], "every document bound to one file key, in document id order");
      assertEqual(await reopened.documentsByFileKey("ELSEWHERE.MD"), [sampleDocument({ documentId: "e", path: "kept.md", binding: binding("Elsewhere.md", "ELSEWHERE.MD"), absence: null })], "documents by their binding's file key");
      assertEqual(await reopened.documentsByFileKey("KEPT.MD"), [], "no document for the file key of a replaced binding");
      assertEqual(await reopened.documentsByFileKey("base.md"), [], "no document for a base path");
      assertEqual(await reopened.documentsByFileKey("gone.md"), [], "no document whose binding is null");
      assertEqual(await reopened.documentsByFileKey("moved.md"), [], "file keys compare exactly, for every document");
    },
  },
  {
    name: "keeps a pending operation's seal",
    run: async (journal, reopen) => {
      await journal.addPending(samplePending({ revisionId: "a", sealed: true }));
      await journal.addPending(samplePending({ revisionId: "b", documentId: "doc-2", sealed: false }));
      await journal.addPending(samplePending({ revisionId: "c", documentId: "doc-3" }));
      assertEqual(
        (await (await reopen()).listPending()).map((operation) => [operation.revisionId, operation.sealed]),
        [
          ["a", true],
          ["b", false],
          ["c", undefined],
        ],
        "seals",
      );
    },
  },
  {
    name: "records intents oldest first with increasing ids until removed",
    run: async (journal, reopen) => {
      const steps = { revision: { seq: 2n ** 62n, path: "a.md" }, copy: null, anchor: new Uint8Array([1, 2]) };
      const first = await journal.putIntent({ kind: "merge", documentId: "doc-1", steps });
      steps.revision.path = "mutated.md";
      const second = await journal.putIntent({ kind: "displace", documentId: "doc-2", steps: { from: "a.md", to: "a (1).md" } });
      const third = await journal.putIntent({ kind: "apply", documentId: "doc-1", steps: {} });
      if (!(first < second && second < third)) throw new JournalConformanceFailure(`intent ids ${String(first)}, ${String(second)}, ${String(third)} do not increase`);
      let reopened = await reopen();
      const listed = await reopened.listIntents();
      assertEqual(
        listed,
        [
          { id: first, kind: "merge", documentId: "doc-1", steps: { revision: { seq: 2n ** 62n, path: "a.md" }, copy: null, anchor: new Uint8Array([1, 2]) } },
          { id: second, kind: "displace", documentId: "doc-2", steps: { from: "a.md", to: "a (1).md" } },
          { id: third, kind: "apply", documentId: "doc-1", steps: {} },
        ],
        "intents",
      );
      const [read] = listed;
      if (read !== undefined) read.documentId = "mutated";
      await reopened.removeIntent(second);
      await reopened.removeIntent(second);
      await reopened.removeIntent(third + 1000);
      reopened = await reopen();
      assertEqual(
        (await reopened.listIntents()).map((intent) => [intent.id, intent.documentId]),
        [
          [first, "doc-1"],
          [third, "doc-1"],
        ],
        "intents after removal",
      );
      const fourth = await reopened.putIntent({ kind: "detach", documentId: "doc-3", steps: {} });
      if (fourth <= third) throw new JournalConformanceFailure(`intent id ${String(fourth)} after a reopen does not follow ${String(third)}`);
    },
  },
  {
    name: "applies every part of a transaction together",
    run: async (journal, reopen) => {
      await journal.setCursor(3n);
      await journal.addPending(samplePending({ revisionId: "acknowledged" }));
      await journal.addPending(samplePending({ revisionId: "to-seal", documentId: "doc-2" }));
      await journal.putDeferred(sampleDeferred("doc-3", "r3"));
      const intent = await journal.putIntent({ kind: "commit", documentId: "doc-1", steps: {} });
      const kept = await journal.putIntent({ kind: "merge", documentId: "doc-3", steps: {} });
      await journal.putDocument(sampleDocument({ documentId: "doc-9", path: "gone.md" }));
      const anchor = new Uint8Array(16).fill(4);
      await journal.transact({
        cursor: { seq: 5n, anchor },
        putDocuments: [sampleDocument({ revisionId: "acknowledged", binding: { spelling: "note.md", fileKey: "note.md", seen: "bb" }, absence: null })],
        removeDocuments: ["doc-9", "never-added"],
        removePending: ["acknowledged", "never-added"],
        sealPending: ["to-seal"],
        addPending: [samplePending({ revisionId: "next", baseRevisionId: "acknowledged" })],
        removeDeferred: ["doc-3"],
        putDeferred: [sampleDeferred("doc-4", "r4")],
        putConflicts: [sampleConflict("c1")],
        removeIntents: [intent],
      });
      const reopened = await reopen();
      assertEqual(await reopened.getCursor(), 5n, "cursor");
      assertEqual(await reopened.getCursorAnchor(), new Uint8Array(16).fill(4), "cursor anchor");
      assertEqual(await reopened.getDocument("doc-1"), sampleDocument({ revisionId: "acknowledged", binding: { spelling: "note.md", fileKey: "note.md", seen: "bb" }, absence: null }), "document");
      assertEqual(await reopened.getDocument("doc-9"), undefined, "removed document");
      assertEqual(await reopened.findDocumentByPath("gone.md"), undefined, "removed document by path");
      assertEqual(
        await reopened.listPending(),
        [samplePending({ revisionId: "to-seal", documentId: "doc-2", sealed: true }), samplePending({ revisionId: "next", baseRevisionId: "acknowledged" })],
        "pending operations, the sealed one in its place",
      );
      assertEqual(await reopened.listDeferred(), [sampleDeferred("doc-4", "r4")], "deferrals");
      assertEqual(await reopened.listConflicts(), [sampleConflict("c1")], "conflict log");
      assertEqual((await reopened.listIntents()).map((entry) => entry.id), [kept], "intents");
    },
  },
  {
    name: "resets the cursor backwards in a transaction only when asked to",
    run: async (journal, reopen) => {
      await journal.setCursor(9n);
      await assertRejects(journal.transact({ cursor: { seq: 4n } }), RangeError, "a transaction moving the cursor backwards");
      await journal.transact({ cursor: { seq: 4n, reset: true } });
      assertEqual(await (await reopen()).getCursor(), 4n, "cursor after a reset in a transaction");
    },
  },
  {
    name: "keeps at most one pending operation per document through transactions",
    run: async (journal, reopen) => {
      await journal.transact({ addPending: [samplePending({ revisionId: "first" })] });
      await assertRejects(journal.transact({ addPending: [samplePending({ revisionId: "second" })] }), Error, "a second operation for the document");
      await assertRejects(
        journal.transact({ addPending: [samplePending({ revisionId: "x", documentId: "doc-2" }), samplePending({ revisionId: "y", documentId: "doc-2" })] }),
        Error,
        "two operations for one document in one transaction",
      );
      // Replacing the document's operation in one transaction is allowed.
      await journal.transact({ removePending: ["first"], addPending: [samplePending({ revisionId: "second" })] });
      // addPending alone does not enforce it (the engine before refactor step R5).
      await journal.addPending(samplePending({ revisionId: "legacy" }));
      assertEqual((await (await reopen()).listPending()).map((operation) => operation.revisionId), ["second", "legacy"], "pending operations");
    },
  },
  // Injected failures: each transaction below has a part that fails after
  // others were issued, so a journal that is not all-or-nothing keeps them.
  ...(
    [
      ["an already pending revision id", { addPending: [samplePending({ revisionId: "pending" })] }],
      ["a seal of an operation that is not pending", { sealPending: ["unknown"] }],
      ["a second pending operation for a document", { addPending: [samplePending({ revisionId: "another", documentId: "doc-1" })] }],
      ["a cursor moving backwards", { cursor: { seq: 1n } }],
      // Not structured-cloneable: the store itself refuses it (DataCloneError).
      ["a value the journal cannot store", { putConflicts: [sampleConflict("c9", { path: (() => "x") as unknown as string })] }],
    ] as const
  ).map(
    ([failure, failing]): JournalConformanceCase => ({
      name: `changes nothing when a transaction fails on ${failure}`,
      run: async (journal, reopen) => {
        await journal.setCursor(2n);
        await journal.putDocument(sampleDocument());
        await journal.putDocument(sampleDocument({ documentId: "doc-7", path: "seven.md" }));
        await journal.addPending(samplePending({ revisionId: "pending" }));
        await journal.addPending(samplePending({ revisionId: "other", documentId: "doc-3" }));
        await journal.putDeferred(sampleDeferred("doc-2", "r2"));
        await journal.putConflict(sampleConflict("c1"));
        const intent = await journal.putIntent({ kind: "merge", documentId: "doc-2", steps: {} });
        const before = await contents(journal);
        const changes: JournalChanges = {
          cursor: { seq: 6n },
          putDocuments: [sampleDocument({ revisionId: "changed", binding: null, absence: "user-deleted" })],
          removeDocuments: ["doc-7"],
          removePending: ["other"],
          removeDeferred: ["doc-2"],
          putDeferred: [sampleDeferred("doc-5", "r5")],
          putConflicts: [sampleConflict("c2")],
          removeIntents: [intent],
        };
        let failed = false;
        try {
          await journal.transact({ ...changes, ...failing });
        } catch {
          failed = true;
        }
        if (!failed) throw new JournalConformanceFailure(`a transaction with ${failure} succeeded`);
        const reopened = await reopen();
        assertEqual(await contents(reopened), before, "journal after the failed transaction");
        // The same transaction without the failing part goes through.
        await reopened.transact(changes);
        if ((await contents(reopened)) === before) throw new JournalConformanceFailure("the transaction without the failing part changed nothing");
      },
    }),
  ),
];

/** Everything a journal holds, in comparable form. */
async function contents(journal: Journal): Promise<string> {
  return describeValue({
    cursor: await journal.getCursor(),
    anchor: await journal.getCursorAnchor(),
    documents: await journal.listDocuments(),
    pending: await journal.listPending(),
    deferred: (await journal.listDeferred()).sort((a, b) => (a.revision.documentId < b.revision.documentId ? -1 : 1)),
    conflicts: await journal.listConflicts(),
    intents: await journal.listIntents(),
  });
}
