import type { ConflictRecord, DeferredRevision, DocumentState, Journal, PendingOperation } from "./journal";

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
    name: "keeps the merge-in-progress marker with the deferred revision, copied",
    run: async (journal, reopen) => {
      const entry = sampleDeferred("doc-1", "r2", { merging: { path: "note.md", contentHash: "dd" } });
      await journal.putDeferred(entry);
      await journal.putDeferred(sampleDeferred("doc-2", "r3", { merging: { path: "gone.md", contentHash: null } }));
      if (entry.merging !== undefined) entry.merging.path = "mutated.md";

      const reopened = await reopen();
      const read = await reopened.getDeferred("doc-1");
      assertEqual(read?.merging, { path: "note.md", contentHash: "dd" }, "marker by id");
      if (read?.merging !== undefined) read.merging.contentHash = "mutated";
      assertEqual(
        (await reopened.listDeferred()).map((deferred) => deferred.merging).sort((a, b) => (a?.path ?? "").localeCompare(b?.path ?? "")),
        [
          { path: "gone.md", contentHash: null },
          { path: "note.md", contentHash: "dd" },
        ],
        "listed markers, a deleted result's null hash included",
      );
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
    name: "drops the merge-in-progress marker when the deferral is replaced without one",
    run: async (journal, reopen) => {
      await journal.putDeferred(sampleDeferred("doc-1", "r2", { merging: { path: "note.md", contentHash: "dd" } }));
      await journal.putDeferred(sampleDeferred("doc-1", "r4"));
      const read = await (await reopen()).getDeferred("doc-1");
      assertEqual(read?.revision.revisionId, "r4", "replaced deferral");
      assertEqual(read?.merging, undefined, "marker of the replaced deferral");
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
];
