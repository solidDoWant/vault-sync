import { describe, expect, it } from "vitest";

import { journalConformance, JournalConformanceFailure, runJournalConformanceCase } from "./conformance";
import type { DocumentState, JournalChanges, PendingOperation } from "./journal";
import { InMemoryJournal } from "./memory";

describe("InMemoryJournal", () => {
  describe("Journal conformance", () => {
    for (const testCase of journalConformance) {
      it(testCase.name, async () => {
        await runJournalConformanceCase(testCase, () => ({ journal: new InMemoryJournal() }));
      });
    }
  });
});

describe("the Journal conformance suite", () => {
  const broken: [string, () => InMemoryJournal, boolean?][] = [
    [
      "a cursor that moves backwards",
      () =>
        new (class extends InMemoryJournal {
          override setCursor(seq: bigint) {
            return super.resetCursor(seq);
          }
        })(),
    ],
    [
      "a path lookup that returns tombstones",
      () =>
        new (class extends InMemoryJournal {
          override async findDocumentByPath(path: string) {
            return (await this.listDocuments()).find((state) => state.path === path);
          }
        })(),
    ],
    [
      "a duplicate pending operation that replaces the first",
      () =>
        new (class extends InMemoryJournal {
          override async addPending(operation: PendingOperation) {
            await this.removePending(operation.revisionId);
            return super.addPending(operation);
          }
        })(),
    ],
    [
      "stored state shared with the caller",
      () =>
        new (class extends InMemoryJournal {
          private readonly shared = new Map<string, DocumentState>();
          override putDocument(state: DocumentState) {
            this.shared.set(state.documentId, state);
            return super.putDocument(state);
          }
          override getDocument(documentId: string) {
            return Promise.resolve(this.shared.get(documentId));
          }
        })(),
    ],
    [
      "a transaction that keeps the parts before a failing one",
      () =>
        new (class extends InMemoryJournal {
          override async transact(changes: JournalChanges) {
            const { cursor, putDocuments, removePending, sealPending, addPending, removeDeferred, putDeferred, putConflicts, removeIntents } = changes;
            for (const part of [{ cursor }, { putDocuments }, { removePending }, { sealPending }, { addPending }, { removeDeferred }, { putDeferred }, { putConflicts }, { removeIntents }]) {
              await super.transact(part);
            }
          }
        })(),
    ],
    [
      "a transaction that adds a second pending operation for a document",
      () =>
        new (class extends InMemoryJournal {
          override async transact(changes: JournalChanges) {
            const { addPending, ...rest } = changes;
            await super.transact(rest);
            for (const operation of addPending ?? []) await this.addPending(operation);
          }
        })(),
    ],
    [
      "a file key lookup by path",
      () =>
        new (class extends InMemoryJournal {
          override documentByFileKey(fileKey: string) {
            return this.findDocumentByPath(fileKey);
          }
        })(),
    ],
    [
      "a file key lookup that returns only the first of several documents",
      () =>
        new (class extends InMemoryJournal {
          override async documentsByFileKey(fileKey: string) {
            return (await super.documentsByFileKey(fileKey)).slice(0, 1);
          }
        })(),
    ],
    // Reopening gives a new, empty journal, as a store that is not durable does.
    ["writes lost on reopen", () => new InMemoryJournal(), true],
  ];

  it.each(broken)("fails a journal with %s", async (_name, create, forgetsOnReopen) => {
    const failures: unknown[] = [];
    for (const testCase of journalConformance) {
      await runJournalConformanceCase(testCase, () => ({
        journal: create(),
        ...(forgetsOnReopen === true ? { reopen: () => Promise.resolve(create()) } : {}),
      })).catch((error: unknown) => failures.push(error));
    }
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) expect(failure).toBeInstanceOf(JournalConformanceFailure);
  });
});
