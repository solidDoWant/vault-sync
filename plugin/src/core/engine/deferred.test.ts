import { describe, expect, it } from "vitest";

import type { VaultAdapter } from "../vault/adapter";
import type { InMemoryVault } from "../vault/memory";
import { deferredDocuments } from "./deferred";
import { harness, type Harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);

/** The vault the engine sees, which (like ConfigSyncVault with config sync off) does not sync the config folder. */
const withoutConfig = (vault: InMemoryVault): VaultAdapter => Object.assign(Object.create(vault) as InMemoryVault, { isSynced: (path: string) => !path.startsWith(".obsidian/") });

/** What the UI lists, without the revisions. */
async function listed(h: Harness, vault: VaultAdapter = h.vault) {
  return (await deferredDocuments(h.journal, vault)).map(({ documentId, path, reason, localPath }) => ({ documentId, path, reason, localPath }));
}

describe("deferredDocuments (the conflict view's \"Files that are not synced\", #417)", () => {
  it("lists a remote revision whose path is not a valid vault path, until a later revision moves it to a valid one", async () => {
    const h = harness();
    h.server.commit({ documentId: "x", path: "/outside.md", content: "x1" });
    h.server.commit({ documentId: "a", path: "a.md", content: "fine" });
    await h.engine.pull();

    expect(await listed(h)).toEqual([{ documentId: "x", path: "/outside.md", reason: "invalid-path", localPath: undefined }]);

    h.server.commit({ documentId: "x", path: "inside.md" });
    await h.engine.pull();

    expect(await listed(h)).toEqual([]);
  });

  it("lists a remote revision whose path the vault refuses, until nothing is in the way", async () => {
    const h = harness();
    h.server.commit({ documentId: "n", path: "notes", content: "a file named like a folder" });
    h.server.commit({ documentId: "c", path: "notes/c.md", content: "c1" });
    await h.engine.pull();

    expect(await listed(h)).toEqual([{ documentId: "c", path: "notes/c.md", reason: "path-conflict", localPath: undefined }]);

    h.server.commit({ documentId: "n", path: "elsewhere.md" });
    await h.engine.pull();
    await h.engine.push();

    expect(await listed(h)).toEqual([]);
  });

  it("lists a document whose remote revision moved it out of scope while its local file, with local edits, is in scope", async () => {
    const h = harness({ wrapVault: withoutConfig });
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" });
    await h.engine.pull();
    await h.vault.write("a.md", bytes("edited here\n"));
    h.server.commit({ documentId: "a", path: ".obsidian/a.md", content: "a1\n" });
    await h.engine.pull();

    expect(await listed(h, withoutConfig(h.vault))).toEqual([{ documentId: "a", path: ".obsidian/a.md", reason: "out-of-scope", localPath: "a.md" }]);
    expect(await h.vault.read("a.md")).toEqual(bytes("edited here\n"));
  });

  it("does not list an out-of-scope document that has no file in scope here", async () => {
    const h = harness({ wrapVault: withoutConfig });
    h.server.commit({ documentId: "theme", path: ".obsidian/themes/t.css", content: "body {}" });
    await h.engine.pull();

    expect((await h.journal.listDeferred()).map(({ reason }) => reason)).toEqual(["out-of-scope"]);
    expect(await listed(h, withoutConfig(h.vault))).toEqual([]);
  });

  it("does not list an out-of-scope revision of a config file synced earlier whose file is still on disk, once config sync is off (#527)", async () => {
    let configSync = true;
    const h = harness({ wrapVault: (vault) => Object.assign(Object.create(vault) as InMemoryVault, { isSynced: (path: string) => configSync || !path.startsWith(".obsidian/") }) });
    h.server.commit({ documentId: "snippet", path: ".obsidian/s.css", content: "a{}" });
    await h.engine.pull();
    expect(await h.vault.read(".obsidian/s.css")).toEqual(bytes("a{}"));

    configSync = false;
    h.server.commit({ documentId: "snippet", path: ".obsidian/s.css", content: "b{}" });
    await h.engine.pull();

    expect((await h.journal.listDeferred()).map(({ reason }) => reason)).toEqual(["out-of-scope"]);
    expect(await h.vault.read(".obsidian/s.css")).toEqual(bytes("a{}"));
    expect(await listed(h, withoutConfig(h.vault))).toEqual([]);
  });

  it("does not list a revision the merge path owns", async () => {
    const h = harness();
    h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" });
    await h.engine.pull();
    await h.vault.write("a.md", bytes("local\n"));
    h.server.commit({ documentId: "a", path: "a.md", content: "remote\n" });
    await h.engine.pull();

    expect((await h.journal.listDeferred()).map(({ reason }) => reason)).toEqual(["local-changes"]);
    expect(await listed(h)).toEqual([]);
  });
});
