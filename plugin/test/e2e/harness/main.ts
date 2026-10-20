import { FileView, MarkdownView, normalizePath, Plugin, TextFileView, TFile, TFolder, type App } from "obsidian";

import { hexToBytes } from "@noble/hashes/utils.js";

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

const encoder = new TextEncoder();

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
   * remote revision. All in one turn, so no autosave can come in between.
   */
  async typeThenWriteRemote(path: string, cursor: { line: number; ch: number }, typed: string, remote: string, options: RemoteWriteOptions = {}): Promise<EditorWriteResult> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.markdownView(path);
    const diskBefore = await this.app.vault.read(file);
    const { editor } = view;
    editor.setCursor(cursor);
    editor.replaceSelection(typed);
    if (options.save === true) await view.save();
    let outcome = "ok";
    try {
      await new ObsidianVaultAdapter(this.app).write(path, encoder.encode(remote), options.expectBase === true ? { expectedHash: sha256Hex(encoder.encode(diskBefore)) } : undefined);
    } catch (error) {
      outcome = describeError(error);
    }
    return { outcome, diskBefore, editor: editor.getValue(), cursor: editor.getCursor(), disk: await this.app.vault.read(file) };
  }

  /**
   * In the Markdown editor showing `path`: types `typed` at `cursor`
   * (unsaved), then deletes the file through the Obsidian adapter as the
   * engine applies a remote delete, naming the content the disk had (unless
   * `expectBase` is false: no precondition).
   */
  async typeThenDeleteRemote(path: string, cursor: { line: number; ch: number }, typed: string, expectBase = true): Promise<EditorDeleteResult> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.markdownView(path);
    const diskBefore = await this.app.vault.read(file);
    const { editor } = view;
    editor.setCursor(cursor);
    editor.replaceSelection(typed);
    let outcome = "ok";
    try {
      await new ObsidianVaultAdapter(this.app).delete(path, expectBase ? { expectedHash: sha256Hex(encoder.encode(diskBefore)) } : undefined);
    } catch (error) {
      outcome = describeError(error);
    }
    const after = this.app.vault.getFileByPath(path);
    return { outcome, editor: editor.getValue(), disk: after === null ? null : await this.app.vault.read(after) };
  }

  /**
   * In the Markdown editor showing `path`: types `typed` at `cursor`
   * (unsaved), then, in the same turn, has vault-sync's session (startSession)
   * pull and push, as a remote change arriving while the user types would
   * (unsaved.e2e.ts). Obsidian saves the typed text 2 s later at the
   * earliest, and the in-memory server answers at once. With `create`, the
   * note is first created with that text and opened in source mode, in the
   * same turn, so vault-sync's debounced push cannot sync it before.
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
    editor.setCursor(cursor);
    editor.replaceSelection(typed);
    const diskBefore = await this.app.vault.read(file);
    let outcome = "ok";
    try {
      await this.syncSession();
    } catch (error) {
      outcome = describeError(error);
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
   * null), unsaved (the canvas saves 2 s later at the earliest), then writes
   * `remote` through the Obsidian adapter. All in one turn, so no autosave
   * can come in between. The node is added through the canvas's internal API
   * (not in Obsidian's typings), as a user's click does.
   */
  async addCanvasNodeThenWriteRemote(path: string, nodeText: string | null, remote: string, options: RemoteWriteOptions = {}): Promise<ViewWriteResult> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.canvasView(path);
    const diskBefore = await this.app.vault.read(file);
    if (nodeText !== null) {
      const { canvas } = view as unknown as { canvas: { createTextNode(options: object): unknown } };
      canvas.createTextNode({ pos: { x: 0, y: 200 }, size: { width: 200, height: 60 }, text: nodeText, focus: false });
    }
    if (options.save === true) await view.save();
    let outcome = "ok";
    try {
      await new ObsidianVaultAdapter(this.app).write(path, encoder.encode(remote), options.expectBase === true ? { expectedHash: sha256Hex(encoder.encode(diskBefore)) } : undefined);
    } catch (error) {
      outcome = describeError(error);
    }
    return { outcome, diskBefore, view: view.getViewData(), disk: await this.app.vault.read(file) };
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
