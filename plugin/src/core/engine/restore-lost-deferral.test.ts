import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { InMemoryServer } from "./memory-server";
import { files, harness, newestServerClaims, text, type Harness } from "./testing";

// #768 (INV-2, PO-12, design §4.6): a restore re-derives the server view. A
// deferred revision the restored server no longer has is no server claim any
// more, and a document the server lost that has no file here is forgotten,
// so neither keeps a later document of the restored server off its path.

function windows(): Harness {
  const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 64 });
  return harness({ merge: "default", server, vault: new InMemoryVault({ pathRules: { platform: "windows" } }), pathRules: { platform: "windows" } });
}

/** The journal's newest server claims, lower-cased for a K comparison on Windows. */
async function claimKeys(h: Harness): Promise<string[]> {
  return (await newestServerClaims(h.journal)).map(([, path]) => path.toLowerCase()).sort();
}

describe("a restore that lost a deferred revision", () => {
  it("drops the deferral when the server kept its base, so another document takes the deferred path", async () => {
    const h = windows();
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    await h.engine.pull();
    expect(await files(h.vault)).toEqual(new Map([["a.md", "a1\n"]]));
    h.server.commit({ documentId: "a", path: "no:te.md" }); // 2, unmaterializable on Windows
    await h.engine.pull();
    expect((await h.journal.getDeferred("a"))?.revision.path).toBe("no:te.md");

    // The restore keeps a's base and loses the rename; another device then creates b at the rename's path.
    h.server.restoreTo(1n);
    h.server.commit({ documentId: "b", path: "no:te.md", content: "b1\n" });
    await h.engine.pull();

    expect(await h.journal.getDeferred("a")).toBeUndefined();
    const keys = await claimKeys(h);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["a.md"]);
    // b waits at its path, which this device cannot hold, with no other claim on it.
    expect((await h.journal.getDeferred("b"))?.revision.path).toBe("no:te.md");
    // a is the server's a.md again, and the device holds it there.
    await h.engine.push();
    expect(text(await h.vault.read("a.md"))).toBe("a1\n");
  });

  it("forgets a document the server lost that has no file here, so its old path is free", async () => {
    const h = windows();
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
    await h.engine.pull();
    h.server.commit({ documentId: "a", path: "no:te.md" }); // 2: the device releases a's file
    await h.engine.pull();
    expect(await files(h.vault)).toEqual(new Map());

    // The restore loses a altogether; another device creates c at the rename's path.
    h.server.restoreTo(0n);
    h.server.commit({ documentId: "c", path: "no:te.md", content: "c1\n" });
    await h.engine.pull();

    expect(await h.journal.getDocument("a")).toBeUndefined();
    expect(await h.journal.getDeferred("a")).toBeUndefined();
    expect(await claimKeys(h)).toEqual([]);
    expect((await h.journal.getDeferred("c"))?.revision.path).toBe("no:te.md");

    // The user creates a.md: a new document takes the path a no longer claims.
    await h.vault.write("a.md", new TextEncoder().encode("new\n"));
    await h.engine.settled();
    await h.engine.push();
    const live = [...h.server.liveDocuments()].sort();
    expect(live.map(([path]) => path)).toEqual(["a.md", "no:te.md"]);
    expect(live.find(([path]) => path === "a.md")?.[1]).not.toBe("a");
    expect(await claimKeys(h)).toEqual(["a.md"]);
  });
});
