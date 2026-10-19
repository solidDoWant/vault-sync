// Test support for the engine's unit tests: a wired-up engine over the
// in-memory server, vault and journal, plus fault-injecting wrappers that
// "crash" the engine after a chosen number of durable changes.

import type { Backoff, Timers } from "../backoff";
import { createProtocolClient } from "../protocol/client";
import type { ConflictRecord, DeferredRevision, DocumentKindName, DocumentState, PendingOperation, RemoteRevision } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import type { DeletePrecondition, FileStat, VaultAdapter, VaultEvent, VaultListener, WritePrecondition } from "../vault/adapter";
import { InMemoryVault } from "../vault/memory";
import type { PathRules } from "../vaultpath/platform";
import { SyncEngine, type PushSummary, type UnmaterializableDocument } from "./engine";
import type { MergeHook, MergeRequest } from "./merge";
import { InMemoryServer, type InMemoryServerOptions } from "./memory-server";

/** Thrown by a crash point: the engine "dies" there. */
export class Crash extends Error {
  override readonly name = "Crash";
}

/** Counts durable changes (vault writes, renames, deletes; journal updates) and throws Crash right after the `crashAfter`-th. */
export class CrashPoints {
  /** 0 disables crashing. */
  crashAfter = 0;
  count = 0;

  /** Runs a durable change, then crashes if this was the chosen one. */
  async durable<T>(change: () => Promise<T>): Promise<T> {
    const result = await change();
    this.count++;
    if (this.crashAfter !== 0 && this.count === this.crashAfter) throw new Crash(`crash after durable change ${String(this.count)}`);
    return result;
  }
}

/** A VaultAdapter whose mutations are crash points. */
export class CrashingVault implements VaultAdapter {
  constructor(
    readonly inner: VaultAdapter,
    private readonly points: CrashPoints,
  ) {}

  list(): Promise<string[]> {
    return this.inner.list();
  }
  read(path: string): Promise<Uint8Array> {
    return this.inner.read(path);
  }
  stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(path);
  }
  watch(listener: VaultListener): () => void {
    return this.inner.watch(listener);
  }
  write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    return this.points.durable(() => this.inner.write(path, data, precondition));
  }
  rename(from: string, to: string): Promise<void> {
    return this.points.durable(() => this.inner.rename(from, to));
  }
  delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    return this.points.durable(() => this.inner.delete(path, precondition));
  }
}

/**
 * A VaultAdapter that holds back vault events until flush(), as a platform
 * whose file watcher reports changes late may. With `coalesce`, a create or
 * modify of a path whose previous held event was a create or modify of the
 * same path is folded into it, as a debouncing watcher does.
 */
export class LateEventsVault implements VaultAdapter {
  private held: VaultEvent[] = [];
  private readonly listeners = new Set<VaultListener>();

  constructor(
    readonly inner: VaultAdapter,
    private readonly coalesce = false,
  ) {
    inner.watch((event) => {
      const previous = this.held.at(-1);
      const folds = previous !== undefined && previous.path === event.path && previous.type !== "delete" && previous.type !== "rename";
      if (this.coalesce && folds && (event.type === "create" || event.type === "modify")) return;
      this.held.push(event);
    });
  }

  flush(): void {
    const events = this.held;
    this.held = [];
    for (const event of events) for (const listener of this.listeners) listener(event);
  }

  list(): Promise<string[]> {
    return this.inner.list();
  }
  read(path: string): Promise<Uint8Array> {
    return this.inner.read(path);
  }
  stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(path);
  }
  watch(listener: VaultListener): () => void {
    const subscription: VaultListener = (event) => {
      listener(event);
    };
    this.listeners.add(subscription);
    return () => {
      this.listeners.delete(subscription);
    };
  }
  write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    return this.inner.write(path, data, precondition);
  }
  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }
  delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    return this.inner.delete(path, precondition);
  }
}

/**
 * A VaultAdapter that lands a change of the test's just before the engine's
 * next write or delete of a path reaches the vault: what Obsidian's autosave
 * does when it saves the user's typing after the engine checked the disk and
 * before it writes (#163). The change goes to `inner` directly, as the user's
 * would, and is reported to the engine as a vault event.
 */
export class InterleavingVault implements VaultAdapter {
  private readonly armed = new Map<string, () => Promise<void>>();

  constructor(readonly inner: VaultAdapter) {}

  /** Runs `change` once, right before the next write or delete of `path`. */
  beforeNextChange(path: string, change: () => Promise<void>): void {
    this.armed.set(path, change);
  }

  /** Whether an armed change has not run yet. */
  get pending(): boolean {
    return this.armed.size > 0;
  }

  list(): Promise<string[]> {
    return this.inner.list();
  }
  read(path: string): Promise<Uint8Array> {
    return this.inner.read(path);
  }
  stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(path);
  }
  watch(listener: VaultListener): () => void {
    return this.inner.watch(listener);
  }
  async write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    await this.interleave(path);
    await this.inner.write(path, data, precondition);
  }
  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }
  async delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    await this.interleave(path);
    await this.inner.delete(path, precondition);
  }

  private async interleave(path: string): Promise<void> {
    const change = this.armed.get(path);
    if (change === undefined) return;
    this.armed.delete(path);
    await change();
  }
}

/** An InMemoryJournal whose updates are crash points. */
export class CrashingJournal extends InMemoryJournal {
  constructor(private readonly points: CrashPoints) {
    super();
  }
  override setCursor(seq: bigint): Promise<void> {
    return this.points.durable(() => super.setCursor(seq));
  }
  override resetCursor(seq: bigint): Promise<void> {
    return this.points.durable(() => super.resetCursor(seq));
  }
  override putDocument(state: DocumentState): Promise<void> {
    return this.points.durable(() => super.putDocument(state));
  }
  override putDeferred(deferred: DeferredRevision): Promise<void> {
    return this.points.durable(() => super.putDeferred(deferred));
  }
  override removeDeferred(documentId: string): Promise<void> {
    return this.points.durable(() => super.removeDeferred(documentId));
  }
  override addPending(operation: PendingOperation): Promise<void> {
    return this.points.durable(() => super.addPending(operation));
  }
  override removePending(revisionId: string): Promise<void> {
    return this.points.durable(() => super.removePending(revisionId));
  }
  override putConflict(conflict: ConflictRecord): Promise<void> {
    return this.points.durable(() => super.putConflict(conflict));
  }
}

export interface Harness {
  server: InMemoryServer;
  vault: InMemoryVault;
  journal: InMemoryJournal;
  engine: SyncEngine;
  /** Every request the merge hook received. */
  merges: MergeRequest[];
  /** Every vault event the engine reported as a local change. */
  localChanges: VaultEvent[];
  /** Every revision the engine reported as acknowledged. */
  acknowledged: RemoteRevision[];
  /** Replaces the engine with a fresh one over the same vault and journal (a restart). */
  restart(): SyncEngine;
}

export interface HarnessOptions {
  server?: InMemoryServer;
  vault?: InMemoryVault;
  journal?: InMemoryJournal;
  /** Wraps the vault the engine sees. */
  wrapVault?: (vault: InMemoryVault) => VaultAdapter;
  /** Omit to record requests and defer; pass "default" to use the engine's default hook. */
  merge?: MergeHook | "default";
  pageSize?: number;
  /** Automatic push delay; null (the default here) turns automatic pushes off. */
  pushDebounceMs?: number | null;
  onPushError?: (error: unknown) => void;
  /** The engine's clock; defaults to a fixed time, so conflict-copy names are predictable. */
  now?: () => Date;
  /** The engine's device name in conflict-copy names; defaults to testDeviceName. */
  deviceName?: string;
  /** Prefix of the ids the engine generates, so engines of several devices over one server do not collide. Defaults to "id". */
  idPrefix?: string;
  /** The engine's classification of new documents. */
  classify?: (path: string) => DocumentKindName;
  /** The engine's platform path rules, and the in-memory vault's unless `vault` is given. Defaults to POSIX. */
  pathRules?: PathRules;
  onUnmaterializable?: (document: UnmaterializableDocument) => void;
  /** The engine's RESOURCE_EXHAUSTED backoff, its timers and its jitter source (SyncEngineOptions). */
  rateLimitBackoff?: Backoff;
  timers?: Timers;
  random?: () => number;
  onPushComplete?: (summary: PushSummary) => void;
  /** The engine's download cap (SyncEngineOptions.maxDownloadBytes). */
  maxDownloadBytes?: number;
}

/** The device id the harness's engine commits with. */
export const testDeviceId = "device-1";
/** The device name in the harness engine's conflict-copy names. */
export const testDeviceName = "laptop";
/** The harness engine's default clock reading, as it appears in conflict-copy names. */
export const testDate = new Date(Date.UTC(2026, 9, 18, 4, 5, 6));
export const testStamp = "2026-10-18 040506";

export function harness(options: HarnessOptions = {}): Harness {
  const server = options.server ?? new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5 });
  const vault = options.vault ?? new InMemoryVault(options.pathRules === undefined ? {} : { pathRules: options.pathRules });
  const journal = options.journal ?? new InMemoryJournal();
  const merges: MergeRequest[] = [];
  const localChanges: VaultEvent[] = [];
  const acknowledged: RemoteRevision[] = [];
  let ids = 0;
  const recordingMerge: MergeHook = (request) => {
    merges.push(request);
    return Promise.resolve({ status: "deferred" });
  };
  const create = () =>
    new SyncEngine({
      vaultId: server.vaultId,
      deviceId: testDeviceId,
      deviceName: options.deviceName ?? testDeviceName,
      now: options.now ?? (() => testDate),
      api: createProtocolClient({ transport: server.transport }),
      vault: options.wrapVault === undefined ? vault : options.wrapVault(vault),
      journal,
      ...(options.merge === "default" ? {} : { merge: options.merge ?? recordingMerge }),
      onLocalChange: (event) => localChanges.push(event),
      onAcknowledged: (revision) => acknowledged.push(revision),
      pageSize: options.pageSize ?? 2,
      pushDebounceMs: options.pushDebounceMs ?? null,
      ...(options.onPushError === undefined ? {} : { onPushError: options.onPushError }),
      newId: () => `${options.idPrefix ?? "id"}-${String(++ids)}`,
      ...(options.classify === undefined ? {} : { classify: options.classify }),
      ...(options.pathRules === undefined ? {} : { pathRules: options.pathRules }),
      ...(options.onUnmaterializable === undefined ? {} : { onUnmaterializable: options.onUnmaterializable }),
      ...(options.rateLimitBackoff === undefined ? {} : { rateLimitBackoff: options.rateLimitBackoff }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.onPushComplete === undefined ? {} : { onPushComplete: options.onPushComplete }),
      ...(options.maxDownloadBytes === undefined ? {} : { maxDownloadBytes: options.maxDownloadBytes }),
    });
  const result: Harness = {
    server,
    vault,
    journal,
    engine: create(),
    merges,
    localChanges,
    acknowledged,
    restart: () => {
      result.engine.dispose();
      result.engine = create();
      return result.engine;
    },
  };
  return result;
}

const decoder = new TextDecoder();

/** Path to text content of every file in `vault`. */
export async function files(vault: VaultAdapter): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const path of (await vault.list()).sort()) result.set(path, decoder.decode(await vault.read(path)));
  return result;
}

export function text(content: Uint8Array | null): string | null {
  return content === null ? null : decoder.decode(content);
}

/** The conflict-copy name a harness device gives `name` + `extension`. */
export const copyOf = (name: string, extension: string, device = testDeviceName) => `${name} (conflict ${device} ${testStamp})${extension}`;

/** Two devices with their own vaults and journals over one server, each with the default (three-way) merge hook. */
export function twoDevices(options: Partial<HarnessOptions> = {}, serverOptions: InMemoryServerOptions = {}): { server: InMemoryServer; a: Harness; b: Harness } {
  const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5, ...serverOptions });
  const a = harness({ merge: "default", ...options, server, idPrefix: "a", deviceName: "device-a" });
  const b = harness({ merge: "default", ...options, server, idPrefix: "b", deviceName: "device-b" });
  return { server, a, b };
}

/** Both devices hold `content` at `path`, synced. */
export async function syncedOnBoth(devices: { a: Harness; b: Harness }, path: string, content: Uint8Array | string): Promise<void> {
  await devices.a.vault.write(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
  await devices.a.engine.push();
  await devices.b.engine.pull();
}

/** Runs `commit` (another device's commit) just before this device's next CommitRevision reaches the server. */
export function moveHeadBeforeCommit(h: Harness, commit: () => void): void {
  let moved = false;
  const previous = h.server.interceptor;
  h.server.interceptor = (method, request) => {
    previous?.(method, request);
    if (method === "CommitRevision" && !moved) {
      moved = true;
      commit();
    }
  };
}
