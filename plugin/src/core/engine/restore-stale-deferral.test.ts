import { describe, expect, it } from "vitest";

import type { VaultAdapter } from "../vault/adapter";
import { InMemoryVault } from "../vault/memory";
import { files, harness, type Harness } from "./testing";

// #410 item 2 (PO-12, INV-9, design §4.6 as amended for #768, #784, #848): a
// server restore that loses a deferred revision while keeping the document's
// base as its head must not leave the stale deferral behind. The resync drops
// it, whatever its blocker, so a released document is materialized again and
// a parked local edit is pushed: the device converges with the server.

const bytes = (value: string) => new TextEncoder().encode(value);

/** The vault the engine sees, which (like ConfigSyncVault with config sync off) does not sync the config folder. */
const withoutConfig = (vault: InMemoryVault): VaultAdapter => Object.assign(Object.create(vault) as InMemoryVault, { isSynced: (path: string) => !path.startsWith(".obsidian/") });

function windows(): Harness {
  return harness({ merge: "default", vault: new InMemoryVault({ pathRules: { platform: "windows" } }), pathRules: { platform: "windows" } });
}

describe("a restore back to the base of a deferred revision (#410 item 2)", () => {
  it("materializes a document whose file a rename to a path Windows cannot hold released, and keeps it across a restart", async () => {
    const h = windows();
    const base = h.server.commit({ documentId: "plan", path: "plan.md", content: "plan\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "plan", path: "plan?.md" });
    await h.engine.pull();
    await h.engine.push();
    expect(await files(h.vault)).toEqual(new Map());
    expect((await h.engine.unmaterializable()).map(({ path }) => path)).toEqual(["plan?.md"]);

    h.server.restoreTo(base.seq);
    expect((await h.engine.pull()).resynced).toBe(true);
    await h.engine.push();

    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await h.engine.unmaterializable()).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([["plan.md", "plan\n"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["plan.md", "plan\n"]]));

    const restarted = h.restart();
    await restarted.push();
    expect(await files(h.vault)).toEqual(new Map([["plan.md", "plan\n"]]));
    expect(await h.journal.listDeferred()).toEqual([]);
  });

  it("pushes a local edit a too-large deferral held back once the restore lost the over-cap revision", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: 10 });
    const base = h.server.commit({ documentId: "doc", path: "doc.md", content: "base\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "doc", path: "doc.md", content: "x".repeat(11) });
    await h.engine.pull();
    await h.vault.write("doc.md", bytes("local edit\n"));
    await h.engine.settled();
    await h.engine.push();
    expect(h.server.liveFiles()).toEqual(new Map([["doc.md", "x".repeat(11)]]));

    h.server.restoreTo(base.seq);
    expect((await h.engine.pull()).resynced).toBe(true);
    await h.engine.push();

    expect(await h.engine.tooLarge()).toEqual([]);
    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([["doc.md", "local edit\n"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["doc.md", "local edit\n"]]));
  });

  it("pushes a local edit an out-of-scope deferral held back once the restore lost the revision that moved it out of scope", async () => {
    const h = harness({ merge: "default", wrapVault: withoutConfig });
    const base = h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" });
    await h.engine.pull();
    await h.vault.write("a.md", bytes("edited here\n"));
    h.server.commit({ documentId: "a", path: ".obsidian/a.md", content: "a1\n" });
    await h.engine.pull();
    await h.engine.push();
    expect((await h.journal.listDeferred()).map(({ reason }) => reason)).toEqual(["out-of-scope"]);

    h.server.restoreTo(base.seq);
    expect((await h.engine.pull()).resynced).toBe(true);
    await h.engine.push();

    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([["a.md", "edited here\n"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", "edited here\n"]]));
  });
});
