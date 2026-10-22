import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import { harness } from "./testing";

// #877 (seed 566): a remote rename onto a path Windows cannot hold is
// deferred, and the deferral keeps the document's local edit from being
// pushed (busyClaims). The push still reads the held-back file, so the
// binding's `seen` is the edited content (design §4.3 E4), and the start-up
// scan (E7) finds the file after the user renames it while the app is
// closed: the document keeps its id, and nothing is tombstoned.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string) => encoder.encode(value);

describe("SyncEngine with a local edit a deferred remote rename holds back (#877)", () => {
  it("keeps the document's id when the user renames the edited file while the app is closed", async () => {
    const h = harness({ merge: "default", pathRules: { platform: "windows" } });
    h.server.commit({ documentId: "A", path: "a.md", content: "a1" });
    await h.engine.pull();
    await h.engine.settled();

    // The user edits a.md, and another device renames A to a name Windows cannot hold: deferred.
    await h.vault.write("a.md", bytes("mine"));
    h.server.commit({ documentId: "A", path: "no:te.md", content: "a1" });
    await h.engine.pull();
    await h.engine.push();
    await h.engine.settled();
    expect((await h.journal.listDeferred()).map((deferred) => deferred.revision.documentId)).toEqual(["A"]);
    expect((await h.journal.getDocument("A"))?.binding?.seen).toBe(sha256Hex(bytes("mine")));

    // The user renames the edited file while the app is not running.
    h.engine.dispose();
    await h.vault.rename("a.md", "b.md");
    h.restart();
    await h.engine.settled();
    await h.engine.pull();
    await h.engine.push();
    await h.engine.settled();

    const state = await h.journal.getDocument("A");
    expect(state?.binding?.spelling).toBe("b.md");
    expect(state?.absence).toBeNull();
    // No other document took the file, and A was never tombstoned.
    expect([...h.server.liveDocuments().values()]).toEqual(["A"]);
    expect(h.server.history("A").every((revision) => !revision.deleted)).toBe(true);
    expect(decoder.decode(await h.vault.read("b.md"))).toBe("mine");
  });
});
