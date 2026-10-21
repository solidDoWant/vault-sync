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

  // The class (design §9.3): synced documents, each left alone, moved by
  // the user while the scan runs, or deleted while the app was closed with a
  // new file then made at its path and moved away while the scan runs. A
  // document is bound after the scan exactly when its own file is there.
  it("binds each document to its own file only, whatever the interleaving", async () => {
    const fate = fc.constantFrom("kept", "moved", "replaced");
    await fc.assert(
      fc.asyncProperty(fc.array(fate, { minLength: 1, maxLength: 4 }), async (fates) => {
        const h = harness({ merge: "default" });
        for (const [index] of fates.entries()) h.server.commit({ documentId: `D${String(index)}`, path: `d${String(index)}.md`, content: `c${String(index)}` });
        await h.engine.pull();
        h.engine.dispose();
        for (const [index, which] of fates.entries()) if (which === "replaced") await h.vault.delete(`d${String(index)}.md`);

        h.restart();
        for (const [index, which] of fates.entries()) {
          const path = `d${String(index)}.md`;
          if (which === "replaced") await h.vault.write(path, bytes(`new${String(index)}`));
          if (which !== "kept") await h.vault.rename(path, `m${String(index)}.md`);
        }
        await h.engine.settled();

        for (const [index, which] of fates.entries()) {
          const state = await h.journal.getDocument(`D${String(index)}`);
          if (which === "replaced") expect(state).toMatchObject({ binding: null, absence: "user-deleted" });
          else expect(state?.binding).toMatchObject({ spelling: which === "kept" ? `d${String(index)}.md` : `m${String(index)}.md`, seen: hash(`c${String(index)}`) });
        }
        h.engine.dispose();
      }),
      { numRuns: 50 },
    );
  });
});
