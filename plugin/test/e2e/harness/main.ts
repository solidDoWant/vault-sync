import { FileView, MarkdownView, Plugin, TextFileView, TFile, TFolder, type App } from "obsidian";

import { hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind } from "../../../src/gen/vaultsync/v1/types_pb";
import { InMemoryServer } from "../../../src/core/engine/memory-server";
import { sha256Hex } from "../../../src/core/hash";
import { journalConformance, runJournalConformanceCase } from "../../../src/core/journal/conformance";
import { IndexedDbJournal } from "../../../src/core/journal/indexeddb";
import { createProtocolClient } from "../../../src/core/protocol/client";
import { uuidv7 } from "../../../src/core/uuid";
import type { VaultEvent } from "../../../src/core/vault/adapter";
import { runConformanceCase, vaultAdapterConformance, type VaultAdapterFactory } from "../../../src/core/vault/conformance";
import type VaultSyncPlugin from "../../../src/main";
import { journalDatabaseName, localVaultId, openVaultJournal, type JournalKey } from "../../../src/obsidian/journal";
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

/** A canvas view's state after a remote write to its file (editor.e2e.ts). */
export interface ViewWriteResult {
  outcome: string;
  diskBefore: string;
  /** The view's own serialization of what it shows. */
  view: string;
  disk: string;
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

  override onload(): void {
    // Registered as early as a plugin can: Obsidian may still be indexing.
    const stop = new ObsidianVaultAdapter(this.app).watch((event) => this.sinceLoad.push(event));
    this.register(stop);
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
   * engine applies a remote delete, naming the content the disk had.
   */
  async typeThenDeleteRemote(path: string, cursor: { line: number; ch: number }, typed: string): Promise<EditorDeleteResult> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.markdownView(path);
    const diskBefore = await this.app.vault.read(file);
    const { editor } = view;
    editor.setCursor(cursor);
    editor.replaceSelection(typed);
    let outcome = "ok";
    try {
      await new ObsidianVaultAdapter(this.app).delete(path, { expectedHash: sha256Hex(encoder.encode(diskBefore)) });
    } catch (error) {
      outcome = describeError(error);
    }
    const after = this.app.vault.getFileByPath(path);
    return { outcome, editor: editor.getValue(), disk: after === null ? null : await this.app.vault.read(after) };
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
