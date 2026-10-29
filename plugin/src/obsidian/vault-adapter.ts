import { EditableFileView, FileSystemAdapter, MarkdownView, normalizePath, TextFileView, TFile, TFolder, type App, type EventRef, type TAbstractFile } from "obsidian";

import { sha256Hex } from "../core/hash";
import { VaultError, type DeletePrecondition, type FileStat, type VaultAdapter, type VaultEvent, type VaultListener, type WritePrecondition } from "../core/vault/adapter";
import { mergeUnsaved } from "../core/merge/text-merge";
import { mergeCanvas } from "./canvas-merge";
import { isFileNotCreatedError, isNotFoundOsError, isUnmaterializableOsError } from "./platform-rules";
import { UnsavedEditsError } from "./unsaved-edits";

export { UnsavedEditsError } from "./unsaved-edits";

/** UTF-8 that keeps a byte order mark as U+FEFF, so text round-trips byte for byte. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** The types of Obsidian's views that only display a file and hold no unsaved state of their own. */
const readOnlyViewTypes = new Set(["image", "audio", "video", "pdf"]);

/**
 * Whether `view` is one of Obsidian's read-only viewers. The type alone does
 * not say so: a plugin may register its own view under one of these types
 * (#418), and a text view, whatever its type, holds data it may not have
 * saved.
 */
function isReadOnlyViewer(view: EditableFileView): boolean {
  return readOnlyViewTypes.has(view.getViewType()) && !(view instanceof TextFileView);
}

/** Editor transactions the adapter makes carry this origin. */
export const syncEditOrigin = "vault-sync";

/**
 * The engine's VaultAdapter (src/core/vault/adapter.ts) on Obsidian's Vault
 * API (SPEC.md §4, §8).
 *
 * - Files and folders, as the Vault indexes them. Paths with a hidden segment
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
 *   keystrokes survive a non-overlapping remote change. So do a canvas's
 *   unsaved changes, merged node by node. A write to a file with unsaved
 *   state in any other view is refused after saving that view (see
 *   overwrite()).
 * - An OS error saying the platform cannot hold a name (too long, an invalid
 *   character the path rules did not catch) rejects a create or rename with
 *   "unmaterializable", so the engine tracks the document. On Windows that
 *   error is ENOENT, on Android Capacitor's FILE_NOTCREATED; either is taken
 *   as a refused name when the parent folder (and a rename's source) exists.
 * - Write and delete preconditions (the engine's expected content hash) are
 *   checked inside the same Vault.process call that writes, wherever the new
 *   content is text and the file's is too. On desktop, Vault.process runs in
 *   the file adapter's queue, which Obsidian's own saves (an editor's
 *   autosave) go through as well, so nothing saved after the check is
 *   overwritten. Three windows of one read remain (SPEC.md §8): binary
 *   content has no such route and is checked by reading the file just
 *   before modifyBinary; a delete is checked by reading the file just before
 *   Vault.delete (and refused while an open text view shows anything else);
 *   and on mobile, Obsidian's Capacitor adapter does not queue a plain write
 *   with process.
 * - watch() reports nothing before the workspace layout is ready: while
 *   Obsidian loads a vault it fires "create" for every existing file, which
 *   is indexing, not a user edit. Changes made while Obsidian was not running
 *   are the engine's to find by content hash.
 */
export class ObsidianVaultAdapter implements VaultAdapter {
  /** The file system's atomic rename over a file, on desktop only (docs/design/engine.md §8). */
  readonly replace?: (from: string, to: string, precondition: WritePrecondition) => Promise<void>;

  /** The desktop file system, where there is one. */
  private readonly disk: DesktopDisk | undefined;

  constructor(private readonly app: App) {
    const disk = desktopDisk(app);
    this.disk = disk;
    if (disk !== undefined) this.replace = (from, to, precondition) => this.replaceOnDisk(disk, from, to, precondition);
  }

  /** Whether `path` is open in a view that may hold unsaved state: anything but a read-only viewer. */
  isOpenInEditor(path: string): boolean {
    const file = this.fileAt(path);
    return file !== null && this.openViews(file).some((view) => !isReadOnlyViewer(view));
  }

  /**
   * Moves `from` over `to` with the file system's rename, which replaces the
   * target atomically, and waits until Obsidian's index shows the result.
   * The precondition is checked by reading the target just before the
   * rename, a window of one read as for binary writes (SPEC.md §8).
   */
  private async replaceOnDisk(disk: DesktopDisk, from: string, to: string, precondition: WritePrecondition): Promise<void> {
    const file = this.requireFile(from);
    if (!inScope(to)) throw new VaultError("path-conflict", to);
    const target = this.vault.getAbstractFileByPath(to);
    if (target instanceof TFolder) throw new VaultError("path-conflict", to);
    if (precondition.expectedHash === null ? target !== null : !(target instanceof TFile) || sha256Hex(new Uint8Array(await this.vault.readBinary(target))) !== precondition.expectedHash) {
      throw new VaultError("changed", to);
    }
    if (target === null) await this.ensureParentFolders(to);
    const size = file.stat.size;
    const before = target instanceof TFile ? { size: target.stat.size, mtime: target.stat.mtime } : undefined;
    try {
      await disk.rename(`${disk.base}/${from}`, `${disk.base}/${to}`);
    } catch (error) {
      throw await this.unmaterializableOr(error, to, to, from);
    }
    // Obsidian learns of the rename from its file watcher. Its index has it
    // once `from` is gone and `to` is no longer the file it replaced: the
    // replacement, or what the user wrote over it since, so an edit right
    // after the replace does not keep the sync waiting.
    await waitForIndex(() => {
      const moved = this.vault.getFileByPath(to);
      if (this.vault.getFileByPath(from) !== null || moved === null) return false;
      return before === undefined || moved.stat.size === size || moved.stat.size !== before.size || moved.stat.mtime !== before.mtime;
    });
  }

  private get vault() {
    return this.app.vault;
  }

  list(): Promise<string[]> {
    return Promise.resolve(this.vault.getFiles().map((file) => file.path).filter((path) => inScope(path)));
  }

  listFolders(): Promise<string[]> {
    return Promise.resolve(
      this.vault
        .getAllLoadedFiles()
        .filter((entry) => entry instanceof TFolder && !entry.isRoot())
        .map((folder) => folder.path)
        .filter((path) => inScope(path)),
    );
  }

  async createFolder(path: string): Promise<void> {
    if (!inScope(path)) throw new VaultError("path-conflict", path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    if (existing !== null) throw new VaultError("path-conflict", path);
    await this.ensureParentFolders(path);
    try {
      await this.vault.createFolder(path);
    } catch (error) {
      // Created meanwhile, e.g. by Obsidian as a new file's parent.
      if (this.vault.getFolderByPath(path) !== null) return;
      if (await this.vault.adapter.exists(path)) throw new VaultError("path-conflict", path);
      throw await this.unmaterializableOr(error, path, path);
    }
  }

  async deleteFolder(path: string): Promise<void> {
    const folder = inScope(path) ? this.vault.getFolderByPath(path) : null;
    if (folder === null || folder.isRoot()) throw new VaultError("not-found", path);
    // Hidden entries Obsidian does not index (".name") count too: the folder must be empty on disk.
    const listed = await this.vault.adapter.list(path);
    if (folder.children.length > 0 || listed.files.length > 0 || listed.folders.length > 0) throw new VaultError("changed", path);
    const disk = this.disk;
    if (disk === undefined) {
      // Mobile: Obsidian's own delete, a moment after the check. Only Obsidian writes to its vault there.
      await this.vault.delete(folder, true);
      return;
    }
    // Desktop: the file system's rmdir, which refuses a folder that is not
    // empty in the same step, so nothing created after the check is lost.
    // Vault.delete of a folder without `force` fails there (EISDIR in 1.14.4),
    // and with it removes whatever is in the folder.
    try {
      await disk.rmdir(`${disk.base}/${path}`);
    } catch (error) {
      if (isNotEmptyOsError(error)) throw new VaultError("changed", path);
      throw error;
    }
    // Obsidian learns of the delete from its file watcher.
    await waitForIndex(() => this.vault.getFolderByPath(path) === null);
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.vault.readBinary(this.requireFile(path)));
  }

  async write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    if (!inScope(path)) throw new VaultError("path-conflict", path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new VaultError("path-conflict", path);
    const expectedHash = precondition?.expectedHash;
    if (existing instanceof TFile) {
      if (expectedHash === null) throw new VaultError("changed", path);
      await this.overwrite(existing, data, expectedHash);
      return;
    }
    if (typeof expectedHash === "string") throw new VaultError("changed", path);
    await this.ensureParentFolders(path);
    try {
      await this.vault.createBinary(path, toArrayBuffer(data));
    } catch (error) {
      // A file created at this very path meanwhile; with no precondition, as before.
      if (expectedHash === null && this.vault.getFileByPath(path) !== null) throw new VaultError("changed", path);
      // E.g. a file differing only in letter case on a case-insensitive disk.
      if (await this.vault.adapter.exists(path)) throw new VaultError("path-conflict", path);
      throw await this.unmaterializableOr(error, path, path);
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
      throw await this.unmaterializableOr(error, to, to, from);
    }
  }

  /**
   * Never discards what an open view has not saved (#181). The file is read
   * and deleted only if it still holds the precondition's content (if there
   * is one) and no open text view (a Markdown editor, a canvas) shows
   * anything else. Unsaved state (keystrokes within Obsidian's save debounce)
   * is saved instead, and the delete rejects, deleting nothing: with
   * "changed" under a precondition, so the engine finds the saved text as a
   * local edit, and with UnsavedEditsError without one, as write() does.
   */
  async delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    const file = this.requireFile(path);
    if (precondition !== undefined || this.openViews(file).length > 0) {
      const current = new Uint8Array(await this.vault.readBinary(file));
      if (precondition !== undefined && sha256Hex(current) !== precondition.expectedHash) throw new VaultError("changed", path);
      const text = decodeText(current);
      // The views open now, after the read: one opened meanwhile counts too.
      const views = this.openViews(file).filter((view) => view instanceof TextFileView);
      const unsaved = text === undefined ? [] : views.filter((view) => !sameText(view.getViewData(), text));
      if (unsaved.length > 0) {
        for (const view of unsaved) await view.save();
        throw precondition === undefined ? new UnsavedEditsError(path) : new VaultError("changed", path);
      }
    }
    await this.vault.delete(file);
  }

  stat(path: string): Promise<FileStat | null> {
    const file = this.fileAt(path);
    return Promise.resolve(file === null ? null : { size: file.stat.size, mtime: file.stat.mtime });
  }

  watch(listener: VaultListener): () => void {
    const deliver = (file: TAbstractFile, event: VaultEvent, folderEvent?: VaultEvent) => {
      if (!inScope(file.path) || !this.app.workspace.layoutReady) return;
      if (file instanceof TFile) listener(event);
      else if (file instanceof TFolder && folderEvent !== undefined) listener(folderEvent);
    };
    const references: EventRef[] = [
      this.vault.on("create", (file) => {
        deliver(file, { type: "create", path: file.path }, { type: "folder-create", path: file.path });
      }),
      this.vault.on("modify", (file) => {
        deliver(file, { type: "modify", path: file.path });
      }),
      this.vault.on("delete", (file) => {
        deliver(file, { type: "delete", path: file.path }, { type: "folder-delete", path: file.path });
      }),
      this.vault.on("rename", (file, oldPath) => {
        deliver(file, { type: "rename", path: file.path, oldPath }, { type: "folder-rename", path: file.path, oldPath });
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
   *   data equals the disk (nothing unsaved), or one canvas view has unsaved
   *   changes that merge with the new content node by node (mergeCanvas),
   *   checked inside Vault.process. The views are given the written content
   *   there, as saved, so Obsidian's reload after the write cannot replace an
   *   edit made right after it. Otherwise the views are saved and the write
   *   rejects with UnsavedEditsError: the next pull finds the saved state as
   *   a local change.
   * - Open in Markdown views all in reading view (UTF-8 content): as a text
   *   file view above. Their editors are hidden and may hold older text,
   *   which is not an unsaved edit.
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
   *
   * With `expectedHash`, every route first checks that the disk still holds
   * it, inside Vault.process where there is one, and rejects with "changed",
   * writing nothing, if not.
   */
  private async overwrite(file: TFile, data: Uint8Array, expectedHash: string | undefined): Promise<void> {
    const views = this.openViews(file);
    const others = views.filter((view) => !(view instanceof MarkdownView) && !isReadOnlyViewer(view));
    if (others.length > 0) {
      await this.overwriteUnderOtherViews(file, data, others, expectedHash);
      return;
    }
    const markdown = views.filter((candidate) => candidate instanceof MarkdownView);
    const view = markdown.find((candidate) => candidate.getMode() === "source");
    const text = markdown.length === 0 ? undefined : decodeText(data);
    if (text === undefined) {
      await this.replaceContent(file, data, expectedHash);
      return;
    }
    // In reading view the user cannot type, and Obsidian leaves the hidden
    // editor's buffer as it was: what such a view holds is its view data.
    if (view === undefined) {
      await this.overwriteUnderOtherViews(file, data, markdown, expectedHash);
      return;
    }
    const outcome = { overlapping: false, changed: false };
    await this.vault.process(file, (disk) => {
      if (!holds(disk, expectedHash)) {
        outcome.changed = true;
        return disk;
      }
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
    if (outcome.changed) throw new VaultError("changed", file.path);
    if (outcome.overlapping) {
      await view.save();
      throw new UnsavedEditsError(file.path);
    }
  }

  /** The overwrite() case of a file open in no editing view: written as is. */
  private async replaceContent(file: TFile, data: Uint8Array, expectedHash: string | undefined): Promise<void> {
    if (expectedHash === undefined) {
      await this.vault.modifyBinary(file, toArrayBuffer(data));
      return;
    }
    const current = new Uint8Array(await this.vault.readBinary(file));
    const text = decodeText(data);
    // Vault.process reads the file as text, so it is only for text replacing text.
    if (text === undefined || decodeText(current) === undefined) {
      if (sha256Hex(current) !== expectedHash) throw new VaultError("changed", file.path);
      await this.vault.modifyBinary(file, toArrayBuffer(data));
      return;
    }
    const outcome = { changed: false };
    await this.vault.process(file, (disk) => {
      if (holds(disk, expectedHash)) return text;
      outcome.changed = true;
      return disk;
    });
    if (outcome.changed) throw new VaultError("changed", file.path);
  }

  /** The overwrite() case of a file open in non-Markdown views that may hold unsaved state. */
  private async overwriteUnderOtherViews(file: TFile, data: Uint8Array, views: EditableFileView[], expectedHash: string | undefined): Promise<void> {
    const text = decodeText(data);
    const textViews = views.filter((view) => view instanceof TextFileView);
    const outcome = { written: false, changed: false };
    if (text !== undefined && textViews.length === views.length) {
      await this.vault.process(file, (disk) => {
        if (!holds(disk, expectedHash)) {
          outcome.changed = true;
          return disk;
        }
        const unsaved = textViews.filter((view) => view.getViewData() !== disk);
        // A canvas's unsaved changes are merged with the new content node by
        // node; any other view's, or a second view's, refuse the write.
        const [only] = unsaved;
        const content = only === undefined ? text : unsaved.length === 1 && only.getViewType() === "canvas" ? mergeCanvas(disk, only.getViewData(), text) : null;
        if (content === null) return disk;
        // The views show the new content now, inside the file's queue, and
        // take it as saved: Obsidian's reload on the modify event that
        // follows then finds nothing new, instead of replacing an edit made
        // in between with the disk's (TextFileView.onModify in 1.14.4).
        for (const view of textViews) showSaved(view, content);
        outcome.written = true;
        return content;
      });
    }
    if (outcome.written) return;
    if (outcome.changed) throw new VaultError("changed", file.path);
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
      if (existing !== null) continue;
      try {
        await this.vault.createFolder(folder);
      } catch (error) {
        throw await this.unmaterializableOr(error, path, folder);
      }
    }
  }

  /**
   * VaultError "unmaterializable" (naming `path`) for an OS error saying the
   * platform cannot hold `created`, a name the path rules missed, so the
   * engine tracks the document instead of failing the pull; any other error
   * as it is. ENOENT and Android's FILE_NOTCREATED count when `created`'s
   * parent folder and `source` (a rename's) exist: Windows reports a name it
   * refuses as ENOENT (see isNotFoundOsError), Android as FILE_NOTCREATED
   * (see isFileNotCreatedError).
   */
  private async unmaterializableOr(error: unknown, path: string, created: string, source?: string): Promise<unknown> {
    if (isUnmaterializableOsError(error)) return new VaultError("unmaterializable", path);
    if (!isNotFoundOsError(error) && !isFileNotCreatedError(error)) return error;
    const parent = created.includes("/") ? created.slice(0, created.lastIndexOf("/")) : "";
    if (parent !== "" && !(await this.vault.adapter.exists(parent))) return error;
    if (source !== undefined && !(await this.vault.adapter.exists(source))) return error;
    return new VaultError("unmaterializable", path);
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

/** How long replaceOnDisk waits for Obsidian's index to show a rename, and how often it looks. */
const indexWaitMs = 5_000;
const indexPollMs = 10;

/**
 * Waits until `updated` holds or indexWaitMs have passed, whichever comes
 * first. The bound is elapsed time, not a count of polls: in a background
 * window the platform may fire timers far later than asked.
 */
async function waitForIndex(updated: () => boolean): Promise<void> {
  const deadline = Date.now() + indexWaitMs;
  while (!updated() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, indexPollMs));
}

/** The desktop file system under the vault: its folder and Node's rename. */
interface DesktopDisk {
  base: string;
  rename(from: string, to: string): Promise<void>;
  /** Removes an empty folder; rejects with ENOTEMPTY (EEXIST on some systems) if it is not empty. */
  rmdir(path: string): Promise<void>;
}

/**
 * The vault's file system on desktop, where Obsidian runs on Node: its
 * FileSystemAdapter and `fs`. Undefined on mobile, which has neither. `fs`
 * is looked up at runtime, so the mobile bundle never imports it.
 */
function desktopDisk(app: App): DesktopDisk | undefined {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return undefined;
  const load = (globalThis as { require?: (id: string) => unknown }).require;
  const fs = typeof load === "function" ? (load("fs") as { promises?: { rename?: (from: string, to: string) => Promise<void>; rmdir?: (path: string) => Promise<void> } } | undefined) : undefined;
  const rename = fs?.promises?.rename;
  const rmdir = fs?.promises?.rmdir;
  if (rename === undefined || rmdir === undefined) return undefined;
  return { base: adapter.getBasePath(), rename: (from, to) => rename(from, to), rmdir: (path) => rmdir(path) };
}

/** Whether `error` is the OS refusing to remove a folder that is not empty. */
function isNotEmptyOsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOTEMPTY" || code === "EEXIST";
}

/** Whether `path` is a non-hidden path that Obsidian stores under exactly this name. */
function inScope(path: string): boolean {
  if (path === "" || normalizePath(path) !== path) return false;
  return !path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Whether the disk text Vault.process read is the content with `expectedHash`
 * (undefined: no precondition). A byte order mark the read dropped is allowed
 * for.
 */
function holds(disk: string, expectedHash: string | undefined): boolean {
  if (expectedHash === undefined) return true;
  return sha256Hex(encoder.encode(disk)) === expectedHash || (!disk.startsWith("\ufeff") && sha256Hex(encoder.encode(`\ufeff${disk}`)) === expectedHash);
}

/** Whether a view's data shows `disk`; a Markdown editor's buffer may have dropped the "\r" of CRLF line endings. */
function sameText(viewData: string, disk: string): boolean {
  return viewData === disk || viewData === disk.replaceAll("\r\n", "\n");
}

/**
 * Shows `content` in a text view as its saved state: its data and, where
 * Obsidian keeps it (the undocumented `lastSavedData` of TextFileView in
 * 1.14.4), what it last saved or loaded, which TextFileView.onModify compares
 * the disk against before it reloads.
 */
function showSaved(view: TextFileView, content: string): void {
  if (view.getViewData() !== content) view.setViewData(content, false);
  view.data = content;
  const internal = view as unknown as { lastSavedData?: unknown };
  if ("lastSavedData" in internal) internal.lastSavedData = content;
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
