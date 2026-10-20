import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { VaultError } from "../core/vault/adapter";

// The adapter's runtime imports from Obsidian, reduced to what create and
// rename touch: the file classes the adapter checks with instanceof, and
// normalizePath (here: every path is already normal).
vi.mock("obsidian", () => {
  class TAbstractFile {
    constructor(readonly path: string) {}
  }
  class View {}
  class EditableFileView extends View {}
  class TextFileView extends EditableFileView {}
  class MarkdownView extends TextFileView {}
  return { TAbstractFile, TFile: class extends TAbstractFile {}, TFolder: class extends TAbstractFile {}, EditableFileView, TextFileView, MarkdownView, normalizePath: (path: string) => path };
});

const { TFile, TFolder } = await import("obsidian");
const { ObsidianVaultAdapter } = await import("./vault-adapter");

/** The error Node's fs gives for a missing path, which Windows also gives for a name it refuses. */
function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
}

/**
 * A vault whose index holds `files` and `folders` and whose disk holds the
 * paths in `onDisk`, where creating or renaming a file fails with ENOENT.
 */
function fakeApp(options: { files?: string[]; folders?: string[]; onDisk: string[] }): App {
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
    createBinary: (path: string) => Promise.reject(enoent(path)),
    rename: (_file: unknown, path: string) => Promise.reject(enoent(path)),
    adapter: { exists: (path: string) => Promise.resolve(options.onDisk.includes(path)) },
  };
  return { vault } as unknown as App;
}

const bytes = new TextEncoder().encode("text");

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
