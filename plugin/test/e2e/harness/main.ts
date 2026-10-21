import { FileSystemAdapter, FileView, MarkdownView, normalizePath, Plugin, TextFileView, TFile, TFolder, type App } from "obsidian";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind } from "../../../src/gen/vaultsync/v1/types_pb";
import type { ConfigSyncSettings } from "../../../src/core/config/policy";
import type { HistoryEntry } from "../../../src/core/engine/history";
import { InMemoryServer } from "../../../src/core/engine/memory-server";
import { sha256Hex } from "../../../src/core/hash";
import { journalConformance, runJournalConformanceCase } from "../../../src/core/journal/conformance";
import { IndexedDbJournal } from "../../../src/core/journal/indexeddb";
import { createProtocolClient } from "../../../src/core/protocol/client";
import { uuidv7 } from "../../../src/core/uuid";
import { VaultError, type FileStat, type VaultEvent } from "../../../src/core/vault/adapter";
import { isVaultRelativePath } from "../../../src/core/vaultpath/vaultpath";
import { runConformanceCase, vaultAdapterConformance, type VaultAdapterFactory } from "../../../src/core/vault/conformance";
import type VaultSyncPlugin from "../../../src/main";
import { configFolderHost, ObsidianConfigAdapter } from "../../../src/obsidian/config-adapter";
import { HistoryModal } from "../../../src/obsidian/history-modal";
import { journalDatabaseName, localVaultId, openVaultJournal, type JournalKey } from "../../../src/obsidian/journal";
import type { SyncSession, VaultHistory } from "../../../src/obsidian/session";
import { ObsidianVaultAdapter } from "../../../src/obsidian/vault-adapter";

/** What the e2e specs get back from a case run inside Obsidian. */
export type CaseResult = { ok: true } | { ok: false; error: string };

/** The editor state after an editor-safe write (editor.e2e.ts). */
export interface EditorWriteResult {
  /** The write's outcome: "ok" or the error's name and message. */
  outcome: string;
  /** The text on disk before the write: the base the engine would have checked. */
  diskBefore: string;
  editor: string;
  cursor: { line: number; ch: number };
  disk: string;
}

/**
 * How a harness write imitates the engine's (editor.e2e.ts): `save` saves the
 * view after the change, as Obsidian's autosave may after the engine checked
 * the disk; `expectBase` makes the write name the content the disk had before
 * the change, as the engine does (#163).
 */
export interface RemoteWriteOptions {
  save?: boolean;
  expectBase?: boolean;
}

/** RemoteWriteOptions for a canvas; `awaitReload` also waits for Obsidian's reload of the view after the write and reports the view after it. */
export interface CanvasWriteOptions extends RemoteWriteOptions {
  awaitReload?: boolean;
}

/**
 * Records the reloads of `view` (TextFileView.loadFileInternal, internal to
 * Obsidian 1.14.4) until restore(). settled() waits for the first reload to
 * start (Obsidian starts it on the modify event once a write has landed),
 * throwing if none does within 5 s, then for every recorded one to finish.
 */
function trackReloads(view: TextFileView): { reloads: Promise<void>[]; settled(): Promise<void>; restore(): void } {
  const internal = view as unknown as { loadFileInternal: (this: unknown, file: TFile, clear: boolean) => Promise<void> };
  const reloads: Promise<void>[] = [];
  const original = internal.loadFileInternal;
  internal.loadFileInternal = function (this: unknown, ...args: [TFile, boolean]) {
    const reload = original.apply(this, args);
    reloads.push(reload);
    return reload;
  };
  return {
    reloads,
    async settled() {
      for (let attempt = 0; reloads.length === 0 && attempt < 200; attempt++) await new Promise((resolve) => window.setTimeout(resolve, 25));
      if (reloads.length === 0) throw new Error("Obsidian did not reload the view after the write");
      await Promise.all(reloads);
    },
    restore() {
      internal.loadFileInternal = original;
    },
  };
}

/**
 * Holds Obsidian's autosave of `view` until `release`: TextFileView.requestSave
 * (a 2 s debounce of save(), called on every edit) only counts the request
 * meanwhile. Unsaved state the harness makes then stays unsaved however long
 * the steps after it take on a loaded runner (#600), instead of only until
 * the debounce fires. An explicit save() (the adapter's, or a spec's) is not
 * held. `release` restores the debounce and, if a save was requested
 * meanwhile, requests it again, so Obsidian still saves what is unsaved.
 */
function holdAutosave(view: TextFileView): { requests(): number; release(): void } {
  const own = Object.prototype.hasOwnProperty.call(view, "requestSave");
  const original = view.requestSave;
  let requests = 0;
  view.requestSave = () => {
    requests++;
  };
  return {
    requests: () => requests,
    release() {
      if (own) view.requestSave = original;
      else delete (view as Partial<TextFileView>).requestSave;
      if (requests > 0) view.requestSave();
    },
  };
}

/** The editor and disk after a remote delete of an open note (editor.e2e.ts). */
export interface EditorDeleteResult {
  outcome: string;
  editor: string;
  /** The text on disk afterwards, or null if the file is gone. */
  disk: string | null;
}

/** The editor and the vault after a sync that ran while the editor held unsaved keystrokes (unsaved.e2e.ts). */
export interface TypedSyncResult {
  /** The sync's outcome: "ok" or the error's name and message. */
  outcome: string;
  /** The note on disk right after the typing, before the sync: without the keystrokes, which were unsaved. */
  diskBefore: string;
  editor: string;
  /** Every file in the vault afterwards, by path. */
  files: Record<string, string>;
}

/** A canvas view's state after a remote write to its file (editor.e2e.ts). */
export interface ViewWriteResult {
  outcome: string;
  diskBefore: string;
  /** The view's own serialization of what it shows. */
  view: string;
  disk: string;
}

/** Where the file is open while the adapter writes it (atomicity.e2e.ts). */
export type OpenIn = "nothing" | "markdown" | "canvas";

/** A sync write with an editor's write of the same file landing during it (atomicity.e2e.ts). */
export interface ConcurrentWriteResult {
  /** The sync write's outcome: "ok" or the error's name and message. */
  outcome: string;
  /** Whether the adapter read the file at least `read` times, so the editor's write was made. */
  interleaved: boolean;
  /** The editor's write's outcome. */
  editorOutcome: string;
  /** Every content written to the file, in order, from the sync write's start until both writes had settled. */
  writes: string[];
  /** The file on disk afterwards. */
  disk: string;
}

/** The parts of Obsidian 1.14.4's desktop FileSystemAdapter (not in its typings) that every read and write of a file goes through. */
interface FileSystemInternals {
  fsPromises: { readFile(path: string, ...rest: unknown[]): Promise<unknown>; writeFile(path: string, data: unknown, ...rest: unknown[]): Promise<void> };
  getFullPath(path: string): string;
}

/** What Obsidian and the adapter make of one path (paths.e2e.ts). */
export interface PathScopeResult {
  /** normalizePath's result. */
  normalized: string;
  /** Whether isVaultRelativePath accepts the path, and its normalized form. */
  accepted: boolean;
  normalizedAccepted: boolean;
  /** Each call's outcome: "ok", a VaultError code, or the error. */
  write: string;
  rename: string;
  read: string;
  stat: FileStat | null;
  /** The adapter's files afterwards, and inside.md's content. */
  listed: string[];
  inside: string;
}

/** What the config folder adapter makes of one path (paths.e2e.ts). */
export interface ConfigPathScopeResult {
  /** Each call's outcome: "ok", a VaultError code, or the error. */
  write: string;
  rename: string;
  /** Every file on disk afterwards in the test folder, and a stray evil.json in the config folder, sorted. */
  files: string[];
}

/** What one sync session start saw (lifecycle.e2e.ts). bigints as strings, to cross executeObsidian. */
export interface SessionStart {
  cursor: string | null;
  applied: number;
  /** `since_seq` of every ListChanges call since the previous start. */
  listChangesSince: string[];
}

// Obsidian's plugin registry is not in its public typings.
interface PluginRegistry {
  plugins: { plugins: Record<string, unknown> };
}

/** What interceptRemoveDevice records and does to the next RemoveDevice call. */
interface RemoveDeviceIntercept {
  calls: { deviceId: string; forwarded: boolean }[];
  next: "pass" | "fail" | "hold";
  /** Ends the held call: fails it when given true, sends it otherwise. */
  release: ((fail: boolean) => void) | undefined;
  /** vault-sync's ListDevices calls since then (#634): how many, and the next one held until released. */
  listDevices: { calls: number; next: "pass" | "hold"; release: (() => void) | undefined };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Deletes everything in the vault that Obsidian indexes (hidden config stays). */
async function emptyVault(app: App): Promise<void> {
  for (const child of [...app.vault.getRoot().children]) await app.vault.delete(child, true);
}

/**
 * Test-only plugin, installed next to vault-sync by the e2e suite
 * (wdio.conf.mts bundles it). The specs reach it through
 * `browser.executeObsidian` to run code inside Obsidian's renderer that a
 * stringified function cannot carry, such as the VaultAdapter conformance
 * suite. Never shipped.
 */
/** A plugin's text view, registered under a core viewer's type by writeRemoteUnderPluginImageView. */
class PluginTextView extends TextFileView {
  getViewType(): string {
    return "image";
  }

  override getDisplayText(): string {
    return "Plugin text view";
  }

  getViewData(): string {
    return this.data;
  }

  setViewData(data: string): void {
    this.data = data;
  }

  clear(): void {
    this.data = "";
  }
}

export default class VaultSyncE2EHarness extends Plugin {
  /** The adapter the conformance spec runs inside Obsidian, over the emptied open vault. */
  readonly adapterUnderTest: VaultAdapterFactory = async () => {
    await emptyVault(this.app);
    return {
      adapter: new ObsidianVaultAdapter(this.app),
      // As the file explorer does: Obsidian moves the folder and everything in it.
      renameFolder: async (from, to) => {
        const folder = this.app.vault.getAbstractFileByPath(from);
        if (!(folder instanceof TFolder)) throw new Error(`no folder ${from}`);
        await this.app.vault.rename(folder, to);
      },
      dispose: () => emptyVault(this.app),
    };
  };

  /** Events an Obsidian adapter watched from onload on, i.e. through Obsidian's startup indexing. */
  private readonly sinceLoad: VaultEvent[] = [];

  private session: { server: InMemoryServer; journalKey: JournalKey; journal: IndexedDbJournal | undefined; listChangesSince: string[]; localChanges: VaultEvent[][] } | undefined;

  /** Paths (relative to the config folder) a config folder adapter watched from onload on reported, in order. */
  private readonly configSinceLoad: string[] = [];

  override onload(): void {
    // Registered as early as a plugin can: Obsidian may still be indexing.
    const stop = new ObsidianVaultAdapter(this.app).watch((event) => this.sinceLoad.push(event));
    this.register(stop);
    // Obsidian saves community-plugins.json again once it has loaded every enabled plugin, this one included (config.e2e.ts).
    this.register(new ObsidianConfigAdapter(configFolderHost(this.app, normalizePath)).watch((event) => this.configSinceLoad.push(event.path)));
  }

  /** The config files (relative to the config folder) Obsidian wrote since this plugin loaded. */
  configWritesSinceLoad(): string[] {
    return [...new Set(this.configSinceLoad)];
  }

  /** The conformance case names, in suite order. */
  conformanceCaseNames(): string[] {
    return vaultAdapterConformance.map((testCase) => testCase.name);
  }

  /** Runs one conformance case against a fresh adapter from adapterUnderTest. */
  async runConformanceCase(name: string): Promise<CaseResult> {
    const testCase = vaultAdapterConformance.find((candidate) => candidate.name === name);
    if (testCase === undefined) return { ok: false, error: `no conformance case named ${JSON.stringify(name)}` };
    try {
      await runConformanceCase(testCase, this.adapterUnderTest);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * What Obsidian and the adapter make of `path` (paths.e2e.ts, #148): what
   * normalizePath turns it into, whether the shared rule accepts it before
   * and after, and what each adapter call does with it, over an emptied vault
   * holding only inside.md. The rule must hold on the string the file system
   * gets, so the adapter refuses any path normalizePath would change.
   */
  async pathScope(path: string): Promise<PathScopeResult> {
    await emptyVault(this.app);
    const adapter = new ObsidianVaultAdapter(this.app);
    await adapter.write("inside.md", encoder.encode("inside\n"));
    const outcome = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "ok";
      } catch (error) {
        return error instanceof VaultError ? error.code : describeError(error);
      }
    };
    const normalized = normalizePath(path);
    const result: PathScopeResult = {
      normalized,
      accepted: isVaultRelativePath(path),
      normalizedAccepted: isVaultRelativePath(normalized),
      write: await outcome(() => adapter.write(path, encoder.encode("outside\n"))),
      rename: await outcome(() => adapter.rename("inside.md", path)),
      read: await outcome(() => adapter.read(path)),
      stat: await adapter.stat(path),
      listed: await adapter.list(),
      inside: new TextDecoder().decode(await adapter.read("inside.md")),
    };
    await emptyVault(this.app);
    return result;
  }

  /**
   * The same for the config folder adapter (paths.e2e.ts, #148): `relative`
   * is written and renamed onto under the config folder's
   * `vault-sync-e2e-paths/` folder, which holds only inside.json, and every
   * file then in that folder (and an evil.json the write might have put in
   * the config folder itself) is reported, then removed.
   */
  async configPathScope(relative: string): Promise<ConfigPathScopeResult> {
    const host = configFolderHost(this.app, normalizePath);
    const disk = this.app.vault.adapter;
    const folder = "vault-sync-e2e-paths";
    const root = `${host.configDir}/${folder}`;
    const adapter = new ObsidianConfigAdapter(host);
    await adapter.write(`${folder}/inside.json`, encoder.encode("{}"));
    const outcome = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "ok";
      } catch (error) {
        return error instanceof VaultError ? error.code : describeError(error);
      }
    };
    const path = `${folder}/${relative}`;
    const write = await outcome(() => adapter.write(path, encoder.encode("{}")));
    const rename = await outcome(() => adapter.rename(`${folder}/inside.json`, path));
    const files: string[] = [];
    const folders = [root];
    for (let next = folders.pop(); next !== undefined; next = folders.pop()) {
      const listed = await disk.list(next);
      files.push(...listed.files);
      folders.push(...listed.folders);
    }
    const stray = `${host.configDir}/evil.json`;
    if (await disk.exists(stray)) {
      files.push(stray);
      await disk.remove(stray);
    }
    await disk.rmdir(root, true);
    return { write, rename, files: files.sort() };
  }

  /** The Journal conformance case names, in suite order. */
  journalConformanceCaseNames(): string[] {
    return journalConformance.map((testCase) => testCase.name);
  }

  /** Runs one Journal conformance case against an IndexedDbJournal on Obsidian's own IndexedDB, in a database of its own. */
  async runJournalConformanceCase(name: string): Promise<CaseResult> {
    const testCase = journalConformance.find((candidate) => candidate.name === name);
    if (testCase === undefined) return { ok: false, error: `no journal conformance case named ${JSON.stringify(name)}` };
    const database = `vault-sync-e2e-journal-conformance-${String(Date.now())}-${String(Math.random()).slice(2)}`;
    let current: IndexedDbJournal | undefined;
    try {
      const first = await IndexedDbJournal.open(window.indexedDB, database);
      current = first;
      await runJournalConformanceCase(testCase, () => ({
        journal: first,
        // An app restart: a new connection to the same database.
        reopen: async () => {
          current?.close();
          current = await IndexedDbJournal.open(window.indexedDB, database);
          return current;
        },
      }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    } finally {
      current?.close();
      await deleteDatabase(database);
    }
  }

  /** Obsidian's id for the open vault, which keys its journals. */
  localVaultId(): string {
    return localVaultId(this.app);
  }

  /** Sets the cursor of the open vault's journal for `key`, as a sync would. */
  async setJournalCursor(key: JournalKey, seq: string): Promise<void> {
    const journal = await openVaultJournal(this.app, key);
    try {
      await journal.resetCursor(BigInt(seq));
    } finally {
      journal.close();
    }
  }

  /**
   * The cursor of the journal for `key` of the vault with Obsidian id
   * `vaultId` (default: the open vault), read from this window's IndexedDB.
   */
  async journalCursor(key: JournalKey, vaultId?: string): Promise<string> {
    const journal = await IndexedDbJournal.open(window.indexedDB, journalDatabaseName(vaultId ?? localVaultId(this.app), key));
    try {
      return String(await journal.getCursor());
    } finally {
      journal.close();
    }
  }

  /** Deletes the open vault's journal for `key`. */
  async deleteJournal(key: JournalKey): Promise<void> {
    await deleteDatabase(journalDatabaseName(localVaultId(this.app), key));
  }

  /** The events reported to the adapter watched since this plugin loaded. */
  eventsSinceLoad(): VaultEvent[] {
    return [...this.sinceLoad];
  }

  /**
   * In the Markdown editor showing `path`: puts the cursor at `cursor`, types
   * `typed` there (unsaved: Obsidian saves 2 s later at the earliest), then
   * writes `remote` through the Obsidian adapter as the engine would apply a
   * remote revision. Obsidian's autosave of the view is held until the write
   * has finished (holdAutosave), so the keystrokes stay unsaved until then.
   */
  async typeThenWriteRemote(path: string, cursor: { line: number; ch: number }, typed: string, remote: string, options: RemoteWriteOptions = {}): Promise<EditorWriteResult> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.markdownView(path);
    const diskBefore = await this.app.vault.read(file);
    const { editor } = view;
    const autosave = holdAutosave(view);
    let outcome = "ok";
    try {
      editor.setCursor(cursor);
      editor.replaceSelection(typed);
      if (options.save === true) await view.save();
      try {
        await new ObsidianVaultAdapter(this.app).write(path, encoder.encode(remote), options.expectBase === true ? { expectedHash: sha256Hex(encoder.encode(diskBefore)) } : undefined);
      } catch (error) {
        outcome = describeError(error);
      }
    } finally {
      autosave.release();
    }
    return { outcome, diskBefore, editor: editor.getValue(), cursor: editor.getCursor(), disk: await this.app.vault.read(file) };
  }

  /**
   * In the Markdown editor showing `path`: types `typed` at `cursor`
   * (unsaved), then deletes the file through the Obsidian adapter as the
   * engine applies a remote delete, naming the content the disk had (unless
   * `expectBase` is false: no precondition). Obsidian's autosave of the view
   * is held until the delete has finished (holdAutosave).
   */
  async typeThenDeleteRemote(path: string, cursor: { line: number; ch: number }, typed: string, expectBase = true): Promise<EditorDeleteResult> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.markdownView(path);
    const diskBefore = await this.app.vault.read(file);
    const { editor } = view;
    const autosave = holdAutosave(view);
    let outcome = "ok";
    try {
      editor.setCursor(cursor);
      editor.replaceSelection(typed);
      try {
        await new ObsidianVaultAdapter(this.app).delete(path, expectBase ? { expectedHash: sha256Hex(encoder.encode(diskBefore)) } : undefined);
      } catch (error) {
        outcome = describeError(error);
      }
    } finally {
      autosave.release();
    }
    const after = this.app.vault.getFileByPath(path);
    return { outcome, editor: editor.getValue(), disk: after === null ? null : await this.app.vault.read(after) };
  }

  /**
   * In the Markdown editor showing `path`: types `typed` at `cursor`
   * (unsaved), then has vault-sync's session (startSession) pull and push,
   * as a remote change arriving while the user types would (unsaved.e2e.ts).
   * With `create`, the note is first created with that text and opened in
   * source mode. Obsidian's autosave of the view is held from the keystrokes
   * until the sync has finished (holdAutosave), so they are unsaved when the
   * sync reaches the adapter however long it takes (#600); the call throws
   * if the keystrokes requested no save (the hold would hold nothing) or the
   * editor matches the disk when the sync starts. The session never pushes
   * on its own (startSession): the steps before the sync await Obsidian, and
   * a debounced push falling due in between would sync the note first (#589).
   */
  async typeThenSync(path: string, cursor: { line: number; ch: number }, typed: string, create?: string): Promise<TypedSyncResult> {
    if (create !== undefined) {
      const created = await this.app.vault.create(path, create);
      await this.app.workspace.getLeaf(true).openFile(created, { active: true, state: { mode: "source" } });
    }
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.markdownView(path);
    const { editor } = view;
    const autosave = holdAutosave(view);
    let diskBefore: string;
    let outcome = "ok";
    try {
      editor.setCursor(cursor);
      editor.replaceSelection(typed);
      diskBefore = await this.app.vault.read(file);
      if (autosave.requests() === 0) throw new Error("the keystrokes requested no save: Obsidian's autosave is not held");
      if (editor.getValue() === (await this.app.vault.read(file))) throw new Error(`${path} has nothing unsaved when the sync starts`);
      try {
        await this.syncSession();
      } catch (error) {
        outcome = describeError(error);
      }
    } finally {
      autosave.release();
    }
    return { outcome, diskBefore, editor: editor.getValue(), files: await this.vaultFiles() };
  }

  /** Every file in the vault, by path, with its text. */
  async vaultFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const file of this.app.vault.getFiles()) files[file.path] = await this.app.vault.read(file);
    return files;
  }

  /** Commits a rename of the document at `from` to `to` on the session server, as another device would. */
  renameOnServer(from: string, to: string): void {
    const { server } = this.requireSession();
    const documentId = server.liveDocuments().get(from);
    if (documentId === undefined) throw new Error(`no document at ${from} on the server`);
    server.commit({ documentId, path: to });
  }

  /** Commits a delete of the document at `path` on the session server, as another device would. */
  deleteOnServer(path: string): void {
    const { server } = this.requireSession();
    const documentId = server.liveDocuments().get(path);
    if (documentId === undefined) throw new Error(`no document at ${path} on the server`);
    server.commit({ documentId, path, deleted: true });
  }

  private markdownView(path: string): MarkdownView {
    const view = this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).find((candidate) => candidate instanceof MarkdownView && candidate.file?.path === path);
    if (!(view instanceof MarkdownView)) throw new Error(`${path} is not open in a Markdown view`);
    return view;
  }

  /**
   * In the canvas showing `path`: adds a text node reading `nodeText` (unless
   * null), unsaved, then writes `remote` through the Obsidian adapter. The
   * canvas's autosave is held until the write has finished (holdAutosave).
   * The node is added through the canvas's internal API (not in Obsidian's
   * typings), as a user's click does.
   */
  async addCanvasNodeThenWriteRemote(path: string, nodeText: string | null, remote: string, options: CanvasWriteOptions = {}): Promise<ViewWriteResult & { reloads?: number; viewAfterReload?: string }> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.canvasView(path);
    const diskBefore = await this.app.vault.read(file);
    const autosave = holdAutosave(view);
    let tracker: ReturnType<typeof trackReloads> | undefined;
    let outcome = "ok";
    try {
      if (nodeText !== null) {
        const { canvas } = view as unknown as { canvas: { createTextNode(options: object): unknown } };
        canvas.createTextNode({ pos: { x: 0, y: 200 }, size: { width: 200, height: 60 }, text: nodeText, focus: false });
      }
      if (options.save === true) await view.save();
      tracker = options.awaitReload === true ? trackReloads(view) : undefined;
      try {
        await new ObsidianVaultAdapter(this.app).write(path, encoder.encode(remote), options.expectBase === true ? { expectedHash: sha256Hex(encoder.encode(diskBefore)) } : undefined);
      } catch (error) {
        outcome = describeError(error);
      }
    } finally {
      autosave.release();
    }
    const result = { outcome, diskBefore, view: view.getViewData(), disk: await this.app.vault.read(file) };
    if (tracker === undefined) return result;
    try {
      await tracker.settled();
    } finally {
      tracker.restore();
    }
    return { ...result, reloads: tracker.reloads.length, viewAfterReload: view.getViewData() };
  }

  /**
   * In the canvas showing `path` (nothing unsaved): writes `remote` through
   * the Obsidian adapter, adds a text node reading `nodeText` right after the
   * write resolves (before Obsidian's reload on the modify event has read the
   * disk), then waits until that reload has finished (#418, item 3). The
   * reload is TextFileView.loadFileInternal, internal to Obsidian 1.14.4.
   */
  async writeRemoteThenAddCanvasNode(path: string, remote: string, nodeText: string): Promise<ViewWriteResult & { reloads: number }> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.canvasView(path);
    const diskBefore = await this.app.vault.read(file);
    const { canvas } = view as unknown as { canvas: { createTextNode(options: object): unknown } };
    const tracker = trackReloads(view);
    let outcome = "ok";
    try {
      await new ObsidianVaultAdapter(this.app).write(path, encoder.encode(remote));
      canvas.createTextNode({ pos: { x: 0, y: 400 }, size: { width: 200, height: 60 }, text: nodeText, focus: false });
      await tracker.settled();
    } catch (error) {
      outcome = describeError(error);
    } finally {
      tracker.restore();
    }
    return { outcome, diskBefore, view: view.getViewData(), disk: await this.app.vault.read(file), reloads: tracker.reloads.length };
  }

  /**
   * Replaces Obsidian's `image` view with a plugin's text view under the
   * same type (as a plugin may, after unregistering the core one), opens
   * `path` in it, gives the view `unsaved` as data it has not saved, and
   * writes `remote` through the Obsidian adapter (#418, item 4). The core
   * view is restored afterwards.
   */
  async writeRemoteUnderPluginImageView(path: string, unsaved: string, remote: string): Promise<ViewWriteResult & { viewType: string }> {
    const registry = (this.app as unknown as { viewRegistry: { viewByType: Record<string, unknown>; unregisterView(type: string): void; registerView(type: string, creator: unknown): void } }).viewRegistry;
    const core = registry.viewByType.image;
    registry.unregisterView("image");
    registry.registerView("image", (leaf: ConstructorParameters<typeof PluginTextView>[0]) => new PluginTextView(leaf));
    const leaf = this.app.workspace.getLeaf(true);
    try {
      const file = this.app.vault.getFileByPath(path);
      if (file === null) throw new Error(`no file ${path}`);
      await leaf.openFile(file, { active: true });
      const { view } = leaf;
      if (!(view instanceof PluginTextView)) throw new Error(`${path} did not open in the plugin's view`);
      const diskBefore = await this.app.vault.read(file);
      view.data = unsaved;
      let outcome = "ok";
      try {
        await new ObsidianVaultAdapter(this.app).write(path, encoder.encode(remote));
      } catch (error) {
        outcome = describeError(error);
      }
      return { outcome, diskBefore, view: view.getViewData(), disk: await this.app.vault.read(file), viewType: view.getViewType() };
    } finally {
      leaf.detach();
      registry.unregisterView("image");
      registry.registerView("image", core);
    }
  }

  /** The canvas showing `path`, as the view serializes it. */
  canvasViewData(path: string): string {
    return this.canvasView(path).getViewData();
  }

  private canvasView(path: string): TextFileView {
    const view = this.app.workspace
      .getLeavesOfType("canvas")
      .map((leaf) => leaf.view)
      .find((candidate) => candidate instanceof FileView && candidate.file?.path === path);
    if (!(view instanceof TextFileView)) throw new Error(`${path} is not open in a canvas`);
    return view;
  }

  /**
   * A fresh in-memory server holding one synced note, an empty journal and
   * an emptied vault: this device before its first sync, with nothing of its
   * own to push.
   */
  async setUpSession(): Promise<void> {
    await emptyVault(this.app);
    const server = new InMemoryServer();
    const listChangesSince: string[] = [];
    server.interceptor = (method, request) => {
      if (method === "ListChanges") listChangesSince.push(String((request as { sinceSeq: bigint }).sinceSeq));
    };
    server.commit({ documentId: "doc-synced", path: "Synced.md", content: "synced from the server\n" });
    const journalKey = { serverUrl: "https://e2e.invalid", vaultId: server.vaultId };
    this.session?.journal?.close();
    await this.deleteJournal(journalKey);
    this.session = { server, journalKey, journal: undefined, listChangesSince, localChanges: [] };
  }

  /**
   * Starts sync in the vault-sync plugin over the session's server and the
   * open vault's IndexedDB journal, through a new connection each time: only
   * what the journal stored survives vault-sync's disable/enable cycle.
   * The session never pushes on its own (no debounced push after a local
   * change or a merge, and no sync timer), so the only pulls and pushes
   * after the start are the spec's (syncSession, typeThenSync). A push the
   * engine started on its own would otherwise run first whenever it falls
   * due while a spec awaits, and the spec's own push, queued behind it,
   * would see what that one left (#589). No spec relies on automatic pushes
   * through the harness, so every session runs without them (#600).
   */
  async startSession(): Promise<SessionStart> {
    const session = this.requireSession();
    session.journal?.close();
    session.journal = await openVaultJournal(this.app, session.journalKey);
    session.listChangesSince.length = 0;
    const changes: VaultEvent[] = [];
    session.localChanges.push(changes);
    const summary = await this.vaultSync().startSync({
      vaultId: session.server.vaultId,
      deviceId: "e2e-device",
      api: createProtocolClient({ transport: session.server.transport }),
      journal: session.journal,
      onLocalChange: (event) => changes.push(event),
      pushDebounceMs: null,
    });
    return { cursor: summary === undefined ? null : String(summary.cursor), applied: summary?.applied ?? 0, listChangesSince: [...session.listChangesSince] };
  }

  /** The local changes each started session reported, in start order. */
  sessionLocalChanges(): VaultEvent[][] {
    return this.requireSession().localChanges.map((changes) => [...changes]);
  }

  /** Commits `content` at `path` on the session's server, as another device would. */
  commitRemote(documentId: string, path: string, content: string): void {
    this.requireSession().server.commit({ documentId, path, content });
  }

  /** Sets vault-sync's config sync settings for the sessions startSession starts from now on (config.e2e.ts). */
  setConfigSync(settings: ConfigSyncSettings | null): void {
    const plugin = this.vaultSync();
    if (settings === null) delete plugin.data.configSync;
    else plugin.data.configSync = settings;
  }

  /** The documents the session startSession started tracks as unmaterializable, with their reasons, sorted by path. */
  async sessionUnmaterializable(): Promise<{ path: string; reason: string }[]> {
    const session = (this.vaultSync() as unknown as { session: SyncSession | undefined }).session;
    if (session === undefined) throw new Error("startSession() first");
    return (await session.unmaterializable()).map(({ path, reason }) => ({ path, reason })).sort((left, right) => (left.path < right.path ? -1 : 1));
  }

  /** Writes `content` at `path` through the Obsidian adapter, with no precondition: "ok" or the error it rejected with (platform.e2e.ts). */
  async writeThroughAdapter(path: string, content: string): Promise<string> {
    try {
      await new ObsidianVaultAdapter(this.app).write(path, encoder.encode(content));
      return "ok";
    } catch (error) {
      return describeError(error);
    }
  }

  /** Renames `from` to `to` through the Obsidian adapter: "ok" or the error it rejected with (platform.e2e.ts). */
  async renameThroughAdapter(from: string, to: string): Promise<string> {
    try {
      await new ObsidianVaultAdapter(this.app).rename(from, to);
      return "ok";
    } catch (error) {
      return describeError(error);
    }
  }

  /**
   * Creates `path` with `content`, opens it in `openIn`, and writes `remote`
   * through the Obsidian adapter as the engine applies a remote revision,
   * naming the content it checked (#163). When that write reads the file
   * for the `read`-th time, the user's editor writes `editorWrite` to it,
   * right then (#543).
   *
   * The editor's write is Vault.modify, which an editor's save ends in
   * (TextFileView.save). It is called directly: save() first waits for the
   * file adapter's queue to drain, and a write made without that wait is the
   * one an atomic write must still hold off. Vault.modify puts its write in
   * the queue synchronously, so where it lands is fixed by the queue, not by
   * timing.
   *
   * Only the reads the adapter under test makes are counted: it is given an
   * App whose vault and file adapter are views of the real ones, whose file
   * system (FileSystemAdapter.fsPromises, internal to Obsidian 1.14.4) counts
   * reads. Obsidian's own reads (the metadata cache's) go to the real file
   * adapter and are not counted. Every write of the file, by anyone, is
   * recorded, through the real file adapter's file system.
   */
  async writeRemoteWithEditorWriteAtRead(path: string, content: string, openIn: OpenIn, remote: string, editorWrite: string, read: number): Promise<ConcurrentWriteResult> {
    const { vault } = this.app;
    const realAdapter = vault.adapter as unknown as Partial<FileSystemInternals>;
    const realFs = realAdapter.fsPromises;
    if (!(vault.adapter instanceof FileSystemAdapter) || realFs === undefined || typeof realAdapter.getFullPath !== "function") {
      throw new Error("the vault's file adapter is not Obsidian 1.14.4's FileSystemAdapter");
    }
    const file = await vault.create(path, content);
    const leaf = openIn === "nothing" ? undefined : this.app.workspace.getLeaf(true);
    try {
      if (leaf !== undefined) await leaf.openFile(file, { active: true, state: { mode: "source" } });
      const opened = leaf?.view;
      if (openIn === "markdown" && !(opened instanceof MarkdownView)) throw new Error(`${path} did not open in a Markdown editor`);
      if (openIn === "canvas" && opened?.getViewType() !== "canvas") throw new Error(`${path} did not open in a canvas`);
      // Nothing unsaved: the disk holds the view's own serialization (a canvas's differs from `content`).
      if (opened instanceof TextFileView && opened.getViewData() !== content) await vault.modify(file, opened.getViewData());
      const diskBefore = await vault.adapter.read(path);
      if (opened instanceof TextFileView && opened.getViewData() !== diskBefore) throw new Error(`the view of ${path} does not show the disk`);
      const fullPath = realAdapter.getFullPath(path);

      const writes: string[] = [];
      const decoder = new TextDecoder();
      const recordingFs = Object.create(realFs, {
        writeFile: {
          value: (target: string, data: unknown, ...rest: unknown[]) => {
            if (target === fullPath) writes.push(typeof data === "string" ? data : decoder.decode(data as Uint8Array));
            return realFs.writeFile(target, data, ...rest);
          },
        },
      }) as FileSystemInternals["fsPromises"];
      let reads = 0;
      let editorWriting: Promise<void> | undefined;
      const countingFs = Object.create(recordingFs, {
        readFile: {
          value: (target: string, ...rest: unknown[]) => {
            if (target === fullPath && ++reads === read) editorWriting = vault.modify(file, editorWrite);
            return realFs.readFile(target, ...rest);
          },
        },
      }) as FileSystemInternals["fsPromises"];
      const adapterView: typeof vault.adapter = new Proxy(vault.adapter, {
        get: (target, property) => (property === "fsPromises" ? countingFs : (Reflect.get(target, property, adapterView) as unknown)),
      });
      const vaultView: typeof vault = new Proxy(vault, {
        get: (target, property) => (property === "adapter" ? adapterView : (Reflect.get(target, property, vaultView) as unknown)),
      });
      const appView = Object.create(this.app, { vault: { value: vaultView } }) as App;

      realAdapter.fsPromises = recordingFs;
      let outcome = "ok";
      let editorOutcome = "ok";
      try {
        try {
          await new ObsidianVaultAdapter(appView).write(path, encoder.encode(remote), { expectedHash: sha256Hex(encoder.encode(diskBefore)) });
        } catch (error) {
          outcome = describeError(error);
        }
        try {
          await editorWriting;
        } catch (error) {
          editorOutcome = describeError(error);
        }
      } finally {
        realAdapter.fsPromises = realFs;
      }
      return { outcome, interleaved: editorWriting !== undefined, editorOutcome, writes, disk: await vault.adapter.read(path) };
    } finally {
      leaf?.detach();
    }
  }

  /** The vault folder's absolute path (desktop's file system adapter), or null. */
  vaultBasePath(): string | null {
    const { adapter } = this.app.vault;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /** Pulls and pushes now in the session startSession started; resolves with what the push committed. */
  async syncSession(): Promise<number> {
    const session = (this.vaultSync() as unknown as { session: SyncSession | undefined }).session;
    if (session === undefined) throw new Error("startSession() first");
    const summary = await session.syncNow();
    if (summary === undefined) throw new Error(`the sync failed: ${describeError((session as unknown as { failure: unknown }).failure)}`);
    return summary.committed;
  }

  /** The session server's live paths, sorted, and its newest seq. */
  serverState(): { paths: string[]; headSeq: string } {
    const { server } = this.requireSession();
    return { paths: [...server.liveFiles().keys()].sort(), headSeq: String(server.currentHeadSeq) };
  }

  /** The session server's live files: each path's content, sorted by path. */
  serverFiles(): Record<string, string> {
    return Object.fromEntries([...this.requireSession().server.liveFiles()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  }

  /** Commits `content` at `path` on the session server as another device would, as a new revision of the document there if there is one. */
  commitOnServer(path: string, content: string): void {
    const { server } = this.requireSession();
    server.commit({ documentId: server.liveDocuments().get(path) ?? `remote-${path}`, path, content });
  }

  /** Paths (relative to the config folder) a config folder adapter reported since watchConfigFolder(), in order. */
  private readonly configEvents: string[] = [];

  /** Starts recording the changes an Obsidian config folder adapter reports, to show they happen. */
  watchConfigFolder(): void {
    this.configEvents.length = 0;
    this.register(new ObsidianConfigAdapter(configFolderHost(this.app, normalizePath)).watch((event) => this.configEvents.push(event.path)));
  }

  /** What watchConfigFolder() recorded. */
  reportedConfigChanges(): string[] {
    return [...this.configEvents];
  }

  /** Modifies a file the way a user edit lands on disk. */
  async modifyFile(path: string, text: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`no file ${path}`);
    await this.app.vault.modify(file, text);
  }

  /**
   * Turns vault-sync's pull timer off for the sessions it starts from now on
   * (realtime.e2e.ts), so a remote change can arrive only through a start's
   * pull or the realtime channel.
   */
  disablePullTimer(): void {
    const controller = (this.vaultSync() as unknown as { controller?: { options: { syncIntervalMs: number | null } } }).controller;
    if (controller === undefined) throw new Error("vault-sync has no sync controller");
    controller.options.syncIntervalMs = null;
  }

  /**
   * Commits a new note to vault-sync's connected server vault as another
   * device of the signed-in user would (realtime.e2e.ts): a device of its
   * own, the blob upload, then CommitRevision. Resolves with the revision's seq.
   */
  async commitFromAnotherDevice(path: string, text: string): Promise<string> {
    const plugin = this.vaultSync();
    const vaultId = plugin.connectedVault?.id;
    if (vaultId === undefined) throw new Error("vault-sync is not connected");
    const client = plugin.protocolClient();
    this.otherDeviceId ??= (await client.devices.registerDevice({ name: "e2e other device" })).device?.id;
    if (this.otherDeviceId === undefined) throw new Error("the server registered no device");
    const content = encoder.encode(text);
    const blobId = hexToBytes(sha256Hex(content));
    const size = BigInt(content.length);
    await client.blobs.beginBlob({ vaultId, blobId, size });
    await client.blobs.putBlobChunk({ vaultId, blobId, offset: 0n, data: content });
    await client.blobs.commitBlob({ vaultId, blobId });
    const response = await client.sync.commitRevision({
      vaultId,
      documentId: uuidv7(),
      revisionId: uuidv7(),
      kind: DocumentKind.TEXT,
      contentRef: { blobId, size },
      path: encoder.encode(path),
      deviceId: this.otherDeviceId,
    });
    return String(response.revision?.seq ?? 0n);
  }

  /**
   * Opens the history view of a note with two versions over a VaultHistory
   * whose `canRestore` resolves `role` ("viewer": false, "editor": true) or
   * rejects ("unknown"), as the role check may when ListVaults fails
   * (history.e2e.ts, #527). Restoring is refused: the spec only looks.
   */
  openHistoryAs(role: "viewer" | "editor" | "unknown"): void {
    const entry = (revisionId: string, seq: bigint, text: string): HistoryEntry => ({
      revisionId,
      documentId: "role-check",
      seq,
      path: "Role.md",
      deleted: false,
      kind: "text",
      contentHash: sha256Hex(encoder.encode(text)),
      size: BigInt(encoder.encode(text).length),
      deviceId: "",
      deviceName: undefined,
      thisDevice: true,
      createdAt: new Date(Date.UTC(2026, 0, 2, 3, Number(seq))),
    });
    const entries = [entry("role-2", 2n, "the newer version\n"), entry("role-1", 1n, "the older version\n")];
    const contents = new Map([
      ["role-2", "the newer version\n"],
      ["role-1", "the older version\n"],
    ]);
    const history: VaultHistory = {
      documentAt: () => Promise.resolve("role-check"),
      history: (documentId) => Promise.resolve({ documentId, headRevisionId: "role-2", entries, nextPageToken: "" }),
      readRevision: (revision) => Promise.resolve(encoder.encode(contents.get(revision.revisionId) ?? "")),
      restore: () => Promise.reject(new Error("restoring is not part of this check")),
      deletedDocuments: () => Promise.resolve([]),
      canRestore: () => (role === "unknown" ? Promise.reject(new Error("ListVaults failed")) : Promise.resolve(role === "editor")),
    };
    new HistoryModal(this.app, history, "role-check", "Role.md").open();
  }

  /** Registers another device of the signed-in user on vault-sync's server (devices.e2e.ts) and resolves with its id. */
  async registerAnotherDevice(name: string): Promise<string> {
    const id = (await this.vaultSync().protocolClient().devices.registerDevice({ name })).device?.id;
    if (id === undefined) throw new Error("the server registered no device");
    return id;
  }

  /** The ids of the signed-in user's devices that the server lists (not removed). */
  async serverDeviceIds(): Promise<string[]> {
    // Not through the intercept: the harness's own calls are not vault-sync's.
    const client = this.uninterceptedClient?.() ?? this.vaultSync().protocolClient();
    return (await client.devices.listDevices({})).devices.map((device) => device.id);
  }

  /**
   * Routes vault-sync's RemoveDevice calls through the harness from now on
   * (devices.e2e.ts): each call is recorded (`removeDeviceCalls`), and the
   * next one can be failed without reaching the server (`failNextRemoveDevice`)
   * or held until `releaseRemoveDevice` (`holdNextRemoveDevice`). Its
   * ListDevices calls are counted (`listDevicesCalls`), and the next one can
   * be held, already answered by the server, until `releaseListDevices`
   * (`holdNextListDevices`). Every other RPC goes to the server unchanged.
   */
  interceptRemoveDevice(): void {
    const plugin = this.vaultSync();
    if (this.removeDeviceIntercept !== undefined) return;
    const intercept: RemoveDeviceIntercept = { calls: [], next: "pass", release: undefined, listDevices: { calls: 0, next: "pass", release: undefined } };
    this.removeDeviceIntercept = intercept;
    const original = plugin.protocolClient.bind(plugin);
    this.uninterceptedClient = original;
    plugin.protocolClient = () => {
      const client = original();
      const devices = client.devices;
      return {
        ...client,
        devices: {
          ...devices,
          removeDevice: async (request, options) => {
            const mode = intercept.next;
            intercept.next = "pass";
            const call = { deviceId: request.deviceId ?? "", forwarded: false };
            intercept.calls.push(call);
            if (mode === "fail" || (mode === "hold" && (await new Promise<boolean>((resolve) => (intercept.release = resolve))))) {
              throw new Error("the e2e harness failed this RemoveDevice");
            }
            call.forwarded = true;
            return devices.removeDevice(request, options);
          },
          listDevices: async (request, options) => {
            const listing = intercept.listDevices;
            const mode = listing.next;
            listing.next = "pass";
            listing.calls++;
            const response = await devices.listDevices(request, options);
            if (mode === "hold") await new Promise<void>((resolve) => (listing.release = resolve));
            return response;
          },
        },
      };
    };
  }

  failNextRemoveDevice(): void {
    this.requireRemoveDeviceIntercept().next = "fail";
  }

  holdNextRemoveDevice(): void {
    this.requireRemoveDeviceIntercept().next = "hold";
  }

  /** Lets the held RemoveDevice go to the server, or fails it without sending it (`fail`); false if none is held. */
  releaseRemoveDevice(fail = false): boolean {
    const intercept = this.requireRemoveDeviceIntercept();
    const release = intercept.release;
    intercept.release = undefined;
    release?.(fail);
    return release !== undefined;
  }

  holdNextListDevices(): void {
    this.requireRemoveDeviceIntercept().listDevices.next = "hold";
  }

  /** Whether a held ListDevices was answered by the server and is waiting for `releaseListDevices`. */
  listDevicesHeld(): boolean {
    return this.requireRemoveDeviceIntercept().listDevices.release !== undefined;
  }

  /** Hands the held ListDevices' response to vault-sync; false if none is held. */
  releaseListDevices(): boolean {
    const listing = this.requireRemoveDeviceIntercept().listDevices;
    const release = listing.release;
    listing.release = undefined;
    release?.();
    return release !== undefined;
  }

  /** How many ListDevices calls vault-sync made since `interceptRemoveDevice`. */
  listDevicesCalls(): number {
    return this.requireRemoveDeviceIntercept().listDevices.calls;
  }

  /** Every RemoveDevice call since `interceptRemoveDevice`, and whether it was sent to the server. */
  removeDeviceCalls(): { deviceId: string; forwarded: boolean }[] {
    return this.requireRemoveDeviceIntercept().calls.map((call) => ({ ...call }));
  }

  private removeDeviceIntercept: RemoveDeviceIntercept | undefined;
  private uninterceptedClient: (() => ReturnType<VaultSyncPlugin["protocolClient"]>) | undefined;

  private requireRemoveDeviceIntercept() {
    if (this.removeDeviceIntercept === undefined) throw new Error("interceptRemoveDevice() first");
    return this.removeDeviceIntercept;
  }

  /**
   * From now on, vault-sync's CommitRevision calls reach the server, but
   * their responses never reach vault-sync: each call stays pending after
   * the server answered (device.android.e2e.ts). A session started
   * afterwards is thus stopped mid-push, its first commit acknowledged by
   * the server and not by the device, until the process is killed.
   */
  loseCommitResponses(): void {
    const plugin = this.vaultSync();
    const original = plugin.protocolClient.bind(plugin);
    const lost = { answered: 0 };
    this.lostCommitResponses = lost;
    plugin.protocolClient = () => {
      const client = original();
      const sync = client.sync;
      return {
        ...client,
        sync: {
          ...sync,
          commitRevision: async (request, options) => {
            await sync.commitRevision(request, options);
            lost.answered++;
            return await new Promise<never>(() => undefined);
          },
        },
      };
    };
  }

  /** How many commits the server answered since `loseCommitResponses`, none of which vault-sync saw. */
  answeredCommits(): number {
    if (this.lostCommitResponses === undefined) throw new Error("loseCommitResponses() first");
    return this.lostCommitResponses.answered;
  }

  private lostCommitResponses: { answered: number } | undefined;

  /**
   * Every revision of vault-sync's connected server vault, in seq order:
   * its document, path, whether it is a delete and its content's SHA-256
   * (the blob id of an unencrypted vault). Read through vault-sync's client.
   */
  async serverRevisions(): Promise<{ seq: string; documentId: string; path: string; deleted: boolean; sha256: string }[]> {
    const plugin = this.vaultSync();
    const vaultId = plugin.connectedVault?.id;
    if (vaultId === undefined) throw new Error("vault-sync is not connected");
    const client = plugin.protocolClient();
    const revisions: { seq: string; documentId: string; path: string; deleted: boolean; sha256: string }[] = [];
    for (let sinceSeq = 0n; ; ) {
      const page = await client.sync.listChanges({ vaultId, sinceSeq });
      for (const revision of page.revisions) {
        revisions.push({
          seq: String(revision.seq),
          documentId: revision.documentId,
          path: decoder.decode(revision.path),
          deleted: revision.deleted,
          sha256: bytesToHex(revision.contentRef?.blobId ?? new Uint8Array()),
        });
        sinceSeq = revision.seq;
      }
      if (!page.hasMore) return revisions;
    }
  }

  /** The SHA-256 of every file in the open vault (the config folder aside), by path. */
  async vaultDigests(): Promise<Record<string, string>> {
    const digests: Record<string, string> = {};
    for (const file of this.app.vault.getFiles()) digests[file.path] = sha256Hex(new Uint8Array(await this.app.vault.readBinary(file)));
    return digests;
  }

  private otherDeviceId: string | undefined;

  private vaultSync(): VaultSyncPlugin {
    const plugin = (this.app as unknown as PluginRegistry).plugins.plugins["vault-sync"];
    if (plugin === undefined) throw new Error("vault-sync is not loaded");
    return plugin as VaultSyncPlugin;
  }

  private requireSession() {
    if (this.session === undefined) throw new Error("setUpSession() first");
    return this.session;
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(new Error(`deleting ${name} failed: ${String(request.error)}`));
    };
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
