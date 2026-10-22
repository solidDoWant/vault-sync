import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// #893 (seed 566): the merge of a remote revision of document D claims the
// result's path, and that claim first applies another document E's newer
// revision, whose rule W(a) displaces D's own file (D's local rename is onto
// E's path under the server's key: `Straße.md` beside E's `STRASSE.md`, two
// files on Windows). The merge must go on from where D's file is now, so D's
// bytes stay one file, bound to D: never a second copy of them beside an
// untracked first one the push commits as a new document (PO-8, PO-1).

describe("SyncEngine merging a document whose own file a path claim of the merge displaces (#893)", () => {
  it("keeps the document's bytes in one file, bound to it, after a closed-app rename onto another document's path", async () => {
    const h = harness({ merge: "default", pathRules: { platform: "windows" } });
    h.server.commit({ documentId: "E", path: "STRASSE.md", content: "e1" });
    h.server.commit({ documentId: "D", path: "a.md", content: "d1" });
    await h.engine.pull();
    await h.engine.settled();

    // The user renames D's file onto E's path under the server's key while the app is not running.
    h.engine.dispose();
    await h.vault.rename("a.md", "Straße.md");
    h.restart();
    await h.engine.settled();

    // Another device deletes D and edits E before this device pushes D's rename.
    h.server.commit({ documentId: "D", path: "a.md", deleted: true });
    h.server.commit({ documentId: "E", path: "STRASSE.md", content: "e2" });
    for (let round = 0; round < 3; round++) {
      await h.engine.push();
      await h.engine.pull();
      await h.engine.settled();
    }

    // D's bytes are in exactly one file, bound to D, and D is live there on the server: no third document.
    const vault = [...(await files(h.vault))];
    const copies = vault.filter(([, content]) => content === "d1");
    expect(copies).toHaveLength(1);
    const [copy] = copies[0] ?? [""];
    expect(copy).toMatch(/^Straße \(conflict /);
    expect((await h.journal.getDocument("D"))?.binding?.spelling).toBe(copy);
    expect(new Map([...h.server.liveDocuments()].map(([path, documentId]) => [documentId, path]))).toEqual(new Map([["E", "STRASSE.md"], ["D", copy]]));
    expect(vault).toContainEqual(["STRASSE.md", "e2"]);
  });
});
