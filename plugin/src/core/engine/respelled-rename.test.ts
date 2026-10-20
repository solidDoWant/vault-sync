import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { files, harness } from "./testing";

// A note whose file the vault holds under another spelling than the
// journal's path (a case-only rename lost to a restart, on Windows or macOS
// rules) is still that note's file: a later live rename of it is the note's
// rename, never a delete of the note and a create of another one (#374,
// SPEC.md §2 principle 1). On POSIX a respelling is a different file, and a
// rename made while the app was not running is #349, so only the plain
// rename runs there.

const bytes = (value: string) => new TextEncoder().encode(value);

const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe.each(["posix", "macos", "windows"] as const)("a rename of a note's file on %s (#374)", (platform) => {
  const caseInsensitive = platform !== "posix";

  it("moves a note into the path another note just left", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "X", path: "x.md", content: "x\n" });
    h.server.commit({ documentId: "P", path: "b.md", content: "p\n" });
    await h.engine.pull();

    await h.vault.rename("b.md", "c.md");
    await h.vault.rename("x.md", "b.md");
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "X"], ["c.md", "P"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it.runIf(caseInsensitive)("renames a note whose file the user respelled before a restart", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "X", path: "Foo.md", content: "x\n" });
    await h.engine.pull();
    await h.vault.rename("Foo.md", "foo.md");
    h.restart();
    await h.engine.push();
    expect(h.server.liveDocuments()).toEqual(new Map([["Foo.md", "X"]]));

    await h.vault.rename("foo.md", "b.md");
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "X"]]));
    expect(h.server.history("X").map((revision) => revision.deleted)).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it.runIf(caseInsensitive)("moves a respelled note into the path another note just left", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "X", path: "Foo.md", content: "x\n" });
    h.server.commit({ documentId: "P", path: "b.md", content: "p\n" });
    await h.engine.pull();
    await h.vault.rename("Foo.md", "foo.md");
    h.restart();
    await h.engine.push();

    await h.vault.rename("b.md", "c.md");
    await h.vault.rename("foo.md", "b.md");
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "X"], ["c.md", "P"]]));
    for (const documentId of ["X", "P"]) expect(h.server.history(documentId).map((revision) => revision.deleted)).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it.runIf(caseInsensitive)("pushes a new file created under another spelling of a deleted note's path and renamed away as a new note", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "X", path: "Foo.md", content: "x\n" });
    await h.engine.pull();

    await h.vault.delete("Foo.md");
    await h.vault.write("foo.md", bytes("new\n"));
    await h.vault.rename("foo.md", "b.md");
    await h.engine.push();

    const live = h.server.liveDocuments();
    expect([...live.keys()]).toEqual(["b.md"]);
    expect(live.get("b.md")).not.toBe("X");
    expect(h.server.head("X")?.deleted).toBe(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it.runIf(caseInsensitive)("keeps a respelled note in place when the user renames it back to the synced spelling", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "X", path: "Foo.md", content: "x\n" });
    await h.engine.pull();
    await h.vault.rename("Foo.md", "foo.md");
    h.restart();
    await h.engine.push();

    await h.vault.rename("foo.md", "Foo.md");
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["Foo.md", "X"]]));
    expect(h.server.history("X").map((revision) => revision.deleted)).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });
});

// Path keys fold NFC/NFD and full case folding (ß and SS), which NTFS and
// macOS do not: two such spellings can be two real files. A new file under
// one of them is never taken for the note at the other while the vault
// still holds the note's own spelling.
describe.each([
  ["NFC and NFD", "Café.md", "Café.md"],
  ["ß and SS", "Straße.md", "STRASSE.md"],
] as const)("a new file whose spelling folds to a note's path by %s (#374)", (_name, synced, other) => {
  it("is pushed as a new note when renamed and the note stays at its path", async () => {
    const h = harness({ merge: "default", pathRules: { platform: "windows" }, vault: new InMemoryVault() });
    h.server.commit({ documentId: "X", path: synced, content: "x\n" });
    await h.engine.pull();

    await h.vault.write(other, bytes("new\n"));
    await h.vault.rename(other, "b.md");
    for (let round = 0; round < 4; round++) await h.engine.push();

    const live = h.server.liveDocuments();
    expect(live.get(synced)).toBe("X");
    expect(live.get("b.md")).toBeDefined();
    expect(live.get("b.md")).not.toBe("X");
    expect(h.server.history("X").map((revision) => revision.deleted)).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });
});
