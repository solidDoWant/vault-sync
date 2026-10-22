import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { harness } from "./testing";

// The start-up scan (E7) races with vault events: a rename made while it
// runs may move a file it then finds missing, and keeps the document's
// binding (Bindings.renamed, `duringScan`). Only the document's own file
// does: a new file the user made at the old path and moved away is another
// one (PO-1, INV-3; #671 item 2), so the document whose file the user
// deleted while the app was closed is deleted, and the file is a new
// document.

const bytes = (value: string) => new TextEncoder().encode(value);
const hash = (value: string) => sha256Hex(bytes(value));

describe("a rename while the start-up scan runs", () => {
  it("does not bind a document whose file was deleted to a new file moved from its path", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    h.engine.dispose();
    // Deleted while the app was closed.
    await h.vault.delete("a.md");

    h.restart();
    // While the scan runs: a new file at the old path, moved away.
    await h.vault.write("a.md", bytes("new"));
    await h.vault.rename("a.md", "b.md");
    await h.engine.settled();

    expect(await h.journal.getDocument("A")).toMatchObject({ binding: null, absence: "user-deleted" });
    await h.engine.push();
    const live = h.server.liveDocuments();
    expect(live.has("a.md")).toBe(false);
    expect(live.get("b.md")).toBeDefined();
    expect(live.get("b.md")).not.toBe("A");
    expect(h.server.liveFiles().get("b.md")).toBe("new");
  });

  it("keeps the binding of a document whose own file it moves", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();

    h.restart();
    await h.vault.rename("a.md", "b.md");
    await h.engine.settled();

    expect(await h.journal.getDocument("A")).toMatchObject({ binding: { spelling: "b.md", seen: hash("a1") }, absence: null });
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "A"]]));
  });

  // #758: the user's rename (E1) carries identity (PO-1, INV-3), whatever
  // the file's content: a note edited while the app was closed is still the
  // document's own file.
  it("keeps the binding of a document edited while the app was closed whose file it moves", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    h.engine.dispose();
    // Edited while the app was closed.
    await h.vault.write("a.md", bytes("a2"));

    h.restart();
    await h.vault.rename("a.md", "b.md");
    await h.engine.settled();

    expect(await h.journal.getDocument("A")).toMatchObject({ binding: { spelling: "b.md", seen: hash("a1") }, absence: null });
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "A"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["b.md", "a2"]]));
    expect(h.server.deletedDocuments()).toEqual([]);
  });

  it("does not bind a document whose file was deleted to an untracked file moved through its path", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    h.engine.dispose();
    // Deleted while the app was closed, and another file made.
    await h.vault.delete("a.md");
    await h.vault.write("x.md", bytes("x"));

    h.restart();
    // While the scan runs: the other file moved to the old path, and on.
    await h.vault.rename("x.md", "a.md");
    await h.vault.rename("a.md", "b.md");
    await h.engine.settled();

    expect(await h.journal.getDocument("A")).toMatchObject({ binding: null, absence: "user-deleted" });
    await h.engine.push();
    const live = h.server.liveDocuments();
    expect(live.has("a.md")).toBe(false);
    expect(live.get("b.md")).toBeDefined();
    expect(live.get("b.md")).not.toBe("A");
    expect(h.server.deletedDocuments()).toEqual(["A"]);
  });

  // #921: a file moved twice while the scan runs is placed by its events
  // (E1), not also by the scan's content match, which would see it at its
  // last path and leave the second event unbinding it there.
  it("keeps the binding of a document whose own file it moves through a temporary name", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();

    h.restart();
    await h.vault.rename("a.md", "t.md");
    await h.vault.rename("t.md", "b.md");
    await h.engine.settled();

    expect(await h.journal.getDocument("A")).toMatchObject({ binding: { spelling: "b.md", seen: hash("a1") }, absence: null });
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "A"]]));
    expect(h.server.deletedDocuments()).toEqual([]);
  });

  // #921 (review): the scan's rename-cycle match (E7c) and the events of a
  // swap made while it runs both describe one swap: the events (E1) decide,
  // and each document keeps its own file.
  it("keeps each document's own file when the user swaps two files through a temporary name while the scan runs", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "A", path: "a.md", content: "aa" });
    h.server.commit({ documentId: "B", path: "b.md", content: "bb" });
    await h.engine.pull();

    h.restart();
    await h.vault.rename("a.md", "t.md");
    await h.vault.rename("b.md", "a.md");
    await h.vault.rename("t.md", "b.md");
    await h.engine.settled();

    expect(await h.journal.getDocument("A")).toMatchObject({ binding: { spelling: "b.md", seen: hash("aa") }, absence: null });
    expect(await h.journal.getDocument("B")).toMatchObject({ binding: { spelling: "a.md", seen: hash("bb") }, absence: null });
    await h.engine.push();
    const files = h.server.liveFiles();
    expect(new Map([...h.server.liveDocuments()].map(([path, documentId]) => [documentId, files.get(path)]))).toEqual(
      new Map([
        ["A", "aa"],
        ["B", "bb"],
      ]),
    );
    expect(h.server.deletedDocuments()).toEqual([]);
  });

  // The class (design §9.3): synced documents, each left alone, moved by
  // the user while the scan runs (edited while the app was closed or not),
  // or deleted while the app was closed with a new file then made at its
  // path, or another file moved there, and moved away while the scan runs.
  // A document is bound after the scan exactly when its own file is there.
  // Beside them, another set of documents whose files the user rotates
  // through a temporary name (a swap of two, or three), while the app was
  // closed (E7c) or while the scan runs (E1, #921).
  it("binds each document to its own file only, whatever the interleaving", async () => {
    const fate = fc.constantFrom("kept", "moved", "edited", "replaced", "intruded");
    const rotation = fc.record({ length: fc.integer({ min: 0, max: 3 }), closed: fc.boolean(), sameSize: fc.boolean() });
    await fc.assert(
      fc.asyncProperty(fc.array(fate, { minLength: 1, maxLength: 4 }), rotation, async (fates, cycle) => {
        const h = harness({ merge: "default" });
        for (const [index] of fates.entries()) h.server.commit({ documentId: `D${String(index)}`, path: `d${String(index)}.md`, content: `c${String(index)}` });
        const rotated = cycle.length < 2 ? 0 : cycle.length;
        const rotatedContent = (index: number) => (cycle.sameSize ? `r${String(index)}` : `r${"r".repeat(index)}${String(index)}`);
        for (let index = 0; index < rotated; index++) h.server.commit({ documentId: `R${String(index)}`, path: `r${String(index)}.md`, content: rotatedContent(index) });
        // r0.md → r1.md → … → r0.md, through a temporary name.
        const rotate = async () => {
          if (rotated === 0) return;
          await h.vault.rename(`r${String(rotated - 1)}.md`, "tmp.md");
          for (let index = rotated - 2; index >= 0; index--) await h.vault.rename(`r${String(index)}.md`, `r${String(index + 1)}.md`);
          await h.vault.rename("tmp.md", "r0.md");
        };
        await h.engine.pull();
        h.engine.dispose();
        for (const [index, which] of fates.entries()) {
          if (which === "replaced" || which === "intruded") await h.vault.delete(`d${String(index)}.md`);
          if (which === "intruded") await h.vault.write(`x${String(index)}.md`, bytes(`other${String(index)}`));
          if (which === "edited") await h.vault.write(`d${String(index)}.md`, bytes(`edit${String(index)}`));
        }

        if (cycle.closed) await rotate();

        h.restart();
        for (const [index, which] of fates.entries()) {
          const path = `d${String(index)}.md`;
          if (which === "replaced") await h.vault.write(path, bytes(`new${String(index)}`));
          if (which === "intruded") await h.vault.rename(`x${String(index)}.md`, path);
          if (which !== "kept") await h.vault.rename(path, `m${String(index)}.md`);
        }
        if (!cycle.closed) await rotate();
        await h.engine.settled();

        for (const [index, which] of fates.entries()) {
          const state = await h.journal.getDocument(`D${String(index)}`);
          if (which === "replaced" || which === "intruded") expect(state).toMatchObject({ binding: null, absence: "user-deleted" });
          else expect(state?.binding).toMatchObject({ spelling: which === "kept" ? `d${String(index)}.md` : `m${String(index)}.md`, seen: hash(`c${String(index)}`) });
        }
        for (let index = 0; index < rotated; index++) {
          const state = await h.journal.getDocument(`R${String(index)}`);
          expect(state).toMatchObject({ binding: { spelling: `r${String((index + 1) % rotated)}.md`, seen: hash(rotatedContent(index)) }, absence: null });
        }
        h.engine.dispose();
      }),
      { numRuns: 50 },
    );
  });
});
