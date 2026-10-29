import type { Timers } from "../backoff";
import { InMemoryServer } from "../engine/memory-server";
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
