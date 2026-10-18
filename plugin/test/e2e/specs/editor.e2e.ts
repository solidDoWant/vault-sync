import { browser, expect } from "@wdio/globals";

import { callHarness } from "../obsidian";

// Remote changes applied to a note open in Obsidian's Markdown editor
// (src/obsidian/vault-adapter.ts, ObsidianVaultAdapter.write).

const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

/** Creates `path` with `text` and opens it in a Markdown editor in source mode. */
async function openNote(path: string, text: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, notePath, content) => {
      const file = await app.vault.create(notePath, content);
      const leaf = app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true, state: { mode: "source" } });
    },
    path,
    text,
  );
}

/** The active editor's text and cursor, and the file on disk. */
async function editorState(path: string) {
  return browser.executeObsidian(async ({ app, obsidian }, notePath) => {
    const file = app.vault.getFileByPath(notePath);
    if (file === null) throw new Error(`no file ${notePath}`);
    const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (view?.file !== file) throw new Error(`${notePath} is not the active Markdown view`);
    return { editor: view.editor.getValue(), cursor: view.editor.getCursor(), disk: await app.vault.read(file) };
  }, path);
}

describe("Remote writes to a note open in the editor", function () {
  const base = lines("# Title", "line one", "line two", "line three", "line four", "last line");

  it("keep the cursor and unsaved keystrokes when the change does not overlap them", async function () {
    await openNote("Open note.md", base);
    // The remote side inserts a line above the cursor and edits the last line.
    const remote = lines("# Title", "remote intro", "line one", "line two", "line three", "line four", "last line, edited remotely");
    const result = await callHarness("typeThenWriteRemote", "Open note.md", { line: 3, ch: 4 }, " TYPED", remote);

    const merged = lines("# Title", "remote intro", "line one", "line two", "line TYPED three", "line four", "last line, edited remotely");
    expect(result).toEqual({
      outcome: "ok",
      // The keystrokes were unsaved when the remote change arrived.
      diskBefore: base,
      editor: merged,
      // Still right after the typed text, one line further down.
      cursor: { line: 4, ch: 10 },
      disk: merged,
    });

    // Obsidian still has the typed text queued for its own autosave. Flushing
    // it must not undo anything.
    await browser.executeObsidian(async ({ app, obsidian }) => {
      await app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.save();
    });
    expect(await editorState("Open note.md")).toEqual({ editor: merged, cursor: { line: 4, ch: 10 }, disk: merged });
  });

  it("apply a change to a note with nothing unsaved, keeping the cursor", async function () {
    await openNote("Clean note.md", base);
    const remote = lines("# Title", "line one", "line two, edited remotely", "line three", "line four", "last line");
    const result = await callHarness("typeThenWriteRemote", "Clean note.md", { line: 4, ch: 2 }, "", remote);
    expect(result).toEqual({ outcome: "ok", diskBefore: base, editor: remote, cursor: { line: 4, ch: 2 }, disk: remote });
  });

  it("refuse a change that overlaps unsaved keystrokes, saving them instead", async function () {
    await openNote("Busy note.md", base);
    const remote = lines("# Title", "line one", "line two, edited remotely", "line three", "line four", "last line");
    const result = await callHarness("typeThenWriteRemote", "Busy note.md", { line: 2, ch: 8 }, " TYPED", remote);

    const local = lines("# Title", "line one", "line two TYPED", "line three", "line four", "last line");
    expect(result).toEqual({
      outcome: "UnsavedEditsError: Busy note.md has unsaved edits that overlap the incoming change",
      diskBefore: base,
      // Neither side overwrote the other: the editor and the disk hold the
      // user's text, and the engine keeps the remote revision deferred.
      editor: local,
      cursor: { line: 2, ch: 14 },
      disk: local,
    });
  });
});
