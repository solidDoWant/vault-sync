import { describe, expect, it } from "vitest";

import { files, syncedOnBoth, twoDevices } from "./testing";

// The user deletes a note, the app restarts (the delete was never pushed, so
// only the missing file tells of it), and the user then renames another note
// onto the deleted note's path, in the vault's spelling or another one the
// platform folds into it. Another device edited the deleted note, so the pull
// brings it back (#526). The vault refuses a rename onto an existing file, so
// the renamed file is the renamed note's, never the deleted note's: the
// renamed note keeps its document id and is never tombstoned, and the deleted
// note comes back with the remote edit (SPEC.md §2 principle 1, §7).

const bytes = (content: string) => new TextEncoder().encode(content);
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe.each([
  ["posix", "a.md"],
  ["macos", "a.md"],
  ["macos", "A.md"],
  ["windows", "A.md"],
] as const)("a rename onto a note's path deleted before a restart on %s, to %s (#526)", (platform, target) => {
  it.each([false, true])("keeps the renamed note when another device edited the deleted one (restart: %s)", async (restart) => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "x.md", "x\n");
    await syncedOnBoth(devices, "a.md", "a\n");
    const before = server.liveDocuments();
    const renamed = before.get("x.md");
    const edited = before.get("a.md");
    expect(renamed).toBeDefined();
    expect(edited).toBeDefined();

    await b.vault.write("a.md", bytes("a\nremote\n"));
    await b.engine.push();
    await a.vault.delete("a.md");
    await a.engine.settled();
    if (restart) a.restart();
    await a.vault.rename("x.md", target);
    await a.engine.settled();
    for (let round = 0; round < 4; round++) {
      await a.engine.push();
      await b.engine.push();
    }
    await a.engine.pull();
    await b.engine.pull();

    const live = server.liveDocuments();
    const contents = server.liveFiles();
    const pathOf = (documentId: string | undefined) => [...live].find(([, id]) => id === documentId)?.[0];
    const renamedPath = pathOf(renamed);
    const editedPath = pathOf(edited);
    expect(renamedPath, "the renamed note is live").toBeDefined();
    expect(contents.get(renamedPath ?? "")).toBe("x\n");
    expect(editedPath, "the edited note is live").toBeDefined();
    expect(contents.get(editedPath ?? "")).toBe("a\nremote\n");
    expect(live.size).toBe(2);
    expect(await files(a.vault)).toEqual(contents);
    expect(await files(b.vault)).toEqual(contents);
    expect(await a.journal.listDeferred()).toEqual([]);
    expect(await b.journal.listDeferred()).toEqual([]);
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});

// The same rename, but this device pushes before the deleted note's remote
// edit reaches the server, and the renamed note may have been edited on
// another device too, at its old path (seed 100083): the push must commit the
// delete and the rename (the deleted note's own file was gone when the vault
// allowed the rename), never a tombstone of the renamed note. The deleted
// note's remote edit is kept beside the renamed one (SPEC.md §2 principle 1,
// §6.3).
describe.each([
  ["posix", "a.md"],
  ["macos", "a.md"],
  ["macos", "A.md"],
  ["windows", "A.md"],
] as const)("a rename onto a note's path deleted before a restart, pushed before that note's remote edit, on %s, to %s (#526)", (platform, target) => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("keeps the renamed note's id (renamed note edited remotely: %s, deleted note edited remotely: %s)", async (renamedEdited, deletedEdited) => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "x.md", "x\n");
    await syncedOnBoth(devices, "a.md", "a\n");
    const before = server.liveDocuments();
    const renamed = before.get("x.md");
    const deleted = before.get("a.md");
    expect(renamed).toBeDefined();
    expect(deleted).toBeDefined();

    await a.vault.delete("a.md");
    await a.engine.settled();
    a.restart();
    await a.vault.rename("x.md", target);
    await a.engine.settled();
    if (renamedEdited) {
      await b.vault.write("x.md", bytes("x\nremote\n"));
      await b.engine.push();
    }
    // Edited on the other device before it sees this device's push, which
    // commits the delete first.
    if (deletedEdited) await b.vault.write("a.md", bytes("a\nremote\n"));
    await a.engine.push();
    for (let round = 0; round < 4; round++) {
      await a.engine.push();
      await b.engine.push();
    }
    await a.engine.pull();
    await b.engine.pull();

    const live = server.liveDocuments();
    const contents = server.liveFiles();
    const pathOf = (documentId: string | undefined) => [...live].find(([, id]) => id === documentId)?.[0];
    const renamedPath = pathOf(renamed);
    expect(renamedPath, "the renamed note is live").toBeDefined();
    expect(contents.get(renamedPath ?? "")).toBe(renamedEdited ? "x\nremote\n" : "x\n");
    const deletedPath = pathOf(deleted);
    if (deletedEdited) {
      // The edit is kept beside the renamed note. It reached the server after
      // the delete, so it is kept as a new document, as it is when the delete
      // was never lost to a restart.
      expect([...contents.values()], "the deleted note's remote edit is kept").toContain("a\nremote\n");
      expect(renamedPath).toBe(target);
    } else {
      expect(deletedPath, "the deleted note stays deleted").toBeUndefined();
      expect(renamedPath).toBe(target);
    }
    expect(live.size).toBe(deletedEdited ? 2 : 1);
    expect(await files(a.vault)).toEqual(contents);
    expect(await files(b.vault)).toEqual(contents);
    expect(await a.journal.listDeferred()).toEqual([]);
    expect(await b.journal.listDeferred()).toEqual([]);
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});

// A case-only rename of a note's own file moves that file: it is no other
// file renamed onto the note's path, so a remote edit arriving before the
// rename is pushed is merged into the note, never taken as one of a note
// whose file was gone (#526).
describe.each(["macos", "windows"] as const)("an unpushed case-only rename on %s (#526)", (platform) => {
  it("merges a remote edit into the renamed note", async () => {
    const devices = twoDevices({ pathRules: { platform } });
    const { a, b, server } = devices;
    await syncedOnBoth(devices, "a.md", "a\n");
    const note = server.liveDocuments().get("a.md");
    expect(note).toBeDefined();

    await a.vault.rename("a.md", "A.md");
    await a.engine.settled();
    await b.vault.write("a.md", bytes("a\nremote\n"));
    await b.engine.push();
    await a.engine.pull();
    expect(await files(a.vault)).toEqual(new Map([["A.md", "a\nremote\n"]]));
    await a.engine.push();
    await b.engine.pull();

    expect(server.liveDocuments()).toEqual(new Map([["A.md", note]]));
    expect(server.liveFiles()).toEqual(new Map([["A.md", "a\nremote\n"]]));
    expect(await files(b.vault)).toEqual(server.liveFiles());
    expect(await a.journal.listDeferred()).toEqual([]);
    expect(await a.engine.push()).toEqual(quiet);
    expect(await b.engine.push()).toEqual(quiet);
  });
});
