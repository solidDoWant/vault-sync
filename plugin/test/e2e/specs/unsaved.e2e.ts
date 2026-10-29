import { browser, expect } from "@wdio/globals";

import { callHarness } from "../obsidian";

// Unsaved keystrokes in a note that a sync deletes or moves: a remote delete
// of the note, or the engine moving an unsynced note aside to a conflict copy
// name for a remote document arriving at its path (docs/design/engine.md §5,
// rule W). The harness types into a real Markdown editor and, holding
// Obsidian's 2-second autosave until the sync is over, has vault-sync's sync
// session sync against an in-memory server. A delete goes through the
// Obsidian adapter, which saves the editor and refuses the delete instead of
// discarding the keystrokes; a move is a rename, which the open editor
// follows, so its autosave writes the keystrokes to the conflict copy. The
// session never syncs on its own: each scenario's syncs are its own.

const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

/** Waits until some file in the vault holds `text`, as once Obsidian's autosave has run. */
async function waitForFileWith(text: string): Promise<Record<string, string>> {
  await browser.waitUntil(async () => Object.values(await callHarness("vaultFiles")).includes(text), { timeoutMsg: `no file holds ${JSON.stringify(text)}` });
  return callHarness("vaultFiles");
}

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
    // engine moves that note to a conflict copy name, to make room.
    await callHarness("commitOnServer", "Moving.md", "the synced note\n");
    await callHarness("syncSession");
    await callHarness("renameOnServer", "Moving.md", "Landing.md");
    const local = lines("# Landing", "written on this device");

    const result = await callHarness("typeThenSync", "Landing.md", { line: 1, ch: 7 }, " TYPED", local);

    const typed = lines("# Landing", "written TYPED on this device");
    expect(result.outcome).toBe("ok");
    expect(result.diskBefore).toBe(local);
    // The editor followed the note to its conflict copy name, keystrokes and all.
    expect(result.editor).toBe(typed);
    expect(result.files["Landing.md"]).toBe("the synced note\n");
    const files = await waitForFileWith(typed);
    expect(Object.entries(files).find(([, text]) => text === typed)?.[0]).toMatch(/^Landing \(Conflicted copy e2e-device \d{12}\)\.md$/u);
  });

  it("survive a remote document arriving at the note's path", async function () {
    // This device's note is not synced, so the remote document takes the
    // path and the note moves to a conflict copy name (rule W), with the
    // editor and its keystrokes.
    await callHarness("commitOnServer", "Fresh.md", lines("# Fresh", "written on another device"));
    const local = lines("# Fresh", "written on this device");

    const result = await callHarness("typeThenSync", "Fresh.md", { line: 1, ch: 7 }, " TYPED", local);

    const typed = lines("# Fresh", "written TYPED on this device");
    expect(result.outcome).toBe("ok");
    expect(result.diskBefore).toBe(local);
    expect(result.editor).toBe(typed);
    expect(result.files["Fresh.md"]).toBe(lines("# Fresh", "written on another device"));
    const files = await waitForFileWith(typed);
    expect(Object.entries(files).find(([, text]) => text === typed)?.[0]).toMatch(/^Fresh \(Conflicted copy e2e-device \d{12}\)\.md$/u);

    // The saved keystrokes sync as the copy's content.
    await callHarness("syncSession");
    expect(Object.values(await callHarness("serverFiles"))).toContain(typed);
  });
});
