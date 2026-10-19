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
      outcome: "UnsavedEditsError: Busy note.md has unsaved edits that the incoming change cannot be merged with",
      diskBefore: base,
      // Neither side overwrote the other: the editor and the disk hold the
      // user's text, and the engine keeps the remote revision deferred.
      editor: local,
      cursor: { line: 2, ch: 14 },
      disk: local,
    });
  });
});

describe("Remote changes named against the disk the engine checked (#163)", function () {
  const base = lines("# Title", "line one", "line two", "line three", "line four", "last line");
  // Touches no line the user types on, so a merge would apply it.
  const remote = lines("# Title", "line one", "line two", "line three", "line four", "last line, edited remotely");
  const typed = lines("# Title", "line one", "line two", "line TYPED three", "line four", "last line");

  it("are refused once the editor saved after the check, keeping the saved text", async function () {
    await openNote("Saved note.md", base);
    // Obsidian's autosave lands between the engine's check and its write.
    const result = await callHarness("typeThenWriteRemote", "Saved note.md", { line: 3, ch: 4 }, " TYPED", remote, { save: true, expectBase: true });

    expect(result).toEqual({ outcome: "VaultError: changed: Saved note.md", diskBefore: base, editor: typed, cursor: { line: 3, ch: 10 }, disk: typed });
  });

  it("are merged with unsaved keystrokes when nothing was saved since the check", async function () {
    await openNote("Unsaved note.md", base);
    const result = await callHarness("typeThenWriteRemote", "Unsaved note.md", { line: 3, ch: 4 }, " TYPED", remote, { expectBase: true });

    const merged = lines("# Title", "line one", "line two", "line TYPED three", "line four", "last line, edited remotely");
    expect(result).toEqual({ outcome: "ok", diskBefore: base, editor: merged, cursor: { line: 3, ch: 10 }, disk: merged });
  });

  it("refuse a delete while the editor holds unsaved keystrokes, saving them instead", async function () {
    await openNote("Typed note.md", base);
    const result = await callHarness("typeThenDeleteRemote", "Typed note.md", { line: 3, ch: 4 }, " TYPED");

    expect(result).toEqual({ outcome: "VaultError: changed: Typed note.md", editor: typed, disk: typed });
  });

  it("delete a note with nothing unsaved", async function () {
    await openNote("Idle note.md", base);
    const result = await callHarness("typeThenDeleteRemote", "Idle note.md", { line: 3, ch: 4 }, "");

    expect([result.outcome, result.disk]).toEqual(["ok", null]);
  });

  it("refuse a delete with no precondition while the editor holds unsaved keystrokes, saving them instead (#181)", async function () {
    await openNote("Typed unchecked note.md", base);
    const result = await callHarness("typeThenDeleteRemote", "Typed unchecked note.md", { line: 3, ch: 4 }, " TYPED", false);

    expect(result).toEqual({
      outcome: "UnsavedEditsError: Typed unchecked note.md has unsaved edits that the incoming change cannot be merged with",
      editor: typed,
      disk: typed,
    });
  });

  it("delete a note with no precondition and nothing unsaved", async function () {
    await openNote("Idle unchecked note.md", base);
    const result = await callHarness("typeThenDeleteRemote", "Idle unchecked note.md", { line: 3, ch: 4 }, "", false);

    expect([result.outcome, result.disk]).toEqual(["ok", null]);
  });
});

describe("Remote writes to a canvas open in its view", function () {
  const canvas = (...texts: string[]) =>
    JSON.stringify({
      nodes: texts.map((text, index) => ({ id: `node${String(index)}`, type: "text", text, x: 0, y: index * 100, width: 200, height: 60 })),
      edges: [],
    });

  /** Creates `path` with `content` and opens it in a canvas view. */
  async function openCanvas(path: string, content: string): Promise<void> {
    await browser.executeObsidian(
      async ({ app }, canvasPath, data) => {
        const file = await app.vault.create(canvasPath, data);
        await app.workspace.getLeaf(true).openFile(file, { active: true });
      },
      path,
      content,
    );
  }

  it("are refused while the canvas has unsaved changes, which are saved instead", async function () {
    const base = canvas("base node");
    await openCanvas("Busy board.canvas", base);
    const remote = canvas("base node", "remote node");
    const result = await callHarness("addCanvasNodeThenWriteRemote", "Busy board.canvas", "unsaved node", remote);

    expect(result.outcome).toBe("UnsavedEditsError: Busy board.canvas has unsaved edits that the incoming change cannot be merged with");
    // The node was unsaved when the remote change arrived.
    expect(result.diskBefore).toBe(base);
    // It survives in the view and is now on disk; the remote content was not written.
    expect(result.view).toContain("unsaved node");
    expect(result.disk).toBe(result.view);
    expect(result.disk).not.toContain("remote node");
  });

  it("are refused once the canvas saved after the engine's check (#163)", async function () {
    const base = canvas("base node");
    await openCanvas("Saved board.canvas", base);
    const remote = canvas("base node", "remote node");
    const result = await callHarness("addCanvasNodeThenWriteRemote", "Saved board.canvas", "saved node", remote, { save: true, expectBase: true });

    expect(result.outcome).toBe("VaultError: changed: Saved board.canvas");
    expect(result.diskBefore).toBe(base);
    expect(result.disk).toContain("saved node");
    expect(result.disk).not.toContain("remote node");
    expect(result.view).toBe(result.disk);
  });

  it("are applied when the canvas has nothing unsaved", async function () {
    await openCanvas("Clean board.canvas", canvas("base node"));
    // Put the canvas's own serialization on disk, so the view's data equals the disk.
    const saved = await callHarness("canvasViewData", "Clean board.canvas");
    expect(saved).toContain("base node");
    await browser.executeObsidian(
      async ({ app }, path, data) => {
        const file = app.vault.getFileByPath(path);
        if (file === null) throw new Error(`no file ${path}`);
        await app.vault.modify(file, data);
      },
      "Clean board.canvas",
      saved,
    );
    const remote = canvas("base node", "remote node");
    const result = await callHarness("addCanvasNodeThenWriteRemote", "Clean board.canvas", null, remote);

    expect(result.outcome).toBe("ok");
    expect(result.disk).toBe(remote);
    // The view picks up the new content from disk.
    await browser.waitUntil(async () => (await callHarness("canvasViewData", "Clean board.canvas")).includes("remote node"));
  });
});
