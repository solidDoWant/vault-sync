import { Plugin } from "obsidian";

import type { PullSummary } from "./core/engine/engine";
import { PROTOCOL_VERSION } from "./core/version";
import { SyncSession, type SyncSessionOptions } from "./obsidian/session";

export default class VaultSyncPlugin extends Plugin {
  private session: SyncSession | undefined;

  override onload(): void {
    console.debug(`vault-sync loaded (protocol v${String(PROTOCOL_VERSION)})`);
  }

  override onunload(): void {
    this.stopSync();
  }

  /**
   * Starts syncing the open vault, replacing any running session, and
   * resolves with the first pull's summary. Called once the device is signed
   * in (#25) and has opened its journal (`openVaultJournal`); nothing starts
   * sync before that.
   */
  startSync(options: SyncSessionOptions): Promise<PullSummary | undefined> {
    this.stopSync();
    const session = new SyncSession(this.app, options);
    this.session = session;
    return session.start();
  }

  stopSync(): void {
    this.session?.stop();
    this.session = undefined;
  }
}
