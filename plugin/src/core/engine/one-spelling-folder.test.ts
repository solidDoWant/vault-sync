import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { files, harness, type Harness } from "./testing";

// On NTFS, APFS and Android's shared storage a folder has one spelling: with
// `notes/` on disk, a file written at `Notes/b.md` lands as `notes/b.md`. The
// engine never respells a folder to chase the server's path (INV-9 compares
// folder segments under `F`), and its own writes and renames into such a
// folder are its own, never reported as the user's (INV-10, #737).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

function faithful(platform: "windows" | "macos" | "android"): Harness {
  return harness({ merge: "default", pathRules: { platform }, vault: new InMemoryVault({ pathRules: { platform }, filesystem: "faithful" }) });
}

describe.each(["windows", "macos", "android"] as const)("a folder with one spelling on disk on %s (#737)", (platform) => {
  it("takes its own write of a remote document into the folder spelled otherwise for its own, and converges", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "a", path: "notes/a.md", content: "a\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "b", path: "Notes/b.md", content: "b\n" });
    await h.engine.pull();
    await h.engine.settled();

    expect(await files(h.vault)).toEqual(
      new Map([
        ["notes/a.md", "a\n"],
        ["notes/b.md", "b\n"],
      ]),
    );
    expect(h.localChanges).toEqual([]);
    const seq = h.server.currentHeadSeq;
    await h.engine.push();
    expect(h.server.currentHeadSeq).toBe(seq);
    expect(h.server.liveDocuments()).toEqual(
      new Map([
        ["notes/a.md", "a"],
        ["Notes/b.md", "b"],
      ]),
    );
  });

  it("takes its own write of a remote edit at the folder's other spelling for its own", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "a", path: "notes/a.md", content: "a\n" });
    h.server.commit({ documentId: "b", path: "Notes/b.md", content: "b\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "b", path: "Notes/b.md", content: "b\nmore\n" });
    await h.engine.pull();
    await h.engine.settled();

    expect(await h.vault.list()).toEqual(expect.arrayContaining(["notes/b.md"]));
    expect(await files(h.vault)).toEqual(
      new Map([
        ["notes/a.md", "a\n"],
        ["notes/b.md", "b\nmore\n"],
      ]),
    );
    expect(h.localChanges).toEqual([]);
  });

  it("reports and pushes the user's case-only rename of a file after a remote rename that respelled only its folder", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "a", path: "notes/a.md", content: "a\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "a", path: "Notes/a.md" });
    await h.engine.pull();
    await h.engine.settled();
    // The folder keeps its one spelling: nothing to rename.
    expect(await h.vault.list()).toEqual(["notes/a.md"]);
    expect(h.localChanges).toEqual([]);

    await h.vault.rename("notes/a.md", "notes/A.md");
    await h.engine.settled();
    expect(h.localChanges).toEqual([{ type: "rename", path: "notes/A.md", oldPath: "notes/a.md" }]);
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["notes/A.md", "a"]]));
  });

  it("keeps the note bound to its file after a remote rename that respelled only its folder, across a restart", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "a", path: "notes/a.md", content: "a\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "a", path: "Notes/a.md" });
    await h.engine.pull();
    await h.engine.settled();
    const seq = h.server.currentHeadSeq;

    h.restart();
    await h.engine.push();
    await h.engine.settled();
    await h.vault.write("notes/a.md", bytes("a\nlocal\n"));
    await h.engine.settled();
    await h.engine.push();

    // The start-up scan saw no move or new file: the user's edit is the note's next revision, at the server's spelling.
    expect(h.localChanges).toEqual([{ type: "modify", path: "notes/a.md" }]);
    expect(h.server.currentHeadSeq).toBe(seq + 1n);
    expect(h.server.liveDocuments()).toEqual(new Map([["Notes/a.md", "a"]]));
    expect(h.server.liveFiles()).toEqual(new Map([["Notes/a.md", "a\nlocal\n"]]));
    // The binding keeps the server's spelling, which names the file under `F`.
    expect((await h.journal.getDocument("a"))?.binding?.spelling).toBe("Notes/a.md");
  });

  it("reports the user's write into the folder at the spelling of an earlier engine write", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "a", path: "notes/a.md", content: "a\n" });
    h.server.commit({ documentId: "b", path: "Notes/b.md", content: "b\n" });
    await h.engine.pull();
    await h.engine.settled();

    await h.vault.write("Notes/b.md", bytes("b\nlocal\n"));
    await h.engine.settled();
    expect(h.localChanges).toEqual([{ type: "modify", path: "notes/b.md" }]);
    await h.engine.push();
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["notes/a.md", "a\n"],
        ["Notes/b.md", "b\nlocal\n"],
      ]),
    );
  });
});
