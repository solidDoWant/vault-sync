import { describe, expect, it } from "vitest";

import { journalConformance, JournalConformanceFailure, runJournalConformanceCase } from "./conformance";
import type { DocumentState, PendingOperation } from "./journal";
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
