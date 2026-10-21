import { describe, expect, it } from "vitest";

import type { DocumentState } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import { harness } from "./testing";

// A pull must not read the whole journal once per revision (#671): an
// IndexedDB journal reads every document row on each listDocuments call, so
// a pull of N revisions over D documents would cost O(N·D) reads.

class CountingJournal extends InMemoryJournal {
  documentLists = 0;
  override listDocuments(): Promise<DocumentState[]> {
    this.documentLists++;
    return super.listDocuments();
  }
}

/** The listDocuments calls of a pull of `count` revisions of `variant` over a journal that already has `count` documents. */
async function documentListsOfPull(count: number, variant: "creates" | "renames" | "edits"): Promise<number> {
  const journal = new CountingJournal();
  const h = harness({ merge: "default", journal });
  for (let index = 0; index < count; index++) h.server.commit({ documentId: `D${String(index)}`, path: `d${String(index)}.md`, content: `x${String(index)}` });
  await h.engine.pull();
  for (let index = 0; index < count; index++) {
    if (variant === "creates") h.server.commit({ documentId: `N${String(index)}`, path: `n${String(index)}.md`, content: `y${String(index)}` });
    if (variant === "renames") h.server.commit({ documentId: `D${String(index)}`, path: `e${String(index)}.md`, content: `x${String(index)}` });
    if (variant === "edits") h.server.commit({ documentId: `D${String(index)}`, path: `d${String(index)}.md`, content: `z${String(index)}` });
  }
  await h.engine.settled();
  journal.documentLists = 0;
  const summary = await h.engine.pull();
  expect(summary.applied).toBe(count);
  return journal.documentLists;
}

describe("journal reads of a pull", () => {
  for (const variant of ["creates", "renames", "edits"] as const) {
    it(`lists the documents a bounded number of times, whatever the number of pulled ${variant}`, async () => {
      const few = await documentListsOfPull(2, variant);
      const many = await documentListsOfPull(20, variant);

      expect(many).toBe(few);
      expect(few).toBeLessThanOrEqual(3);
    });
  }
});
