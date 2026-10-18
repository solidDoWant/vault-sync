import { MarkdownView, Plugin, TFile, type App } from "obsidian";

import { InMemoryServer } from "../../../src/core/engine/memory-server";
import { InMemoryJournal } from "../../../src/core/journal/memory";
import { createProtocolClient } from "../../../src/core/protocol/client";
import type { VaultEvent } from "../../../src/core/vault/adapter";
import { runConformanceCase, vaultAdapterConformance, type VaultAdapterFactory } from "../../../src/core/vault/conformance";
import type VaultSyncPlugin from "../../../src/main";
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
    return { adapter: new ObsidianVaultAdapter(this.app), dispose: () => emptyVault(this.app) };
  };

  /** Events an Obsidian adapter watched from onload on, i.e. through Obsidian's startup indexing. */
  private readonly sinceLoad: VaultEvent[] = [];

  private session: { server: InMemoryServer; journal: InMemoryJournal; listChangesSince: string[]; localChanges: VaultEvent[][] } | undefined;

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
  async typeThenWriteRemote(path: string, cursor: { line: number; ch: number }, typed: string, remote: string): Promise<EditorWriteResult> {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) throw new Error(`no file ${path}`);
    const view = this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).find((candidate) => candidate instanceof MarkdownView && candidate.file === file);
    if (!(view instanceof MarkdownView)) throw new Error(`${path} is not open in a Markdown view`);
    const diskBefore = await this.app.vault.read(file);
    const { editor } = view;
    editor.setCursor(cursor);
    editor.replaceSelection(typed);
    let outcome = "ok";
    try {
      await new ObsidianVaultAdapter(this.app).write(path, encoder.encode(remote));
    } catch (error) {
      outcome = describeError(error);
    }
    return { outcome, diskBefore, editor: editor.getValue(), cursor: editor.getCursor(), disk: await this.app.vault.read(file) };
  }

  /** A fresh in-memory server holding one synced note, and an empty journal: this device before its first sync. */
  setUpSession(): void {
    const server = new InMemoryServer();
    const listChangesSince: string[] = [];
    server.interceptor = (method, request) => {
      if (method === "ListChanges") listChangesSince.push(String((request as { sinceSeq: bigint }).sinceSeq));
    };
    server.commit({ documentId: "doc-synced", path: "Synced.md", content: "synced from the server\n" });
    this.session = { server, journal: new InMemoryJournal(), listChangesSince, localChanges: [] };
  }

  /**
   * Starts sync in the vault-sync plugin over the session's server and
   * journal. The journal object outlives vault-sync's disable/enable cycle,
   * as the durable IndexedDB journal (#21) does.
   */
  async startSession(): Promise<SessionStart> {
    const session = this.requireSession();
    session.listChangesSince.length = 0;
    const changes: VaultEvent[] = [];
    session.localChanges.push(changes);
    const summary = await this.vaultSync().startSync({
      vaultId: session.server.vaultId,
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

  /** Modifies a file the way a user edit lands on disk. */
  async modifyFile(path: string, text: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`no file ${path}`);
    await this.app.vault.modify(file, text);
  }

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

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
