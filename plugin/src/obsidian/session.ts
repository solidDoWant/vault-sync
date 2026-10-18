import type { App } from "obsidian";

import { SyncEngine, type PullSummary } from "../core/engine/engine";
import type { MergeHook } from "../core/engine/merge";
import type { PullApi } from "../core/engine/remote";
import type { Journal } from "../core/journal/journal";
import type { VaultEvent } from "../core/vault/adapter";
import { ObsidianVaultAdapter } from "./vault-adapter";

export interface SyncSessionOptions {
  vaultId: string;
  /** This install's registered device, recorded with every commit. */
  deviceId: string;
  /** The device's name in conflict-copy names (SPEC.md §7); the engine falls back to the device id. */
  deviceName?: string;
  api: PullApi;
  /**
   * The device's durable journal for this vault and server vault
   * (`openVaultJournal`, ./journal.ts); it is what lets a restarted session
   * resume. The caller owns it and closes it after `stop`.
   */
  journal: Journal;
  merge?: MergeHook;
  /** The user's vault changes, to be pushed (SPEC.md §8). */
  onLocalChange?: (event: VaultEvent) => void;
}

/**
 * One running sync of the open vault: the Obsidian adapter and the sync
 * engine over the device's journal, tied to the plugin's lifecycle. It
 * starts once the workspace layout is ready (after Obsidian's startup
 * indexing) and resumes from the journal's cursor, so disabling and
 * re-enabling the plugin, or restarting Obsidian, never starts a full resync.
 */
export class SyncSession {
  private engine: SyncEngine | undefined;
  private stopped = false;

  constructor(
    private readonly app: App,
    private readonly options: SyncSessionOptions,
  ) {}

  /** Starts syncing and resolves with the first pull's summary, or undefined if stopped before it began. */
  async start(): Promise<PullSummary | undefined> {
    await new Promise<void>((resolve) => {
      this.app.workspace.onLayoutReady(resolve);
    });
    if (this.stopped) return undefined;
    this.engine = new SyncEngine({
      vaultId: this.options.vaultId,
      deviceId: this.options.deviceId,
      ...(this.options.deviceName === undefined ? {} : { deviceName: this.options.deviceName }),
      api: this.options.api,
      vault: new ObsidianVaultAdapter(this.app),
      journal: this.options.journal,
      ...(this.options.merge === undefined ? {} : { merge: this.options.merge }),
      ...(this.options.onLocalChange === undefined ? {} : { onLocalChange: this.options.onLocalChange }),
      // No automatic pushes until login, settings and push triggers are wired (#25).
      pushDebounceMs: null,
    });
    return this.engine.pull();
  }

  /** Stops watching the vault. An in-flight pull finishes its current step; the journal keeps the progress. */
  stop(): void {
    this.stopped = true;
    this.engine?.dispose();
  }
}
