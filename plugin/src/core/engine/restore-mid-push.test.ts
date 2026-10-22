import { describe, expect, it } from "vitest";

import { files, harness, text } from "./testing";

// #861 (PO-12, INV-8, design §4.6): a restore that lands while a push is in
// flight, after the pull that starts the push, loses the base of the
// operation being committed. The server refuses the commit as "the document
// does not exist" (FAILED_PRECONDITION without a Document head), which is no
// missing blob: the push pulls, as for a moved head, the pull finds the
// divergence and its resync resolves the operation against the restored
// server, and nothing is thrown or lost.

describe("a restore during a push that loses the base of the operation being committed", () => {
  it.each([
    ["an edit", "edit"],
    ["a delete", "delete"],
  ] as const)("pulls and resyncs instead of failing the push, and keeps %s", async (_name, change) => {
    const h = harness();
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    await h.engine.pull();
    if (change === "edit") await h.vault.write("a.md", new TextEncoder().encode("a2\n"));
    else await h.vault.delete("a.md");
    await h.engine.settled();
    // The operator restores a backup from before a, just before the commit reaches the server.
    let restored = false;
    h.server.interceptor = (method) => {
      if (method === "CommitRevision" && !restored) {
        restored = true;
        h.server.restoreTo(0n);
      }
    };

    const first = await h.engine.push();
    h.server.interceptor = undefined;
    expect(restored).toBe(true);
    expect(first.rejected).toEqual([]);
    for (let round = 0; round < 3; round++) {
      expect((await h.engine.push()).rejected).toEqual([]);
      await h.engine.pull();
    }

    expect(await h.journal.listPending()).toEqual([]);
    if (change === "edit") {
      expect([...h.server.liveDocuments()]).toEqual([["a.md", "a"]]);
      expect(text(await h.vault.read("a.md"))).toBe("a2\n");
      expect(await files(h.vault)).toEqual(new Map([["a.md", "a2\n"]]));
    } else {
      expect([...h.server.liveDocuments()]).toEqual([]);
      expect(await files(h.vault)).toEqual(new Map());
    }
  });
});
