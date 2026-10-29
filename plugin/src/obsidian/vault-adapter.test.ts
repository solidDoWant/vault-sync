import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../core/hash";
import { VaultError } from "../core/vault/adapter";

// The adapter's runtime imports from Obsidian, reduced to what create and
// rename touch: the file classes the adapter checks with instanceof, and
// normalizePath (here: every path is already normal).
vi.mock("obsidian", () => {
  class TAbstractFile {
    constructor(readonly path: string) {}
  }
  class EditableFileView {
    file: unknown = null;
  }
  class TextFileView extends EditableFileView {}
  class MarkdownView extends TextFileView {}
  // Desktop's adapter class; the fake apps' adapters are not one, so the adapter has no atomic replace.
  class FileSystemAdapter {
    readonly name = "desktop";
  }
  return { TAbstractFile, TFile: class extends TAbstractFile {}, TFolder: class extends TAbstractFile {}, EditableFileView, TextFileView, MarkdownView, FileSystemAdapter, normalizePath: (path: string) => path };
});

const obsidian = await import("obsidian");
const { TFile, TFolder } = obsidian;
const { ObsidianVaultAdapter, UnsavedEditsError } = await import("./vault-adapter");

/** The error Node's fs gives for a missing path, which Windows also gives for a name it refuses. */
function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
}

/**
 * The error Obsidian's Android app gives (from Capacitor's filesystem) when it
 * cannot open a file to write, as seen for a 300-byte name in spike #187: a
 * bare message, no code.
 */
function fileNotCreated(): Error {
  return new Error("FILE_NOTCREATED");
}

/**
 * A vault whose index holds `files` and `folders` and whose disk holds the
 * paths in `onDisk`, where creating or renaming a file fails with `fail`'s
 * error (ENOENT by default).
 */
function fakeApp(options: { files?: string[]; folders?: string[]; onDisk: string[]; fail?: (path: string) => Error }): App {
  const fail = options.fail ?? enoent;
  const indexed = new Map<string, unknown>();
  for (const path of options.folders ?? []) indexed.set(path, new (TFolder as unknown as new (path: string) => object)(path));
  for (const path of options.files ?? []) indexed.set(path, new (TFile as unknown as new (path: string) => object)(path));
  const vault = {
    getAbstractFileByPath: (path: string) => indexed.get(path) ?? null,
    getFileByPath: (path: string) => {
      const file = indexed.get(path);
      return file instanceof TFile ? file : null;
    },
    createFolder: () => Promise.resolve(),
    createBinary: (path: string) => Promise.reject(fail(path)),
    rename: (_file: unknown, path: string) => Promise.reject(fail(path)),
    adapter: { exists: (path: string) => Promise.resolve(options.onDisk.includes(path)) },
  };
  return { vault } as unknown as App;
}

const bytes = new TextEncoder().encode("text");

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

describe("ObsidianVaultAdapter on an ENOENT from the platform", () => {
  it("takes a created file's name as refused when its parent folder exists", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ folders: ["notes"], onDisk: ["notes"] }));
    await expect(adapter.write("notes/name.md", bytes)).rejects.toEqual(new VaultError("unmaterializable", "notes/name.md"));
  });

  it("takes a created top-level file's name as refused", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ onDisk: [] }));
    await expect(adapter.write("name.md", bytes)).rejects.toEqual(new VaultError("unmaterializable", "name.md"));
  });

  it("surfaces the original error when a created file's parent folder is missing", async () => {
    // The index still lists the folder; the disk no longer has it.
    const adapter = new ObsidianVaultAdapter(fakeApp({ folders: ["notes"], onDisk: [] }));
    const error = await adapter.write("notes/name.md", bytes).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ code: "ENOENT" });
  });

  it("takes a rename's new name as refused when its parent folder and the source exist", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ files: ["old.md"], folders: ["notes"], onDisk: ["old.md", "notes"] }));
    await expect(adapter.rename("old.md", "notes/new.md")).rejects.toEqual(new VaultError("unmaterializable", "notes/new.md"));
  });

  it("surfaces the original error when a rename's source is missing", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ files: ["old.md"], folders: ["notes"], onDisk: ["notes"] }));
    const error = await adapter.rename("old.md", "notes/new.md").catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ code: "ENOENT" });
  });

  it("surfaces the original error when a rename's new parent folder is missing", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ files: ["old.md"], folders: ["notes"], onDisk: ["old.md"] }));
    const error = await adapter.rename("old.md", "notes/new.md").catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ code: "ENOENT" });
  });

  it("surfaces the original error when a top-level rename's source is missing", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ files: ["old.md"], onDisk: [] }));
    const error = await adapter.rename("old.md", "new.md").catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ code: "ENOENT" });
  });
});

describe("ObsidianVaultAdapter on Android's FILE_NOTCREATED (#705)", () => {
  it("takes a created file's name as refused when its parent folder exists", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ folders: ["notes"], onDisk: ["notes"], fail: fileNotCreated }));
    await expect(adapter.write("notes/name.md", bytes)).rejects.toEqual(new VaultError("unmaterializable", "notes/name.md"));
  });

  it("takes a created top-level file's name as refused", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ onDisk: [], fail: fileNotCreated }));
    await expect(adapter.write("name.md", bytes)).rejects.toEqual(new VaultError("unmaterializable", "name.md"));
  });

  it("surfaces the original error when a created file's parent folder is missing", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ folders: ["notes"], onDisk: [], fail: fileNotCreated }));
    const error = await adapter.write("notes/name.md", bytes).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ message: "FILE_NOTCREATED" });
  });

  it("takes a rename's new name as refused when its parent folder and the source exist", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ files: ["old.md"], folders: ["notes"], onDisk: ["old.md", "notes"], fail: fileNotCreated }));
    await expect(adapter.rename("old.md", "notes/new.md")).rejects.toEqual(new VaultError("unmaterializable", "notes/new.md"));
  });

  it("surfaces the original error when a rename's source is missing", async () => {
    const adapter = new ObsidianVaultAdapter(fakeApp({ files: ["old.md"], folders: ["notes"], onDisk: ["notes"], fail: fileNotCreated }));
    const error = await adapter.rename("old.md", "notes/new.md").catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ message: "FILE_NOTCREATED" });
  });
});

describe("ObsidianVaultAdapter writing a note open in reading view", () => {
  /**
   * A vault holding `disk` at note.md, open in one Markdown view in reading
   * view whose view data is `viewData`. Its editor holds `editorText`: Obsidian
   * does not update the hidden editor of a note in reading view.
   */
  function readingView(disk: string, viewData: string, editorText: string) {
    const { MarkdownView } = vi.mocked(obsidian);
    const file = new (TFile as unknown as new (path: string) => object)("note.md");
    const state = { disk, saves: 0 };
    const view = Object.assign(new (MarkdownView as unknown as new () => object)(), {
      file,
      data: viewData,
      getViewType: () => "markdown",
      getMode: () => "preview",
      getViewData: () => view.data,
      setViewData: (content: string) => {
        view.data = content;
      },
      save: () => {
        state.saves++;
        state.disk = view.data;
        return Promise.resolve();
      },
      editor: {
        getValue: () => editorText,
        transaction: () => {
          throw new Error("the hidden editor of a note in reading view was edited");
        },
        offsetToPos: (offset: number) => offset,
      },
    });
    const vault = {
      getAbstractFileByPath: (path: string) => (path === "note.md" ? file : null),
      process: (_file: unknown, change: (text: string) => string) => {
        state.disk = change(state.disk);
        return Promise.resolve(state.disk);
      },
      modifyBinary: (_file: unknown, data: ArrayBuffer) => {
        state.disk = new TextDecoder().decode(data);
        return Promise.resolve();
      },
      readBinary: () => Promise.resolve(toArrayBuffer(new TextEncoder().encode(state.disk))),
    };
    const workspace = {
      iterateAllLeaves: (callback: (leaf: { view: unknown }) => void) => {
        callback({ view });
      },
    };
    return { app: { vault, workspace } as unknown as App, state, view };
  }

  it("writes the remote change, though the hidden editor holds older text", async () => {
    const { app, state, view } = readingView("the synced text\n", "the synced text\n", "an older text\n");
    const adapter = new ObsidianVaultAdapter(app);

    await adapter.write("note.md", new TextEncoder().encode("the remote change\n"), { expectedHash: sha256Hex(new TextEncoder().encode("the synced text\n")) });

    expect(state.disk).toBe("the remote change\n");
    expect(view.data).toBe("the remote change\n");
    expect(state.saves).toBe(0);
  });

  it("keeps unsaved view data: saves it and writes nothing", async () => {
    const { app, state } = readingView("the synced text\n", "unsaved text\n", "unsaved text\n");
    const adapter = new ObsidianVaultAdapter(app);

    await expect(adapter.write("note.md", new TextEncoder().encode("the remote change\n"), { expectedHash: sha256Hex(new TextEncoder().encode("the synced text\n")) })).rejects.toBeInstanceOf(UnsavedEditsError);

    expect(state.disk).toBe("unsaved text\n");
    expect(state.saves).toBe(1);
  });
});

describe("ObsidianVaultAdapter replacing a file on the desktop disk", () => {
  /**
   * A desktop vault whose index holds `from` (`size` bytes) and, if
   * `targetSize` is given, `to`. The disk's rename leaves the index as
   * Obsidian's file watcher would once it saw the rename, but with `to` at
   * `sizeAfter` bytes: the user wrote to the file right after. With
   * `watcherSeesIt` false the index never learns of the rename.
   */
  function desktopVault(options: { size: number; targetSize?: number; sizeAfter: number; watcherSeesIt?: boolean }) {
    const { FileSystemAdapter } = vi.mocked(obsidian);
    const file = (path: string, size: number) => Object.assign(new (TFile as unknown as new (path: string) => object)(path), { stat: { size, mtime: 1_000 } });
    const indexed = new Map<string, unknown>([["note.md.vault-sync-tmp", file("note.md.vault-sync-tmp", options.size)]]);
    if (options.targetSize !== undefined) indexed.set("note.md", file("note.md", options.targetSize));
    const vault = {
      getAbstractFileByPath: (path: string) => indexed.get(path) ?? null,
      getFileByPath: (path: string) => {
        const found = indexed.get(path);
        return found instanceof TFile ? found : null;
      },
      readBinary: () => Promise.resolve(toArrayBuffer(bytes)),
      adapter: Object.assign(Object.create(FileSystemAdapter.prototype as object) as object, { getBasePath: () => "/vault" }),
    };
    const rename = () => {
      if (options.watcherSeesIt !== false) {
        indexed.delete("note.md.vault-sync-tmp");
        indexed.set("note.md", Object.assign(file("note.md", options.sizeAfter), { stat: { size: options.sizeAfter, mtime: 2_000 } }));
      }
      return Promise.resolve();
    };
    vi.stubGlobal("require", (id: string) => (id === "fs" ? { promises: { rename, rmdir: () => Promise.resolve() } } : undefined));
    return { vault } as unknown as App;
  }

  /** Starts the replace and reports how it stands: "pending", "resolved", or its error's message. */
  function replacing(app: App, expectedHash: string | null): () => string {
    const adapter = new ObsidianVaultAdapter(app);
    if (adapter.replace === undefined) throw new Error("no atomic replace on the desktop vault");
    let state = "pending";
    adapter.replace("note.md.vault-sync-tmp", "note.md", { expectedHash }).then(
      () => {
        state = "resolved";
      },
      (error: unknown) => {
        state = String(error);
      },
    );
    return () => state;
  }

  it("returns once the index shows a new file, though the user edited it right after", async () => {
    vi.useFakeTimers();
    try {
      const done = replacing(desktopVault({ size: 21, sizeAfter: 39 }), null);
      await vi.advanceTimersByTimeAsync(100);
      expect(done()).toBe("resolved");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("returns once the index shows a replaced file, though the user edited it right after", async () => {
    vi.useFakeTimers();
    try {
      const done = replacing(desktopVault({ size: 21, targetSize: 4, sizeAfter: 39 }), sha256Hex(bytes));
      await vi.advanceTimersByTimeAsync(100);
      expect(done()).toBe("resolved");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("stops waiting for the index after 5 s of elapsed time, however late its timers fire", async () => {
    vi.useFakeTimers();
    try {
      const done = replacing(desktopVault({ size: 21, sizeAfter: 21, watcherSeesIt: false }), null);
      // Every 10 ms poll takes 100 ms, as in a throttled background window.
      for (let poll = 0; poll < 55 && done() === "pending"; poll++) {
        vi.setSystemTime(Date.now() + 90);
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(done()).toBe("resolved");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
