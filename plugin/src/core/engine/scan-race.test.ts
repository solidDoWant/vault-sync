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

  // The class (design §9.3): synced documents, each left alone, moved by
  // the user while the scan runs (edited while the app was closed or not),
  // or deleted while the app was closed with a new file then made at its
  // path, or another file moved there, and moved away while the scan runs.
  // A document is bound after the scan exactly when its own file is there.
  it("binds each document to its own file only, whatever the interleaving", async () => {
    const fate = fc.constantFrom("kept", "moved", "edited", "replaced", "intruded");
    await fc.assert(
      fc.asyncProperty(fc.array(fate, { minLength: 1, maxLength: 4 }), async (fates) => {
        const h = harness({ merge: "default" });
        for (const [index] of fates.entries()) h.server.commit({ documentId: `D${String(index)}`, path: `d${String(index)}.md`, content: `c${String(index)}` });
        await h.engine.pull();
        h.engine.dispose();
        for (const [index, which] of fates.entries()) {
          if (which === "replaced" || which === "intruded") await h.vault.delete(`d${String(index)}.md`);
          if (which === "intruded") await h.vault.write(`x${String(index)}.md`, bytes(`other${String(index)}`));
          if (which === "edited") await h.vault.write(`d${String(index)}.md`, bytes(`edit${String(index)}`));
        }

        h.restart();
        for (const [index, which] of fates.entries()) {
          const path = `d${String(index)}.md`;
          if (which === "replaced") await h.vault.write(path, bytes(`new${String(index)}`));
          if (which === "intruded") await h.vault.rename(`x${String(index)}.md`, path);
          if (which !== "kept") await h.vault.rename(path, `m${String(index)}.md`);
        }
        await h.engine.settled();

        for (const [index, which] of fates.entries()) {
          const state = await h.journal.getDocument(`D${String(index)}`);
          if (which === "replaced" || which === "intruded") expect(state).toMatchObject({ binding: null, absence: "user-deleted" });
          else expect(state?.binding).toMatchObject({ spelling: which === "kept" ? `d${String(index)}.md` : `m${String(index)}.md`, seen: hash(`c${String(index)}`) });
        }
        h.engine.dispose();
      }),
      { numRuns: 50 },
    );
  });
});
