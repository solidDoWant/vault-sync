import type { Timers } from "../backoff";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import { deriveSubkey, generateKey, open } from "../e2ee/e2ee";
import { contentAad, pathAad } from "../e2ee/revision";
import type { VaultKeyring } from "./codec";
import { InMemoryServer, type InMemoryServerOptions } from "./memory-server";
import { createProtocolClient } from "../protocol/client";
import { InMemoryVault, type InMemoryVaultOptions } from "../vault/memory";
import { SyncEngine, type SyncEngineOptions } from "./engine";
import { MemorySyncJournal } from "./journal";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Timers that fire only when a test says so. */
export class ManualTimers implements Timers {
  private next = 1;
  private readonly timers = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.timers.set(handle, { callback, ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Delays of the timers that are set. */
  delays(): number[] {
    return [...this.timers.values()].map((timer) => timer.ms);
  }

  /** Fires every timer set with delay `ms`. */
  fire(ms: number): void {
    for (const [handle, timer] of [...this.timers]) {
      if (timer.ms !== ms) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

/** A device for engine tests: an in-memory vault and journal, and an engine on the shared server. */
export class Device {
  readonly vault: InMemoryVault;
  readonly journal = new MemorySyncJournal();
  readonly timers = new ManualTimers();
  engine: SyncEngine;

  constructor(
    readonly server: InMemoryServer,
    readonly deviceId: string,
    private readonly options: Partial<SyncEngineOptions> = {},
    vaultOptions: InMemoryVaultOptions = {},
  ) {
    this.vault = new InMemoryVault(vaultOptions);
    this.engine = this.newEngine();
  }

  /** A fresh engine on the same vault and journal, as after an app restart. */
  restart(): SyncEngine {
    this.engine.stop();
    this.engine = this.newEngine();
    return this.engine;
  }

  sync(): Promise<void> {
    return this.engine.sync();
  }

  async files(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const path of (await this.vault.list()).sort()) result[path] = decoder.decode(await this.vault.read(path));
    return result;
  }

  write(path: string, text: string): Promise<void> {
    return this.vault.write(path, encoder.encode(text));
  }

  private newEngine(): SyncEngine {
    return new SyncEngine({
      api: createProtocolClient({ transport: this.server.transport }),
      vaultId: this.server.vaultId,
      deviceId: this.deviceId,
      vault: this.vault,
      journal: this.journal,
      timers: this.timers,
      debounceMs: 2_000,
      intervalMs: 60_000,
      ...this.options,
    });
  }
}

/** Lets pending promise callbacks (event handlers' reads) run. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The epoch keys of an encrypted in-memory vault, shared by every test
 * device: `rotate` starts the next epoch on the server, as an owner device's
 * rotation does, and every device picks it up at its next refresh.
 */
export class TestKeyring implements VaultKeyring {
  private readonly keys = new Map<number, Uint8Array>();

  constructor(readonly server: InMemoryServer) {}

  /** Creates the next epoch and makes it the server's current one; returns it. */
  rotate(): number {
    const epoch = this.server.currentEpoch + 1;
    this.keys.set(epoch, generateKey());
    this.server.currentEpoch = epoch;
    return epoch;
  }

  refresh(): Promise<number> {
    return Promise.resolve(this.server.currentEpoch);
  }

  epochKey(epoch: number): Uint8Array | undefined {
    return this.keys.get(epoch);
  }

  /** A stored revision's path and content, decrypted with the key of its epoch. */
  reveal(revision: Revision, blob: Uint8Array | undefined): { path: string; content: Uint8Array | undefined } {
    const key = this.keys.get(revision.epoch);
    if (key === undefined) throw new Error(`no key for epoch ${String(revision.epoch)}`);
    const path = decoder.decode(open(deriveSubkey(key, "path"), revision.path, pathAad(this.server.vaultId, revision.documentId, revision.epoch)));
    const content = blob === undefined ? undefined : open(deriveSubkey(key, "content"), blob, contentAad(this.server.vaultId, revision.epoch));
    return { path, content };
  }
}

/** An end-to-end encrypted in-memory vault at epoch 1, whose liveFiles and liveDocuments decrypt, with its keys. */
export function encryptedServer(options: InMemoryServerOptions = {}): { server: InMemoryServer; keys: TestKeyring } {
  const server = new InMemoryServer({ vaultId: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e", ...options, encrypted: true });
  const keys = new TestKeyring(server);
  keys.rotate();
  server.reader = (revision, blob) => keys.reveal(revision, blob);
  return { server, keys };
}

/** Whether `needle` appears in any of `haystacks`, as bytes. */
export function containsBytes(haystacks: Iterable<Uint8Array>, needle: Uint8Array): boolean {
  const hex = bytesToHex(needle);
  for (const haystack of haystacks) if (bytesToHex(haystack).includes(hex)) return true;
  return false;
}
