import { browser, expect } from "@wdio/globals";

import { callHarness } from "../obsidian";

// Unsaved keystrokes in a note that a sync deletes (#181): a remote delete of
// the note, or the engine moving an unsynced note aside for a remote
// document arriving at its path. The harness types into a real Markdown
// editor and, holding Obsidian's 2-second autosave until the sync is over,
// has vault-sync's sync session pull and push against an in-memory server
// (#600). The engine deletes through the Obsidian adapter, which must save
// the editor and refuse the delete instead of discarding the keystrokes
// (SPEC.md §8). The session never pushes on its own: each scenario's syncs
// are its own, so a debounced push falling due while the harness awaits
// Obsidian cannot take a sync's place (#589).

const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

/** Opens `path` in a Markdown editor in source mode. */
async function openNote(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, notePath) => {
    const file = app.vault.getFileByPath(notePath);
    if (file === null) throw new Error(`no file ${notePath}`);
    await app.workspace.getLeaf(true).openFile(file, { active: true, state: { mode: "source" } });
  }, path);
}

describe("Unsaved keystrokes in a note a sync deletes", function () {
  before(async function () {
    await callHarness("setUpSession");
    await callHarness("startSession");
  });

  it("survive a remote delete of the note", async function () {
    // The session's server holds Synced.md, which the start pulled.
    const synced = "synced from the server\n";
    await openNote("Synced.md");
    await callHarness("deleteOnServer", "Synced.md");

    const result = await callHarness("typeThenSync", "Synced.md", { line: 0, ch: 6 }, " TYPED");

    const typed = "synced TYPED from the server\n";
    expect(result.outcome).toBe("ok");
    // The keystrokes were unsaved when the sync started.
    expect(result.diskBefore).toBe(synced);
    expect(result.editor).toBe(typed);
    expect(result.files["Synced.md"]).toBe(typed);
  });

  it("survive the note being moved aside for a remote rename onto its path", async function () {
    // Moving.md is synced; another device renames it onto Landing.md, where
    // this device has just created a note the server has never seen. The
    // engine copies that note to a conflict copy and deletes it, to make room.
    await callHarness("commitOnServer", "Moving.md", "the synced note\n");
    await callHarness("syncSession");
    await callHarness("renameOnServer", "Moving.md", "Landing.md");
    const local = lines("# Landing", "written on this device");

    const result = await callHarness("typeThenSync", "Landing.md", { line: 1, ch: 7 }, " TYPED", local);

    const typed = lines("# Landing", "written TYPED on this device");
    expect(result.outcome).toBe("ok");
    expect(result.diskBefore).toBe(local);
    // The first attempt copied the note as it was on disk and was refused
    // the delete, saving the keystrokes. The next attempt, in the same sync,
    // moved the saved note aside, and the renamed document took its path.
    expect(Object.values(result.files)).toContain(typed);
    expect(result.files["Landing.md"]).toBe("the synced note\n");
  });

  it("survive a remote document arriving at the note's path", async function () {
    // The remote content overlaps the keystrokes, so the engine's write of
    // the merge result is refused with them saved (editor-safe writes,
    // SPEC.md §8): that sync fails, and the next one merges the saved note.
    await callHarness("commitOnServer", "Fresh.md", lines("# Fresh", "written on another device"));
    const local = lines("# Fresh", "written on this device");

    const result = await callHarness("typeThenSync", "Fresh.md", { line: 1, ch: 7 }, " TYPED", local);

    const typed = lines("# Fresh", "written TYPED on this device");
    expect(result.outcome).toBe("Error: the sync failed: UnsavedEditsError: Fresh.md has unsaved edits that the incoming change cannot be merged with");
    expect(result.diskBefore).toBe(local);
    expect(result.editor).toBe(typed);
    expect(Object.values(result.files)).toContain(typed);

    await callHarness("syncSession");
    const files = await callHarness("vaultFiles");
    expect(files["Fresh.md"]).toBe(lines("# Fresh", "written on another device"));
    expect(Object.values(files)).toContain(typed);
  });
});
