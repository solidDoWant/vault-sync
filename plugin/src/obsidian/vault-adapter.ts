import { EditableFileView, MarkdownView, normalizePath, TextFileView, TFile, TFolder, type App, type EventRef, type TAbstractFile } from "obsidian";

import { VaultError, type FileStat, type VaultAdapter, type VaultEvent, type VaultListener } from "../core/vault/adapter";
import { mergeUnsaved } from "./text-merge";

/**
 * A remote write reached a file open in a view with unsaved state it could
 * not merge with: a Markdown editor whose unsaved edits overlap the remote
 * change, or another view (e.g. a canvas) with anything unsaved. The adapter
 * saved the view (so the state is on disk and the engine sees it as a local
 * change next time) and wrote nothing.
 */
export class UnsavedEditsError extends Error {
  override readonly name = "UnsavedEditsError";

  constructor(readonly path: string) {
    super(`${path} has unsaved edits that the incoming change cannot be merged with`);
  }
}

/** UTF-8 that keeps a byte order mark as U+FEFF, so text round-trips byte for byte. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Obsidian's views that only display a file and hold no unsaved state of their own. */
const readOnlyViewTypes = new Set(["image", "audio", "video", "pdf"]);

/** Editor transactions the adapter makes carry this origin. */
export const syncEditOrigin = "vault-sync";

/**
 * The engine's VaultAdapter (src/core/vault/adapter.ts) on Obsidian's Vault
 * API (SPEC.md §4, §8).
 *
 * - Files only, as the Vault indexes them. Paths with a hidden segment
 *   (".obsidian/", ".trash/", any ".name") are outside it: Obsidian does not
 *   index them and config sync is separate (#28), so they are never listed,
 *   read or reported, and writes or renames onto them are refused as
 *   "path-conflict". So are paths Obsidian would store under another name
 *   (normalizePath changes them).
 * - Renames use Vault.rename, not FileManager.renameFile: a synced rename
 *   must not rewrite links, since the other device's link updates arrive as
 *   revisions of their own.
 * - A write to a file open in a Markdown editor goes through Vault.process
 *   and an editor transaction, so the cursor, selection and unsaved
 *   keystrokes survive a non-overlapping remote change. A write to a file
 *   with unsaved state in any other view (e.g. a canvas) is refused after
 *   saving that view (see overwrite()).
 * - watch() reports nothing before the workspace layout is ready: while
 *   Obsidian loads a vault it fires "create" for every existing file, which
 *   is indexing, not a user edit. Changes made while Obsidian was not running
 *   are the engine's to find by content hash.
 */
export class ObsidianVaultAdapter implements VaultAdapter {
  constructor(private readonly app: App) {}

  private get vault() {
    return this.app.vault;
  }

  list(): Promise<string[]> {
    return Promise.resolve(this.vault.getFiles().map((file) => file.path).filter((path) => inScope(path)));
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.vault.readBinary(this.requireFile(path)));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    if (!inScope(path)) throw new VaultError("path-conflict", path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new VaultError("path-conflict", path);
    if (existing instanceof TFile) {
      await this.overwrite(existing, data);
      return;
    }
    await this.ensureParentFolders(path);
    try {
      await this.vault.createBinary(path, toArrayBuffer(data));
    } catch (error) {
      // E.g. a file differing only in letter case on a case-insensitive disk.
      if (await this.vault.adapter.exists(path)) throw new VaultError("path-conflict", path);
      throw error;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.requireFile(from);
    if (from === to) return;
    if (!inScope(to)) throw new VaultError("path-conflict", to);
    const target = this.vault.getAbstractFileByPath(to);
    if (target instanceof TFolder) throw new VaultError("path-conflict", to);
    if (target !== null && target !== file) throw new VaultError("already-exists", to);
    await this.ensureParentFolders(to);
    const caseOnly = from.toLowerCase() === to.toLowerCase();
    try {
      await this.vault.rename(file, to);
    } catch (error) {
      if (!caseOnly && (await this.vault.adapter.exists(to))) throw new VaultError("already-exists", to);
      throw error;
    }
  }

  async delete(path: string): Promise<void> {
    await this.vault.delete(this.requireFile(path));
  }

  stat(path: string): Promise<FileStat | null> {
    const file = this.fileAt(path);
    return Promise.resolve(file === null ? null : { size: file.stat.size, mtime: file.stat.mtime });
  }

  watch(listener: VaultListener): () => void {
    const deliver = (file: TAbstractFile, event: VaultEvent) => {
      if (!(file instanceof TFile) || !inScope(file.path) || !this.app.workspace.layoutReady) return;
      listener(event);
    };
    const references: EventRef[] = [
      this.vault.on("create", (file) => {
        deliver(file, { type: "create", path: file.path });
      }),
      this.vault.on("modify", (file) => {
        deliver(file, { type: "modify", path: file.path });
      }),
      this.vault.on("delete", (file) => {
        deliver(file, { type: "delete", path: file.path });
      }),
      this.vault.on("rename", (file, oldPath) => {
        deliver(file, { type: "rename", path: file.path, oldPath });
      }),
    ];
    return () => {
      for (const reference of references) this.vault.offref(reference);
    };
  }

  /**
   * Replaces a file's content without discarding what an open view has not
   * saved yet.
   *
   * - Not open, or open only in a read-only viewer (image, PDF, ...): written
   *   as is.
   * - Open in any other non-Markdown view (canvas, Bases, a plugin's view):
   *   Obsidian replaces such a view's state with the disk's on a change, so
   *   the write goes ahead only if every such view is a text file view whose
   *   data equals the disk (nothing unsaved), checked inside Vault.process.
   *   Otherwise the views are saved and the write rejects with
   *   UnsavedEditsError: the next pull finds the saved state as a local change.
   * - Open in a Markdown editor (UTF-8 content): a three-way merge inside
   *   Vault.process. The disk text is the base (the engine has checked it is
   *   the synced base), the editor buffer is the base plus any unsaved
   *   keystrokes, and `data` is the new content. Only the remote changes are
   *   applied to the editor, as one transaction, so CodeMirror maps the cursor
   *   and selection through them; the disk gets the same merged text. With no
   *   unsaved edits that is exactly `data`. With unsaved edits it is `data`
   *   plus those edits, which the engine then sees as the user's change it is.
   *   If the two overlap, the editor is saved instead and the write rejects
   *   with UnsavedEditsError, so neither side is overwritten.
   */
  private async overwrite(file: TFile, data: Uint8Array): Promise<void> {
    const views = this.openViews(file);
    const others = views.filter((view) => !(view instanceof MarkdownView) && !readOnlyViewTypes.has(view.getViewType()));
    if (others.length > 0) {
      await this.overwriteUnderOtherViews(file, data, others);
      return;
    }
    const view = views.find((candidate) => candidate instanceof MarkdownView);
    const text = view === undefined ? undefined : decodeText(data);
    if (view === undefined || text === undefined) {
      await this.vault.modifyBinary(file, toArrayBuffer(data));
      return;
    }
    const outcome = { overlapping: false };
    await this.vault.process(file, (disk) => {
      const { editor } = view;
      const local = editor.getValue();
      const merge = disk.includes("\r") || text.includes("\r") ? wholeText(disk, local, text) : mergeUnsaved(disk, local, text);
      if (merge === null) {
        outcome.overlapping = true;
        return disk;
      }
      if (merge.changes.length > 0) {
        editor.transaction(
          { changes: merge.changes.map((change) => ({ from: editor.offsetToPos(change.from), to: editor.offsetToPos(change.to), text: change.insert })) },
          syncEditOrigin,
        );
      }
      return merge.merged;
    });
    if (outcome.overlapping) {
      await view.save();
      throw new UnsavedEditsError(file.path);
    }
  }

  /** The overwrite() case of a file open in non-Markdown views that may hold unsaved state. */
  private async overwriteUnderOtherViews(file: TFile, data: Uint8Array, views: EditableFileView[]): Promise<void> {
    const text = decodeText(data);
    const textViews = views.filter((view) => view instanceof TextFileView);
    const outcome = { written: false };
    if (text !== undefined && textViews.length === views.length) {
      await this.vault.process(file, (disk) => {
        if (!textViews.every((view) => view.getViewData() === disk)) return disk;
        outcome.written = true;
        return text;
      });
    }
    if (outcome.written) return;
    for (const view of textViews) await view.save();
    throw new UnsavedEditsError(file.path);
  }

  /** The loaded views editing `file` (not sidebar views such as backlinks or outline, which only follow it). */
  private openViews(file: TFile): EditableFileView[] {
    const views: EditableFileView[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const { view } = leaf;
      if (view instanceof EditableFileView && view.file === file) views.push(view);
    });
    return views;
  }

  /** Creates the missing ancestor folders of `path`; "path-conflict" if one of them is a file. */
  private async ensureParentFolders(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index++) {
      const folder = segments.slice(0, index).join("/");
      const existing = this.vault.getAbstractFileByPath(folder);
      if (existing instanceof TFile) throw new VaultError("path-conflict", path);
      if (existing === null) await this.vault.createFolder(folder);
    }
  }

  private fileAt(path: string): TFile | null {
    if (!inScope(path)) return null;
    return this.vault.getFileByPath(path);
  }

  private requireFile(path: string): TFile {
    const file = this.fileAt(path);
    if (file === null) throw new VaultError("not-found", path);
    return file;
  }
}

/** Whether `path` is a non-hidden path that Obsidian stores under exactly this name. */
function inScope(path: string): boolean {
  if (path === "" || normalizePath(path) !== path) return false;
  return !path.split("/").some((segment) => segment.startsWith("."));
}

function decodeText(data: Uint8Array): string | undefined {
  try {
    return utf8.decode(data);
  } catch {
    return undefined;
  }
}

/**
 * The CRLF fallback: CodeMirror's buffer may not keep "\r", so no line merge
 * is attempted. With nothing unsaved the editor takes the whole new text;
 * otherwise it is treated as overlapping.
 */
function wholeText(disk: string, local: string, text: string) {
  if (local !== disk && local !== disk.replaceAll("\r\n", "\n")) return null;
  return { merged: text, changes: local === text ? [] : [{ from: 0, to: local.length, insert: text }] };
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return new Uint8Array(data).buffer;
}
