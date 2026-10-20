import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { files, harness, LateEventsVault, type Harness, type HarnessOptions } from "./testing";

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
    // The rename meets the restart's scan, which finds the note's file under
    // the vault's spelling (a scan alone would commit that spelling, #481).
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
    // No push follows before the later renames: a scan alone would commit the
    // vault's spelling (#481), and the journal would no longer differ.
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

// A harness whose engine hears vault events only when `flush` is called, as
// with a watcher that reports late: by the time an event is handled, later
// user actions may already be on disk. The engine must decide from the
// event's spellings alone, never from the vault's state when it handles it.
function lateHarness(options: HarnessOptions) {
  let late: LateEventsVault | undefined;
  const h = harness({
    ...options,
    wrapVault: (vault) => {
      late = new LateEventsVault(vault);
      return late;
    },
  });
  const flush = async () => {
    late?.flush();
    await h.engine.settled();
  };
  return { h, flush };
}

const deletions = (h: Harness, documentId: string) => h.server.history(documentId).map((revision) => revision.deleted);

describe.each(["macos", "windows"] as const)("a late-reported rename of a respelled note on %s (#374)", (platform) => {
  async function respelled(h: Harness, flush: () => Promise<void>) {
    h.server.commit({ documentId: "X", path: "Foo.md", content: "x\n" });
    await h.engine.pull();
    await flush();
    // A case-only rename lost to a restart: its event never reaches an engine.
    // No push follows before the later changes: a scan alone would commit
    // the vault's spelling (#481), and the journal would no longer differ.
    await h.vault.rename("Foo.md", "foo.md");
    h.restart();
  }

  it("is the note's rename when the user creates a file at the note's old spelling before the event arrives", async () => {
    const { h, flush } = lateHarness({ merge: "default", pathRules: { platform } });
    await respelled(h, flush);

    await h.vault.rename("foo.md", "b.md");
    await h.vault.write("Foo.md", bytes("new\n"));
    await flush();
    for (let round = 0; round < 4; round++) await h.engine.push();

    const live = h.server.liveDocuments();
    expect(live.get("b.md")).toBe("X");
    expect(live.get("Foo.md")).toBeDefined();
    expect(live.get("Foo.md")).not.toBe("X");
    expect(h.server.liveFiles()).toEqual(new Map([["b.md", "x\n"], ["Foo.md", "new\n"]]));
    expect(deletions(h, "X")).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });

  it("moves the note into the path another note just left when the user creates a file at the note's old spelling before the events arrive", async () => {
    const { h, flush } = lateHarness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "P", path: "b.md", content: "p\n" });
    await respelled(h, flush);

    await h.vault.rename("b.md", "c.md");
    await h.vault.rename("foo.md", "b.md");
    await h.vault.write("Foo.md", bytes("new\n"));
    await flush();
    for (let round = 0; round < 4; round++) await h.engine.push();

    const live = h.server.liveDocuments();
    expect(live.get("b.md")).toBe("X");
    expect(live.get("c.md")).toBe("P");
    expect(live.get("Foo.md")).toBeDefined();
    expect(live.get("Foo.md")).not.toBe("X");
    expect(h.server.liveFiles()).toEqual(new Map([["b.md", "x\n"], ["c.md", "p\n"], ["Foo.md", "new\n"]]));
    for (const documentId of ["X", "P"]) expect(deletions(h, documentId)).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });
});

describe("a rename of a note's file respelled by Unicode normalization on macos (#374)", () => {
  const nfc = "Café.md";
  const nfd = "Café.md";

  it("is the note's rename", async () => {
    const { h, flush } = lateHarness({ merge: "default", pathRules: { platform: "macos" } });
    h.server.commit({ documentId: "X", path: nfc, content: "x\n" });
    await h.engine.pull();
    await flush();
    await h.vault.rename(nfc, nfd);
    h.restart();
    await h.engine.push();

    await h.vault.rename(nfd, "b.md");
    await flush();
    await h.engine.push();

    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "X"]]));
    expect(deletions(h, "X")).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.engine.push()).toEqual(quiet);
  });
});

// Path keys fold NFC/NFD and full case folding (ß and SS), but NTFS folds
// only case and APFS case and normalization: two such spellings can be two
// real files. A file under one of them is never taken for the note at the
// other, whatever the vault holds when the event is handled (decision #52).
// The vaults here keep every spelling apart, as such a filesystem does for
// these pairs.
describe.each([
  ["windows", "NFC and NFD", "Café.md", "Café.md"],
  ["windows", "ß and SS", "Straße.md", "STRASSE.md"],
  ["macos", "ß and SS", "Straße.md", "STRASSE.md"],
] as const)("on %s, a new file whose spelling folds to a note's path by %s (#374)", (platform, _name, synced, other) => {
  it("is pushed as a new note when renamed and the note stays at its path", async () => {
    const h = harness({ merge: "default", pathRules: { platform }, vault: new InMemoryVault() });
    h.server.commit({ documentId: "X", path: synced, content: "x\n" });
    await h.engine.pull();

    await h.vault.write(other, bytes("new\n"));
    await h.vault.rename(other, "b.md");
    for (let round = 0; round < 4; round++) await h.engine.push();

    const live = h.server.liveDocuments();
    expect(live.get(synced)).toBe("X");
    expect(live.get("b.md")).toBeDefined();
    expect(live.get("b.md")).not.toBe("X");
    expect(deletions(h, "X")).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });

  it("is pushed as a new note and the note's delete is kept when the events arrive after the delete", async () => {
    const { h, flush } = lateHarness({ merge: "default", pathRules: { platform }, vault: new InMemoryVault() });
    h.server.commit({ documentId: "X", path: synced, content: "x\n" });
    await h.engine.pull();
    await flush();

    await h.vault.write(other, bytes("new\n"));
    await h.vault.rename(other, "b.md");
    await h.vault.delete(synced);
    await flush();
    for (let round = 0; round < 4; round++) await h.engine.push();

    const live = h.server.liveDocuments();
    expect([...live.keys()]).toEqual(["b.md"]);
    expect(live.get("b.md")).not.toBe("X");
    expect(h.server.head("X")?.deleted).toBe(true);
    expect(h.server.liveFiles()).toEqual(new Map([["b.md", "new\n"]]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });
});
