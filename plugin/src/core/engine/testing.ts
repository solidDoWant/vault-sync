// Test support for the engine's unit tests: a wired-up engine over the
// in-memory server, vault and journal, plus fault-injecting wrappers that
// "crash" the engine after a chosen number of durable changes.

import { ConnectError } from "@connectrpc/connect";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind, type Revision } from "../../gen/vaultsync/v1/types_pb";
import type { Backoff, Timers } from "../backoff";
import { sha256Hex } from "../hash";
import { pathKey } from "../pathkey/pathkey";
import { createProtocolClient } from "../protocol/client";
import type { ConflictRecord, DeferredRevision, DocumentKindName, DocumentState, Intent, Journal, JournalChanges, NewIntent, PendingOperation, RemoteRevision } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import { isVaultError, type DeletePrecondition, type FileStat, type VaultAdapter, type VaultEvent, type VaultListener, type WritePrecondition } from "../vault/adapter";
import { InMemoryVault } from "../vault/memory";
import { filesystemKey, unmaterializableReason, type PathPlatform, type PathRules } from "../vaultpath/platform";
import { PathSpace } from "./pathspace";
import { SyncEngine, type PushSummary, type UnmaterializableDocument } from "./engine";
import type { MergeHook, MergeRequest } from "./merge";
import { InMemoryServer, type InMemoryServerOptions } from "./memory-server";
import { uploadContent } from "./upload";

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
 * next write, delete or rename (from) of a path reaches the vault: what
 * Obsidian's autosave does when it saves the user's typing after the engine
 * checked the disk and before it writes (#163). The change goes to `inner` directly, as the user's
 * would, and is reported to the engine as a vault event.
 */
export class InterleavingVault implements VaultAdapter {
  private readonly armed = new Map<string, () => Promise<void>>();
  private readonly armedReads = new Map<string, () => Promise<void>>();

  constructor(readonly inner: VaultAdapter) {}

  /** Runs `change` once, right before the next write, delete or rename from `path`. */
  beforeNextChange(path: string, change: () => Promise<void>): void {
    this.armed.set(path, change);
  }

  /** Runs `change` once, right before the next read of `path`: a user's change racing what the engine reads (#757). */
  beforeNextRead(path: string, change: () => Promise<void>): void {
    this.armedReads.set(path, change);
  }

  /** Whether an armed change has not run yet. */
  get pending(): boolean {
    return this.armed.size > 0 || this.armedReads.size > 0;
  }

  list(): Promise<string[]> {
    return this.inner.list();
  }
  async read(path: string): Promise<Uint8Array> {
    const change = this.armedReads.get(path);
    if (change !== undefined) {
      this.armedReads.delete(path);
      await change();
    }
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
  async rename(from: string, to: string): Promise<void> {
    await this.interleave(from);
    await this.inner.rename(from, to);
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
  override setCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return this.points.durable(() => super.setCursor(seq, anchor));
  }
  override resetCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return this.points.durable(() => super.resetCursor(seq, anchor));
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
  /** One crash point for the whole transaction, which lands all or nothing. */
  override transact(changes: JournalChanges): Promise<void> {
    return this.points.durable(() => super.transact(changes));
  }
  override putIntent(intent: NewIntent): Promise<number> {
    return this.points.durable(() => super.putIntent(intent));
  }
  override removeIntent(id: number): Promise<void> {
    return this.points.durable(() => super.removeIntent(id));
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

/**
 * Each document's newest server claim (design §4.2 C2, INV-2): its deferred
 * revision's path when one waits, else its base's path; a deleted newest
 * revision claims nothing. A released document keeps its live base, so its
 * claim is the revision it waits for, not the path it left.
 */
export async function newestServerClaims(journal: Journal): Promise<[string, string][]> {
  const ahead = new Map((await journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.revision]));
  const claims: [string, string][] = [];
  for (const state of await journal.listDocuments()) {
    const newest = ahead.get(state.documentId) ?? state;
    if (!newest.deleted) claims.push([state.documentId, newest.path]);
  }
  return claims;
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

// ---------------------------------------------------------------------------
// Model-based property harness (docs/design/engine-path-ownership.md §9.3).
//
// A PropertyWorld is one device (A, the engine under test) over the
// in-memory server, vault and journal, plus a scripted remote client that
// commits through the real blob and CommitRevision calls. The harness keeps
// its own oracle, independent of the engine's journal: an inode per file
// (each user and engine write, rename and delete is recorded against it), the
// origin of every content (every user and remote write carries bytes no
// other write has, so a content hash names exactly one origin), which
// document each inode is bound to, and every revision the server held. The
// property suite (properties.test.ts) drives it with fast-check commands.
// ---------------------------------------------------------------------------

/**
 * The life of one engine incarnation. Journal writes are numbered; the
 * `crashAt`-th lands and then the process dies (Crash), and from then on
 * every journal or vault call of this incarnation throws Crash too, as a dead
 * process makes no further change.
 */
export class Lifeline {
  writes = 0;
  /** 0 disables crashing. */
  crashAt = 0;
  dead = false;

  async journalWrite<T>(change: () => Promise<T>): Promise<T> {
    this.check();
    const result = await change();
    this.writes++;
    if (this.crashAt !== 0 && this.writes === this.crashAt) {
      this.dead = true;
      throw new Crash(`crash at journal write ${String(this.writes)}`);
    }
    return result;
  }

  check(): void {
    if (this.dead) throw new Crash("the engine crashed");
  }
}

/** A Journal whose writes go through a Lifeline: it crashes at the Nth write. */
export class CrashAtWriteJournal implements Journal {
  constructor(
    readonly inner: Journal,
    private readonly life: Lifeline,
  ) {}

  private read<T>(call: () => Promise<T>): Promise<T> {
    this.life.check();
    return call();
  }
  getCursor(): Promise<bigint> {
    return this.read(() => this.inner.getCursor());
  }
  getCursorAnchor(): Promise<Uint8Array | undefined> {
    return this.read(() => this.inner.getCursorAnchor());
  }
  setCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return this.life.journalWrite(() => this.inner.setCursor(seq, anchor));
  }
  resetCursor(seq: bigint, anchor?: Uint8Array): Promise<void> {
    return this.life.journalWrite(() => this.inner.resetCursor(seq, anchor));
  }
  getDocument(documentId: string): Promise<DocumentState | undefined> {
    return this.read(() => this.inner.getDocument(documentId));
  }
  findDocumentByPath(path: string): Promise<DocumentState | undefined> {
    return this.read(() => this.inner.findDocumentByPath(path));
  }
  listDocuments(): Promise<DocumentState[]> {
    return this.read(() => this.inner.listDocuments());
  }
  putDocument(state: DocumentState): Promise<void> {
    return this.life.journalWrite(() => this.inner.putDocument(state));
  }
  addPending(operation: PendingOperation): Promise<void> {
    return this.life.journalWrite(() => this.inner.addPending(operation));
  }
  listPending(): Promise<PendingOperation[]> {
    return this.read(() => this.inner.listPending());
  }
  removePending(revisionId: string): Promise<void> {
    return this.life.journalWrite(() => this.inner.removePending(revisionId));
  }
  putDeferred(deferred: DeferredRevision): Promise<void> {
    return this.life.journalWrite(() => this.inner.putDeferred(deferred));
  }
  getDeferred(documentId: string): Promise<DeferredRevision | undefined> {
    return this.read(() => this.inner.getDeferred(documentId));
  }
  listDeferred(): Promise<DeferredRevision[]> {
    return this.read(() => this.inner.listDeferred());
  }
  removeDeferred(documentId: string): Promise<void> {
    return this.life.journalWrite(() => this.inner.removeDeferred(documentId));
  }
  putConflict(conflict: ConflictRecord): Promise<void> {
    return this.life.journalWrite(() => this.inner.putConflict(conflict));
  }
  listConflicts(): Promise<ConflictRecord[]> {
    return this.read(() => this.inner.listConflicts());
  }
  documentByFileKey(fileKey: string): Promise<DocumentState | undefined> {
    return this.read(() => this.inner.documentByFileKey(fileKey));
  }
  documentsByFileKey(fileKey: string): Promise<DocumentState[]> {
    return this.read(() => this.inner.documentsByFileKey(fileKey));
  }
  putIntent(intent: NewIntent): Promise<number> {
    return this.life.journalWrite(() => this.inner.putIntent(intent));
  }
  listIntents(): Promise<Intent[]> {
    return this.read(() => this.inner.listIntents());
  }
  removeIntent(id: number): Promise<void> {
    return this.life.journalWrite(() => this.inner.removeIntent(id));
  }
  /** One journal write: the transaction lands whole, then the crash point may fire — never part of it. */
  transact(changes: JournalChanges): Promise<void> {
    return this.life.journalWrite(() => this.inner.transact(changes));
  }
}

/** A change the engine made to the vault, as the harness's oracle records it. */
export type EngineChange = { type: "write"; path: string; hash: string } | { type: "rename"; from: string; to: string } | { type: "delete"; path: string };

/** The vault the engine sees: calls fail once its Lifeline is dead, and every change that landed is reported. */
export class ObservedVault implements VaultAdapter {
  constructor(
    readonly inner: VaultAdapter,
    private readonly life: Lifeline,
    private readonly observe: (change: EngineChange) => void,
    /** Runs before each of the engine's reads, which waits for it: a user change racing the read. */
    private readonly beforeRead: (path: string) => Promise<void> = () => Promise.resolve(),
  ) {}

  list(): Promise<string[]> {
    this.life.check();
    return this.inner.list();
  }
  async read(path: string): Promise<Uint8Array> {
    this.life.check();
    await this.beforeRead(path);
    return this.inner.read(path);
  }
  stat(path: string): Promise<FileStat | null> {
    this.life.check();
    return this.inner.stat(path);
  }
  watch(listener: VaultListener): () => void {
    return this.inner.watch(listener);
  }
  async write(path: string, data: Uint8Array, precondition?: WritePrecondition): Promise<void> {
    this.life.check();
    await this.inner.write(path, data, precondition);
    this.observe({ type: "write", path, hash: sha256Hex(data) });
  }
  async rename(from: string, to: string): Promise<void> {
    this.life.check();
    await this.inner.rename(from, to);
    this.observe({ type: "rename", from, to });
  }
  async delete(path: string, precondition?: DeletePrecondition): Promise<void> {
    this.life.check();
    await this.inner.delete(path, precondition);
    this.observe({ type: "delete", path });
  }
}

/** One file as the oracle sees it: an inode survives renames and in-place writes. */
export interface InodeFile {
  inode: number;
  path: string;
  hash: string;
}

/** The oracle's inode table, keyed as the in-memory vault looks files up. */
export class Inodes {
  private readonly files = new Map<string, InodeFile>();
  private next = 1;

  constructor(readonly key: (path: string) => string) {}

  at(path: string): InodeFile | undefined {
    return this.files.get(this.key(path));
  }
  all(): InodeFile[] {
    return [...this.files.values()];
  }
  /** A write landed at `path`: the file there keeps its inode (and spelling), or a new one is born. */
  wrote(path: string, hash: string): InodeFile {
    const existing = this.files.get(this.key(path));
    const file = existing === undefined ? { inode: this.next++, path, hash } : { ...existing, hash };
    this.files.set(this.key(path), file);
    return file;
  }
  renamed(from: string, to: string): InodeFile | undefined {
    const file = this.files.get(this.key(from));
    if (file === undefined) return undefined;
    this.files.delete(this.key(from));
    const moved = { ...file, path: to };
    this.files.set(this.key(to), moved);
    return moved;
  }
  deleted(path: string): InodeFile | undefined {
    const file = this.files.get(this.key(path));
    this.files.delete(this.key(path));
    return file;
  }
}

/** Where a content came from: a user write into an inode, or a remote device's commit of a document. */
export type ContentOrigin = { kind: "user"; inode: number; step: number } | { kind: "remote"; documentId: string; step: number };

/** A revision the harness saw on the server, with the command step it appeared in. */
export interface ObservedRevision {
  seq: bigint;
  revisionId: string;
  documentId: string;
  parentRevisionId: string;
  path: string;
  deleted: boolean;
  hash: string;
  deviceId: string;
  step: number;
}

/** A user operation on an inode, at a command step. */
export interface UserOperation {
  type: "create" | "edit" | "rename" | "delete";
  inode: number;
  step: number;
  /** The inode's content after the operation (before it, for a delete). */
  hash: string;
  /** A rename's new path. */
  path?: string;
}

/** The properties of §9.3 a violation counts against. */
export type PropertyId = "P1" | "P2" | "P3";

export interface Violation {
  property: PropertyId;
  step: number;
  message: string;
}

/** How the user renames a file (§9.3's alphabet): to a pool path, case-only, respelled under the path key, or onto a folder's name. */
export type RenameMode = "pool" | "case" | "respell" | "folder";

/** One command of the property alphabet, as plain data so a run can be replayed (P4). */
export type WorldCommand =
  | { type: "user-create"; path: number }
  | { type: "user-edit"; file: number }
  | { type: "user-rename"; file: number; mode: RenameMode; target: number }
  | { type: "user-delete"; file: number }
  | { type: "remote-create"; path: number }
  | { type: "remote-edit"; document: number }
  | { type: "remote-rename"; document: number; path: number }
  | { type: "remote-delete"; document: number }
  | { type: "pull" }
  | { type: "edit-during-pull"; file: number }
  | { type: "move-onto-incoming"; file: number; path: number }
  | { type: "push" }
  | { type: "crash"; write: number }
  | { type: "restore"; fraction: number }
  | { type: "purge"; revision: number };

/**
 * The paths commands pick from: case variants, NFC/NFD spellings, ß/SS
 * (one path key, two files on every platform), a folder whose name is also a
 * file name, and names Windows cannot hold (a forbidden character, a trailing
 * dot): on `windows` a remote create or rename onto one makes the document
 * unmaterializable there, and the user cannot create one (#587). The colon is
 * not second: `a:b.md` is a drive prefix the server refuses on every platform
 * (SPEC.md §6). `ı.md` and `I.md` have two path keys but are one file on
 * `windows` and `macos` (an `F`-alias, design §3.1): the device holds only
 * one of two such live documents (#736).
 */
export const worldPaths: readonly string[] = ["a.md", "A.md", "b.md", "Café.md", "Café.md", "Straße.md", "STRASSE.md", "x", "x/a.md", "X/b.md", "y/x.md", "no:te.md", "b.md.", "ı.md", "I.md"];

/** The remote device's id: its commits are not device A's. */
export const remoteDeviceId = "device-remote";

/** The quiescence loop's bound on push/pull rounds (INV-8, P6). */
export const quiescenceRounds = 6;

/** Strips conflict-copy suffixes: P4 compares states modulo copy names. */
export function withoutCopyNames(path: string): string {
  return path.replace(/ \(conflict [^)]*\)/g, " (conflict)");
}

const worldEncoder = new TextEncoder();

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The last of `revisions` that `matches` (Array.prototype.findLast is ES2023, above the plugin's ES2022 lib). */
function lastRevision(revisions: readonly ObservedRevision[], matches: (revision: ObservedRevision) => boolean): ObservedRevision | undefined {
  for (let position = revisions.length - 1; position >= 0; position--) {
    const revision = revisions[position];
    if (revision !== undefined && matches(revision)) return revision;
  }
  return undefined;
}

/** The world the property suite drives; see the section comment above. */
export class PropertyWorld {
  readonly server: InMemoryServer;
  readonly vault: InMemoryVault;
  readonly journal = new InMemoryJournal();
  readonly pathRules: PathRules;
  readonly inodes: Inodes;
  life = new Lifeline();
  engine: SyncEngine;
  /** The command being applied; the quiescence rounds continue the count. */
  step = 0;
  readonly origins = new Map<string, ContentOrigin>();
  readonly revisions: ObservedRevision[] = [];
  /** Every content hash any revision ever carried on the server, purged or rolled back since or not. */
  readonly everOnServer = new Set<string>();
  /** The document each inode is bound to, as far as the oracle can tell. */
  readonly bound = new Map<number, string>();
  /** Every document each inode was ever bound to. */
  readonly everBound = new Map<number, Set<string>>();
  readonly userOperations: UserOperation[] = [];
  /** Every content the user wrote. */
  readonly userWrites = new Set<string>();
  /** Contents the user discarded: what a file held when the user overwrote or deleted it. */
  readonly discarded = new Set<string>();
  /** Inodes the user deleted. */
  readonly userDeleted = new Set<number>();
  /** Errors a pull or push of a live engine rejected with. */
  readonly errors: unknown[] = [];
  readonly violations: Violation[] = [];
  /** Crashes that happened. */
  crashes = 0;
  /** The paths commands pick from. */
  readonly paths: readonly string[];
  /** Every change the engine reported as a local one (`onLocalChange`), in order. */
  readonly localChanges: VaultEvent[] = [];
  /** The vault events a user change emitted (the vault emits synchronously within the change). */
  private readonly userEvents = new WeakSet<VaultEvent>();
  /** The actor of the change the vault is emitting, from its inode tap, which runs before the watchers. */
  private emitting: "user" | "engine" | undefined;
  private scanned = 0n;
  private ids = 0;
  private readonly api: ReturnType<typeof createProtocolClient>;
  /** A user change armed to run right before the engine's next read of a path. */
  private raceRead: { path: string; change: () => Promise<void> } | undefined;

  /**
   * `filesystem` is the in-memory vault's (`folded` by default): on the
   * `faithful` one, `F` decides the file, so `Straße.md` and `STRASSE.md` are
   * two files on every platform and NFC and NFD `Café.md` two on `windows`.
   * `paths` are the paths commands pick from (`worldPaths` by default).
   */
  constructor(platform: PathPlatform = "posix", filesystem: "folded" | "faithful" = "folded", paths: readonly string[] = worldPaths) {
    this.pathRules = { platform };
    this.paths = paths;
    this.server = new InMemoryServer({ maxPageSize: 3, maxDownloadBytes: 64, now: () => testDate });
    this.vault = new InMemoryVault({ pathRules: this.pathRules, now: () => testDate.getTime(), filesystem });
    // Keyed as the vault looks files up: by `F` on the faithful vault; on the folded one by the file key, so `ı.md` and `I.md` are one file on `windows` and `macos`.
    this.inodes = new Inodes(filesystem === "faithful" ? (path) => filesystemKey(path, platform) : new PathSpace(this.pathRules).fileKey);
    this.vault.tapInodes((event) => {
      this.emitting = event.actor;
    });
    this.vault.watch((event) => {
      if (this.emitting === "user") this.userEvents.add(event);
    });
    this.api = createProtocolClient({ transport: this.server.transport });
    this.engine = this.createEngine();
  }

  private createEngine(): SyncEngine {
    return new SyncEngine({
      vaultId: this.server.vaultId,
      deviceId: testDeviceId,
      deviceName: testDeviceName,
      now: () => testDate,
      api: createProtocolClient({ transport: this.server.transport }),
      vault: new ObservedVault(
        this.vault.handle("engine"),
        this.life,
        (change) => {
          this.engineChanged(change);
        },
        async (path) => {
          const race = this.raceRead;
          if (race === undefined || race.path !== path) return;
          this.raceRead = undefined;
          await race.change();
        },
      ),
      onLocalChange: (event) => this.localChanges.push(event),
      journal: new CrashAtWriteJournal(this.journal, this.life),
      pageSize: 3,
      pushDebounceMs: null,
      onPushError: () => undefined,
      newId: () => `id-${String(++this.ids)}`,
      pathRules: this.pathRules,
      random: () => 0.5,
    });
  }

  /** Arms a crash at the `write`-th journal write from now. */
  armCrash(write: number): void {
    this.life.crashAt = this.life.writes + write;
  }

  /** Applies one command, waits for the engine to settle, restarts it if it crashed, and records what the server now holds. */
  async apply(command: WorldCommand): Promise<void> {
    const step = ++this.step;
    switch (command.type) {
      case "user-create":
        await this.userCreate(this.paths[command.path % this.paths.length] ?? "a.md");
        break;
      case "user-edit":
        await this.userEdit(command.file);
        break;
      case "user-rename":
        await this.userRename(command.file, command.mode, command.target);
        break;
      case "user-delete":
        await this.userDelete(command.file);
        break;
      case "remote-create":
        await this.remoteCommit(`r-${String(step)}`, this.paths[command.path % this.paths.length] ?? "a.md", this.remoteContent(`r-${String(step)}`), false);
        break;
      case "remote-edit":
      case "remote-rename":
      case "remote-delete": {
        const live = [...this.server.liveDocuments()].sort(([a], [b]) => byText(a, b));
        const picked = live.length === 0 ? undefined : live[command.document % live.length];
        if (picked === undefined) break;
        const [path, documentId] = picked;
        if (command.type === "remote-edit") await this.remoteCommit(documentId, path, this.remoteContent(documentId), false);
        else if (command.type === "remote-rename") await this.remoteCommit(documentId, this.paths[command.path % this.paths.length] ?? "a.md", undefined, false);
        else await this.remoteCommit(documentId, path, undefined, true);
        break;
      }
      case "pull":
        await this.run(() => this.engine.pull());
        break;
      case "edit-during-pull": {
        // The user saves while a pull is under way, before the engine has
        // handled the save's vault event (#587).
        const pulling = this.run(() => this.engine.pull());
        await this.userEdit(command.file);
        await pulling;
        break;
      }
      case "move-onto-incoming": {
        // Another device creates a document with the bytes of a known
        // document's file here (an untracked file would be adopted, INV-3),
        // and the user moves that file onto the document's path while the
        // pull reads it, before the engine has handled the rename (#757).
        const bound = (await this.vault.list()).filter((path) => this.bound.has(this.inodes.at(path)?.inode ?? 0)).sort(byText);
        const from = bound.length === 0 ? undefined : bound[command.file % bound.length];
        const to = worldPaths[command.path % worldPaths.length] ?? "a.md";
        // Only a move the vault allows: a file at `to` refuses it.
        if (from !== undefined && from !== to && (await this.vault.stat(to)) === null) {
          const content = await this.vault.read(from);
          await this.remoteCommit(`r-${String(step)}`, to, content, false);
          // Recorded before the pull, so the oracle knows the revision the engine writes.
          this.scan();
          this.raceRead = { path: to, change: () => this.userMove(from, to) };
        }
        await this.run(() => this.engine.pull());
        this.raceRead = undefined;
        break;
      }
      case "push":
        await this.run(() => this.engine.push());
        break;
      case "crash":
        this.armCrash(command.write);
        break;
      case "restore": {
        const seq = BigInt(Math.floor(Number(this.server.currentHeadSeq) * command.fraction));
        this.server.restoreTo(seq);
        if (this.scanned > seq) this.scanned = seq;
        break;
      }
      case "purge": {
        const purgeable = this.retained().filter((revision) => this.server.head(revision.documentId)?.id !== revision.id);
        const victim = purgeable.length === 0 ? undefined : purgeable[command.revision % purgeable.length];
        if (victim !== undefined) this.server.purge(victim.id);
        break;
      }
    }
    await this.settle();
    await this.checkExclusivity();
  }

  /**
   * Pushes and pulls until a round changes neither the server nor the vault,
   * at most `rounds` rounds, with any armed crash disarmed. Returns whether
   * it got there.
   */
  async quiesce(rounds = quiescenceRounds): Promise<boolean> {
    this.life.crashAt = 0;
    let before = await this.fingerprint();
    for (let round = 0; round < rounds; round++) {
      this.step++;
      await this.run(() => this.engine.push());
      await this.run(() => this.engine.pull());
      await this.checkExclusivity();
      const after = await this.fingerprint();
      if (after === before) return true;
      before = after;
    }
    return false;
  }

  /** INV-9 at quiescence: the problems found, empty if the device converged with the server. */
  async convergence(): Promise<string[]> {
    const problems: string[] = [];
    // Modulo unmaterializable (INV-9): a live document whose path this platform
    // cannot hold has no file here, and the earlier version of one, where the
    // device kept it, is no copy of the server's.
    const kept = new Set((await this.engine.unmaterializable()).flatMap((document) => (document.localPath !== undefined && unmaterializableReason(document.path, this.pathRules) !== undefined ? [document.localPath] : [])));
    const space = new PathSpace(this.pathRules);
    const live = [...this.server.liveFiles()].filter(([path]) => unmaterializableReason(path, this.pathRules) === undefined);
    // Modulo `F`-aliases (decision #52, #736): of live documents whose paths
    // differ under the server's key but are one file here, the device holds
    // exactly one, whichever arrived first; the others are unmaterializable.
    const aliases = (path: string) => live.some(([other]) => other !== path && space.collides(other, path, "file") && !space.collides(other, path, "server"));
    const aliased = live.filter(([path]) => aliases(path));
    const held = [...(await files(this.vault))].filter(([path]) => !kept.has(path));
    // Folder segments compare under `F`, the final segment exactly (INV-9,
    // PO-10): a folder has one spelling on disk, so the server's `X/b.md` is
    // held as `x/b.md` where the vault has `x/` (#737).
    const spelling = (path: string): string => {
      const slash = path.lastIndexOf("/");
      return slash < 0 ? path : `${space.filesystemKey(path.slice(0, slash))}${path.slice(slash)}`;
    };
    const vault = held.filter(([path]) => !aliases(path)).map(([path, content]) => `${spelling(path)}=${content}`).sort(byText);
    const server = live.filter(([path]) => !aliases(path)).map(([path, content]) => `${spelling(path)}=${content}`).sort(byText);
    if (vault.join("\n") !== server.join("\n")) problems.push(`vault ${JSON.stringify(vault)} differs from the server's live documents ${JSON.stringify(server)}`);
    for (const [path] of aliased) {
      const group = aliased.filter(([other]) => space.oneFile(other, path));
      const copies = held.filter(([file]) => space.oneFile(file, path));
      if (copies.length !== 1 || !group.some(([other, content]) => other === copies[0]?.[0] && content === copies[0][1])) {
        problems.push(`the vault holds ${JSON.stringify(copies)} for the aliased live documents ${JSON.stringify(group)}, not exactly one of them`);
      }
    }
    const pending = await this.journal.listPending();
    if (pending.length > 0) problems.push(`pending operations left: ${pending.map((operation) => `${operation.documentId}@${operation.path}`).join(", ")}`);
    const deferred = (await this.journal.listDeferred()).filter((entry) => entry.reason !== "unmaterializable" && entry.reason !== "out-of-scope");
    if (deferred.length > 0) problems.push(`deferred revisions left: ${deferred.map((entry) => `${entry.revision.documentId} (${entry.reason})`).join(", ")}`);
    const cursor = await this.journal.getCursor();
    if (cursor !== this.server.currentHeadSeq) problems.push(`cursor ${String(cursor)} is not the server's head ${String(this.server.currentHeadSeq)}`);
    return problems;
  }

  /**
   * P7 (INV-10): the local changes the engine reported that no user change
   * emitted, i.e. its own writes, renames and deletes it took for the
   * user's, as the simulation's `engine-echo` check finds them.
   */
  ownChangesReported(): string[] {
    return this.localChanges.filter((event) => !this.userEvents.has(event)).map((event) => `the engine reported its own ${event.type} of ${JSON.stringify(event.path)} as a local change`);
  }

  /** P5: the contents the user wrote and did not discard that are neither in the vault nor were ever on the server. */
  async lostWrites(): Promise<string[]> {
    const inVault = new Set<string>();
    for (const path of await this.vault.list()) inVault.add(sha256Hex(await this.vault.read(path)));
    const lost: string[] = [];
    for (const hash of this.userWrites) {
      if (this.discarded.has(hash) || inVault.has(hash) || this.everOnServer.has(hash)) continue;
      lost.push(`the ${this.describe(hash)}`);
    }
    return lost;
  }

  /** P4's comparison: the server's live documents and the vault, modulo copy names. */
  async outcome(): Promise<string> {
    const vault = [...(await files(this.vault))].map(([path, content]) => `${withoutCopyNames(path)}=${content}`).sort(byText);
    const server = [...this.server.liveFiles()].map(([path, content]) => `${withoutCopyNames(path)}=${content}`).sort(byText);
    return JSON.stringify({ vault, server });
  }

  private remoteContent(documentId: string): Uint8Array {
    const content = worldEncoder.encode(`remote ${String(this.step)}`);
    this.origins.set(sha256Hex(content), { kind: "remote", documentId, step: this.step });
    return content;
  }

  /** The scripted remote device: one commit against the current head, through the real blob and commit calls; a refusal is a no-op. */
  private async remoteCommit(documentId: string, path: string, content: Uint8Array | undefined, deleted: boolean): Promise<void> {
    const head = this.server.head(documentId);
    let hash: string;
    let size: bigint;
    if (content === undefined) {
      if (head?.contentRef === undefined) return;
      hash = bytesToHex(head.contentRef.blobId);
      size = head.contentRef.size;
    } else {
      hash = sha256Hex(content);
      size = BigInt(content.length);
      await uploadContent(this.api, this.server.vaultId, hash, size, () => Promise.resolve(content));
    }
    try {
      await this.api.sync.commitRevision({
        vaultId: this.server.vaultId,
        documentId,
        revisionId: `${documentId}-rev-${String(this.step)}`,
        baseRevId: head?.id ?? "",
        kind: DocumentKind.TEXT,
        contentRef: { blobId: hexToBytes(hash), size },
        path: worldEncoder.encode(path),
        deleted,
        deviceId: remoteDeviceId,
      });
    } catch (error) {
      if (!(error instanceof ConnectError)) throw error;
    }
  }

  private async userFile(index: number): Promise<string | undefined> {
    const paths = (await this.vault.list()).sort(byText);
    return paths.length === 0 ? undefined : paths[index % paths.length];
  }

  private async userCreate(path: string): Promise<void> {
    if ((await this.vault.stat(path)) !== null) return;
    await this.userWrite(path, "create");
  }

  private async userEdit(index: number): Promise<void> {
    const path = await this.userFile(index);
    if (path !== undefined) await this.userWrite(path, "edit");
  }

  private async userWrite(path: string, type: "create" | "edit"): Promise<void> {
    const content = worldEncoder.encode(`user ${String(this.step)}`);
    const previous = this.inodes.at(path);
    try {
      await this.vault.write(path, content);
    } catch (error) {
      if (isVaultError(error)) return;
      throw error;
    }
    const hash = sha256Hex(content);
    const file = this.inodes.wrote(path, hash);
    this.origins.set(hash, { kind: "user", inode: file.inode, step: this.step });
    this.userWrites.add(hash);
    if (previous !== undefined) this.discarded.add(previous.hash);
    this.userOperations.push({ type, inode: file.inode, step: this.step, hash });
  }

  private async userRename(index: number, mode: RenameMode, target: number): Promise<void> {
    const from = await this.userFile(index);
    if (from === undefined) return;
    let to: string;
    switch (mode) {
      case "pool":
        to = this.paths[target % this.paths.length] ?? "a.md";
        break;
      case "case":
        to = from === from.toUpperCase() ? from.toLowerCase() : from.toUpperCase();
        break;
      case "respell":
        to = from === from.normalize("NFC") ? from.normalize("NFD") : from.normalize("NFC");
        if (to === from) to = from.includes("ß") ? from.replace("ß", "SS") : from.replace("SS", "ß");
        break;
      case "folder": {
        const folders = (await this.vault.list()).flatMap((path) => (path.includes("/") ? [path.slice(0, path.lastIndexOf("/"))] : []));
        to = folders.length === 0 ? "x" : (folders.sort(byText)[target % folders.length] ?? "x");
        break;
      }
    }
    if (to === from) return;
    await this.userMove(from, to);
  }

  /** The user moves the file at `from` to `to`; a move the vault refuses is a no-op. */
  private async userMove(from: string, to: string): Promise<void> {
    try {
      await this.vault.rename(from, to);
    } catch (error) {
      if (isVaultError(error)) return;
      throw error;
    }
    const file = this.inodes.renamed(from, to);
    if (file !== undefined) this.userOperations.push({ type: "rename", inode: file.inode, step: this.step, hash: file.hash, path: to });
  }

  private async userDelete(index: number): Promise<void> {
    const path = await this.userFile(index);
    if (path === undefined) return;
    try {
      await this.vault.delete(path);
    } catch (error) {
      if (isVaultError(error)) return;
      throw error;
    }
    const file = this.inodes.deleted(path);
    if (file === undefined) return;
    this.userDeleted.add(file.inode);
    this.discarded.add(file.hash);
    this.userOperations.push({ type: "delete", inode: file.inode, step: this.step, hash: file.hash });
  }

  private engineChanged(change: EngineChange): void {
    if (change.type === "rename") {
      this.inodes.renamed(change.from, change.to);
      return;
    }
    if (change.type === "delete") {
      this.inodes.deleted(change.path);
      return;
    }
    const file = this.inodes.wrote(change.path, change.hash);
    // The engine materialized a revision of a document at that document's path: the file is that document's.
    const key = this.inodes.key(change.path);
    const revision = lastRevision(this.revisions, (candidate) => candidate.hash === change.hash && !candidate.deleted && this.inodes.key(candidate.path) === key);
    if (revision !== undefined) this.bind(file.inode, revision.documentId);
  }

  private bind(inode: number, documentId: string): void {
    this.bound.set(inode, documentId);
    const ever = this.everBound.get(inode) ?? new Set<string>();
    ever.add(documentId);
    this.everBound.set(inode, ever);
  }

  /**
   * Runs a pull or push (`call` reads `this.engine`, so it reaches the
   * current incarnation); a live engine's rejection is recorded. A crash
   * restarts the engine, which runs the interrupted call again, as the plugin
   * syncs when it starts.
   */
  private async run(call: () => Promise<unknown>): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await call();
      } catch (error) {
        if (!this.life.dead && !(error instanceof Crash)) this.errors.push(error);
      }
      const crashed = this.life.dead;
      await this.settle();
      if (!crashed) return;
    }
  }

  private async settle(): Promise<void> {
    try {
      await this.engine.settled();
    } catch (error) {
      if (!this.life.dead && !(error instanceof Crash)) this.errors.push(error);
    }
    this.scan();
    if (this.life.dead) {
      this.crashes++;
      this.engine.dispose();
      this.life = new Lifeline();
      this.engine = this.createEngine();
    }
  }

  private retained(): Revision[] {
    const revisions: Revision[] = [];
    for (let seq = 1n; seq <= this.server.currentHeadSeq; seq++) {
      try {
        revisions.push(this.server.revisionAt(seq));
      } catch {
        // Purged.
      }
    }
    return revisions;
  }

  /** Records the revisions the server gained since the last scan, and checks device A's against P1 and P2. */
  private scan(): void {
    for (const revision of this.retained()) {
      if (revision.seq <= this.scanned) continue;
      this.scanned = revision.seq;
      const observed: ObservedRevision = {
        seq: revision.seq,
        revisionId: revision.id,
        documentId: revision.documentId,
        parentRevisionId: revision.parentRevId,
        path: new TextDecoder().decode(revision.path),
        deleted: revision.deleted,
        hash: bytesToHex(revision.contentRef?.blobId ?? new Uint8Array()),
        deviceId: revision.deviceId,
        step: this.step,
      };
      const parent = observed.parentRevisionId === "" ? undefined : lastRevision(this.revisions, (candidate) => candidate.revisionId === observed.parentRevisionId);
      this.revisions.push(observed);
      this.everOnServer.add(observed.hash);
      if (observed.deviceId === testDeviceId) this.checkCommit(observed, parent);
    }
  }

  private violation(property: PropertyId, message: string): void {
    this.violations.push({ property, step: this.step, message });
  }

  private describe(hash: string): string {
    const origin = this.origins.get(hash);
    if (origin === undefined) return `content ${hash.slice(0, 8)} of no known origin`;
    return origin.kind === "user" ? `user write of step ${String(origin.step)} into inode ${String(origin.inode)}` : `remote write of step ${String(origin.step)} to ${origin.documentId}`;
  }

  /** P1 (INV-3, PO-1) and P2 (INV-5/6, PO-6/7) for one of device A's revisions. */
  private checkCommit(revision: ObservedRevision, parent: ObservedRevision | undefined): void {
    const name = `${revision.documentId} at ${JSON.stringify(revision.path)} (seq ${String(revision.seq)})`;
    const origin = this.origins.get(revision.hash);
    if (revision.deleted) {
      if (parent === undefined || parent.deleted) return;
      // P2, tombstone provenance: the user deleted a file bound to the document.
      const deletedByUser = [...this.userDeleted].some((inode) => this.everBound.get(inode)?.has(revision.documentId) === true);
      if (!deletedByUser) this.violation("P2", `tombstone of ${name} without the user deleting its file`);
      return;
    }
    const holder = this.inodes.at(revision.path);
    if (parent === undefined) {
      // P1 on a create: another document's content, or file, never becomes a new document.
      if (origin?.kind === "remote" && origin.documentId !== revision.documentId) this.violation("P1", `create of ${name} carries the ${this.describe(revision.hash)}`);
      const owner = holder?.hash === revision.hash ? this.bound.get(holder.inode) : undefined;
      if (holder !== undefined && owner !== undefined && owner !== revision.documentId) this.violation("P1", `create of ${name} from inode ${String(holder.inode)}, bound to ${owner}`);
      if (holder?.hash === revision.hash) this.bind(holder.inode, revision.documentId);
      else if (origin?.kind === "user") this.bind(origin.inode, revision.documentId);
      return;
    }
    if (parent.deleted) {
      // P2, resurrection provenance: the user created, edited or renamed the bytes since the document was last live.
      const lastLive = lastRevision(this.revisions, (candidate) => candidate.documentId === revision.documentId && !candidate.deleted && candidate.seq < parent.seq);
      const since = lastLive?.step ?? -1;
      const inodes = new Set(this.inodes.all().flatMap((file) => (file.hash === revision.hash ? [file.inode] : [])));
      if (origin?.kind === "user") inodes.add(origin.inode);

      // Or a local change that wins over the delete (PO-7, §4.7), made
      // before the last live revision of another device that did not have
      // it: the user's write into an inode bound to the document whose
      // content no server revision of the document carried, or the user's
      // rename of such an inode to a path no server revision of the
      // document had (the engine may have moved it on since, PO-4). A write into an untracked
      // inode at the path the revision commits counts too: PO-13 adopts such
      // a file at the tombstone's path (E5, INV-6). Inode-exact (§5.5 X-10).
      const earlier = this.revisions.filter((candidate) => candidate.documentId === revision.documentId && candidate.seq < revision.seq);
      const carried = new Set(earlier.map((candidate) => candidate.hash));
      const named = new Set(earlier.map((candidate) => candidate.path));
      const ownInode = (inode: number) => this.everBound.get(inode)?.has(revision.documentId) === true;
      // The user created, edited or renamed the bytes since the document was
      // last live: in the document's own file, or in the file at the path
      // the revision commits (an untracked file it adopts, PO-13).
      const touched = this.userOperations.some(
        (operation) => operation.type !== "delete" && operation.step > since && inodes.has(operation.inode) && (ownInode(operation.inode) || this.inodes.at(revision.path)?.inode === operation.inode),
      );
      const unsynced = this.userOperations.some(
        (operation) =>
          inodes.has(operation.inode) &&
          (((operation.type === "create" || operation.type === "edit") && operation.hash === revision.hash && !carried.has(operation.hash) && (ownInode(operation.inode) || (this.bound.get(operation.inode) === undefined && this.inodes.at(revision.path)?.inode === operation.inode))) ||
            (operation.type === "rename" && operation.path !== undefined && !named.has(operation.path) && ownInode(operation.inode))),
      );
      if (!touched && !unsynced) this.violation("P2", `live revision of ${name} on its tombstone without a user change since step ${String(since)}`);
      if (holder?.hash === revision.hash) this.bind(holder.inode, revision.documentId);
      return;
    }
    if (parent.hash === revision.hash || origin === undefined) return;
    // P1 on an edit: the content comes from the document's own file.
    if (origin.kind === "remote" && origin.documentId !== revision.documentId) this.violation("P1", `edit of ${name} carries the ${this.describe(revision.hash)}`);
    const owner = origin.kind === "user" ? this.bound.get(origin.inode) : undefined;
    if (owner !== undefined && owner !== revision.documentId) this.violation("P1", `edit of ${name} carries the ${this.describe(revision.hash)}, an inode bound to ${owner}`);
  }

  /** P3 (INV-1, INV-2) at a durable point: no two documents' newest server claims, and no two live outboxes, collide under the path key. */
  private async checkExclusivity(): Promise<void> {
    this.collisions("live documents", await newestServerClaims(this.journal));
    const outbox = new Map<string, PendingOperation>();
    for (const operation of await this.journal.listPending()) outbox.set(operation.documentId, operation);
    this.collisions(
      "live outboxes",
      [...outbox.values()].filter((operation) => !operation.deleted).map((operation) => [operation.documentId, operation.path]),
    );
  }

  private collisions(what: string, claims: [string, string][]): void {
    const byKey = new Map<string, string>();
    for (const [documentId, path] of claims) {
      const key = pathKey(path);
      const other = byKey.get(key);
      if (other !== undefined) this.violation("P3", `${what} ${other} and ${documentId}@${JSON.stringify(path)} collide under K`);
      else byKey.set(key, `${documentId}@${JSON.stringify(path)}`);
    }
  }

  private async fingerprint(): Promise<string> {
    return JSON.stringify({ head: String(this.server.currentHeadSeq), files: [...(await files(this.vault))] });
  }
}
