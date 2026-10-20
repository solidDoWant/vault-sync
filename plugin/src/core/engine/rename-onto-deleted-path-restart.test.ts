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
