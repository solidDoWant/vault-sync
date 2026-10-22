import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { files, harness, type Harness } from "./testing";

// #933 (INV-6, PO-9): the user renames a note to `x/a.md` while the vault
// already has an `X/` folder, so the file lands at `X/a.md` (a folder has one
// spelling on disk, #737). Another device makes the same move, which the
// pull finds already done. The folder spelling the vault kept is no local
// rename: the server carried the user's move, so a later remote delete wins
// and nothing is pushed back.

const encoder = new TextEncoder();
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

function faithful(platform: "windows" | "macos"): Harness {
  return harness({ merge: "default", pathRules: { platform }, vault: new InMemoryVault({ pathRules: { platform } }) });
}

async function renamedLikeTheServer(platform: "windows" | "macos"): Promise<Harness> {
  const h = faithful(platform);
  h.server.commit({ documentId: "r", path: "X/b.md", content: "b\n" });
  await h.engine.pull();
  await h.vault.rename("X/b.md", "x/a.md");
  await h.engine.settled();
  expect(await files(h.vault)).toEqual(new Map([["X/a.md", "b\n"]]));
  h.server.commit({ documentId: "r", path: "x/a.md", content: "b\n" });
  return h;
}

describe.each(["windows", "macos"] as const)("a rename the server carried but for a folder spelling on %s (#933)", (platform) => {
  it("lets a later remote delete win: the document stays deleted", async () => {
    const h = await renamedLikeTheServer(platform);
    h.server.commit({ documentId: "r", path: "x/a.md", deleted: true });
    await h.engine.pull();
    expect(await h.engine.push()).toEqual(quiet);

    expect(h.server.liveDocuments()).toEqual(new Map());
    expect(await files(h.vault)).toEqual(new Map());
  });

  it("pushes nothing when the remote rename is the last change", async () => {
    const h = await renamedLikeTheServer(platform);
    await h.engine.pull();
    const seq = h.server.currentHeadSeq;
    expect(await h.engine.push()).toEqual(quiet);

    expect(h.server.currentHeadSeq).toBe(seq);
    expect(h.server.liveDocuments()).toEqual(new Map([["x/a.md", "r"]]));
    expect(await files(h.vault)).toEqual(new Map([["X/a.md", "b\n"]]));
  });

  it("keeps the user's own spelling of the file name: a remote delete loses to it", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "r", path: "X/b.md", content: "b\n" });
    await h.engine.pull();
    await h.vault.rename("X/b.md", "x/A.md");
    await h.engine.settled();
    h.server.commit({ documentId: "r", path: "x/a.md", content: "b\n" });
    h.server.commit({ documentId: "r", path: "x/a.md", deleted: true });
    await h.engine.pull();
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["X/A.md", "r"]]));
    expect(await files(h.vault)).toEqual(new Map([["X/A.md", "b\n"]]));
  });

  it("keeps an edit made after the matched rename against a remote delete", async () => {
    const h = await renamedLikeTheServer(platform);
    await h.engine.pull();
    await h.vault.write("X/a.md", encoder.encode("b\nmine\n"));
    await h.engine.settled();
    h.server.commit({ documentId: "r", path: "x/a.md", deleted: true });
    await h.engine.pull();
    await h.engine.push();

    expect([...h.server.liveFiles().values()]).toEqual(["b\nmine\n"]);
    expect(h.server.liveDocuments().size).toBe(1);
    expect([...h.server.liveDocuments().values()]).toEqual(["r"]);
  });

  it("keeps the user's own rename of the folder against a remote edit the pull merges first", async () => {
    const vault = new InMemoryVault({ pathRules: { platform } });
    const h = harness({ merge: "default", pathRules: { platform }, vault });
    h.server.commit({ documentId: "r", path: "x/a.md", content: "a\n" });
    await h.engine.pull();
    await vault.renameFolder("x", "X");
    await h.engine.settled();
    h.server.commit({ documentId: "r", path: "x/a.md", content: "a\ntheirs\n" });
    await h.engine.pull();
    await h.engine.push();

    expect(h.server.liveFiles()).toEqual(new Map([["X/a.md", "a\ntheirs\n"]]));
    expect(await files(h.vault)).toEqual(new Map([["X/a.md", "a\ntheirs\n"]]));
  });
});
