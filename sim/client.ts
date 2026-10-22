// Scripted protocol clients for Phase 1 of the simulation (SPEC.md §13, §15).
// They are not the sync engine. They create, edit, rename, delete and pull
// through the public API only, with the protocol's commit discipline (§6.2):
// optimistic concurrency against the head they know, a retry with the same
// revision id after a lost response, a retry on the new head after
// FAILED_PRECONDITION, and a conflict path after ALREADY_EXISTS (§6.3).
//
// Everything a client knows lives in memory and is lost when it crashes. What
// the server acknowledged is recorded by the harness (RunContext), not the
// client, so the invariant checks can use it after a crash.

import { Code, ConnectError } from "@connectrpc/connect";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { ProtocolClient } from "../plugin/src/core/protocol/client";
import { DocumentKind, DocumentSchema, type Revision } from "../plugin/src/gen/vaultsync/v1/types_pb";
import type { Ids } from "./ids";
import { errorCode, type SimNetwork } from "./network";
import { Random } from "./random";
import type { Operation } from "./schedule";

/** A revision the server acknowledged to a client (CommitRevision returned it). */
export interface Acknowledgement {
  client: number;
  revisionId: string;
  documentId: string;
  /** Decimal string: protobuf uint64 values are bigints, which JSON cannot carry. */
  seq: string;
  /** Empty for a document's first revision. */
  parentRevisionId: string;
  path: string;
  deleted: boolean;
  blobId: string;
  size: string;
}

/** A broken invariant or protocol guarantee. */
export interface Violation {
  invariant: string;
  detail: string;
}

/** State shared by every client of one run. */
export interface RunContext {
  vaultId: string;
  ids: Ids;
  network: SimNetwork;
  acknowledged: Acknowledgement[];
  violations: Violation[];
  /** Appends a trace entry. */
  log: (entry: string) => void;
  /** The trace so far, for a failure that cannot wait for the run's result. */
  trace: readonly string[];
  /** The schedule step being executed. */
  stepNumber: () => number;
  /**
   * The server's head seq as far as the harness knows it: the highest seq a
   * CommitRevision or ListChanges reply has carried. It is a lower bound,
   * not exact: a commit whose reply was lost moves the head unseen until the
   * next reply that shows it. SimRun.finish() checks that it equals the feed
   * head at the end of a run (`server-seq`), so the plumbing cannot lag
   * unnoticed.
   */
  serverSeq: () => bigint;
  /**
   * The seqs of the revisions retention purged during the run (SPEC.md
   * §11): the only seqs the change feed may skip.
   */
  purgedSeqs: ReadonlySet<bigint>;
  /** The ids of the revisions retention purged during the run. */
  purgedRevisions: ReadonlySet<string>;
  /** The paths the clients and the engines' users choose from: pathPool, or faithfulPathPool with the faithful filesystem. */
  pathPool: readonly string[];
  /**
   * Whether `client`'s user can lose access to the vault during the run: a
   * member other than the owner in a run with membership changes (#35,
   * Members). Its client takes PERMISSION_DENIED and NOT_FOUND as the
   * server refusing it access and gives the operation up; the runner checks
   * each refusal against the user's role (Members.check). Unset: no client.
   */
  mayLoseAccess?: (client: number) => boolean;
  /**
   * How many times the run has restored the database to a backup (#650).
   * A client accepts a diverged server, or a lost commit, only if this
   * moved since its last complete pull.
   */
  restores: () => number;
  /**
   * The revisions restores removed, by id, with the seq they had (#650,
   * docs/design/engine-path-ownership.md §5.5 X-23, X-24).
   */
  restoredAway: ReadonlyMap<string, string>;
}

/**
 * Paths clients choose from. Several collide once normalized (§5), so creates and renames race for path keys, and the
 * file `NOTES` names the folder of the `notes/` documents, so they race as file and folder. The last three are names
 * Windows cannot hold (a reserved device name, a colon, a trailing dot), so an engine under Windows rules tracks their
 * documents as unmaterializable until they are renamed away (SPEC.md §8).
 */
export const pathPool = ["a.md", "A.md", "b.md", "notes/c.md", "Notes/C.md", "straße.md", "STRASSE.md", "d.md", "e.md", "notes/f.md", "NOTES", "CON.md", "ab:c.md", "trailing."] as const;

/**
 * pathPool plus the spellings where the server's path key and the device's
 * filesystem disagree (docs/design/engine-path-ownership.md §3.1), for runs
 * with the faithful filesystem (RunOptions.faithfulFilesystem): `Straße.md`
 * (one key with `straße.md` and `STRASSE.md`, but under Windows and macOS
 * rules one file with `straße.md` only), `Café.md` in NFC and in NFD (one key;
 * one file under macOS rules, two under Windows rules), and `ı.md` and `I.md`
 * (two keys, but one file under Windows and macOS rules). Appended, so the
 * paths of pathPool keep their indices.
 */
export const faithfulPathPool: readonly string[] = [...pathPool, "Straße.md", "Café.md", "Café.md", "ı.md", "I.md"];

/** Shared contents, so clients upload identical blobs (and share upload sessions). */
const sharedContents = 6;
/** Size of the occasional large content: spans several chunks at the sim server's 64 KiB chunk size. */
const largeContentBytes = 150 * 1024;
/** Attempts for one commit after transient (network) failures, retrying the same revision id. */
const maxTransientRetries = 4;
/** Commits with a new revision id after FAILED_PRECONDITION or ALREADY_EXISTS. */
const maxConflictRetries = 4;
/** Attempts to upload one blob. */
const maxUploadAttempts = 4;
/** Revisions per ListChanges page; small, so pulls page. */
const pageSize = 7;
/** Bound on pages per pull. */
const maxPages = 1000;

interface KnownDocument {
  id: string;
  head: string;
  /** The kind the server reports; it never changes (SPEC.md §7), so every later commit must carry it. */
  kind: DocumentKind;
  path: string;
  deleted: boolean;
  blobId: Uint8Array;
  size: bigint;
}

interface Content {
  bytes: Uint8Array;
  blobId: Uint8Array;
  name: string;
}

interface CommitFields {
  documentId: string;
  baseRevisionId: string;
  /** TEXT for a create; the document's own kind otherwise, which is BLOB for an engine document at a path without a text extension. */
  kind: DocumentKind;
  path: string;
  deleted: boolean;
  content: { blobId: Uint8Array; size: bigint };
}

type CommitResult = { status: "ok"; revision: Revision } | { status: "rejected"; error: ConnectError } | { status: "gave-up" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ScriptedClient {
  private busy = false;
  /** Whether the client has pulled since it (re)started; it pulls before doing anything else. */
  private synced = false;
  private cursor = 0n;
  /** The anchor of the revision at the cursor (Revision.anchor), sent as since_anchor so a restored server reports divergence (SPEC.md §6.1). */
  private cursorAnchor: Uint8Array = new Uint8Array();
  /** The client's latest acknowledged commit above the cursor, sent as own_commit_seq and own_commit_anchor (SPEC.md §6.1). */
  private ownCommit: { seq: bigint; anchor: Uint8Array } | undefined;
  /**
   * The client's acknowledged commits the feed has not delivered yet, by
   * revision id, with their seq. After a complete pull, one at or below the
   * cursor, or above the head, is a commit the server lost: only a restore
   * does that (SPEC.md §8), and the client then pulls everything again.
   */
  private unconfirmed = new Map<string, bigint>();
  /** The run's restores and purges as of this client's last complete pull (or its start): a divergence needs one since. */
  private historyEvents = { restores: 0, purges: 0 };
  private documents = new Map<string, KnownDocument>();
  private contentCounter = 0;

  constructor(
    readonly index: number,
    private readonly api: ProtocolClient,
    readonly deviceId: string,
    private readonly context: RunContext,
  ) {}

  get name(): string {
    return `c${String(this.index)}`;
  }

  get idle(): boolean {
    return !this.busy;
  }

  /** Starts `operation` unless the client is busy; returns the trace entry. */
  start(operation: Operation, arg: number): string {
    if (this.busy) return `${this.name} busy, ${operation} skipped`;
    const actual = this.synced ? operation : "pull";
    const incarnation = this.context.network.incarnation(this.index);
    this.busy = true;
    void this.run(actual, new Random(arg)).finally(() => {
      // An operation of a crashed incarnation never completes (its replies
      // are never delivered), but guard anyway.
      if (this.context.network.incarnation(this.index) === incarnation) this.busy = false;
    });
    return `${this.name} starts ${actual}${actual === operation ? "" : ` (instead of ${operation}: not synced since start)`}`;
  }

  /** Loses every in-memory state, as a killed app would. */
  crash(): void {
    this.context.network.crash(this.index);
    this.busy = false;
    this.synced = false;
    this.forget();
  }

  /** Whether the run restored the database since this client's last complete pull. */
  private restoredSincePull(): boolean {
    return this.context.restores() > this.historyEvents.restores;
  }

  /** Forgets what the client pulled, as on a restart or a resync after the server diverged. */
  private forget(): void {
    this.cursor = 0n;
    this.cursorAnchor = new Uint8Array();
    this.ownCommit = undefined;
    this.unconfirmed = new Map();
    this.historyEvents = { restores: 0, purges: 0 };
    this.documents = new Map();
  }

  private async run(operation: Operation, random: Random): Promise<void> {
    switch (operation) {
      case "create":
        return this.create(random);
      case "edit":
        return this.edit(random);
      case "rename":
        return this.rename(random);
      case "delete":
        return this.remove(random);
      case "pull":
        return this.pull();
    }
  }

  private async create(random: Random): Promise<void> {
    const content = this.content(random);
    if (!(await this.upload(content))) return;
    const documentId = this.context.ids.generate(`${this.name}.d`);
    await this.commitWithRetries("create", { documentId, baseRevisionId: "", kind: DocumentKind.TEXT, path: random.pick(this.context.pathPool), deleted: false, content: contentRef(content) });
  }

  private async edit(random: Random): Promise<void> {
    const document = this.pickDocument(random, false);
    if (document === undefined) {
      this.context.log(`${this.name} edit: no known document`);
      return;
    }
    const content = this.content(random);
    if (!(await this.upload(content))) return;
    await this.commitWithRetries("edit", {
      documentId: document.id,
      baseRevisionId: document.head,
      kind: document.kind,
      path: document.path,
      deleted: false,
      content: contentRef(content),
    });
  }

  private async rename(random: Random): Promise<void> {
    const document = this.pickDocument(random, true);
    if (document === undefined) {
      this.context.log(`${this.name} rename: no known live document`);
      return;
    }
    const path = random.pick(this.context.pathPool);
    await this.commitWithRetries("rename", {
      documentId: document.id,
      baseRevisionId: document.head,
      kind: document.kind,
      path,
      deleted: false,
      content: { blobId: document.blobId, size: document.size },
    });
  }

  private async remove(random: Random): Promise<void> {
    const document = this.pickDocument(random, true);
    if (document === undefined) {
      this.context.log(`${this.name} delete: no known live document`);
      return;
    }
    await this.commitWithRetries("delete", {
      documentId: document.id,
      baseRevisionId: document.head,
      kind: document.kind,
      path: document.path,
      deleted: true,
      content: { blobId: document.blobId, size: document.size },
    });
  }

  /** Every document this client knows of, with the head it last learned: after a full pull, every document's current head. */
  knownHeads(): Record<string, string> {
    return Object.fromEntries([...this.documents.values()].map((document) => [document.id, document.head]));
  }

  /**
   * Pulls every change since the cursor (§6.1), checking that the feed is
   * strictly ascending and skips no seq but those of purged revisions (§11).
   * That it delivers every document's head is checked after quiescence
   * against the database (SimRun.finish).
   */
  private async pull(): Promise<void> {
    for (let page = 0; page < maxPages; page++) {
      let response;
      try {
        const own = this.ownCommit !== undefined && this.ownCommit.seq > this.cursor ? { ownCommitSeq: this.ownCommit.seq, ownCommitAnchor: this.ownCommit.anchor } : {};
        response = await this.api.sync.listChanges({ vaultId: this.context.vaultId, sinceSeq: this.cursor, sinceAnchor: this.cursorAnchor, pageSize, ...own });
      } catch (error) {
        if (!this.accessRefused(error)) this.unexpectedUnless(error, "ListChanges", [Code.Unavailable]);
        this.context.log(`${this.name} pull interrupted: ${Code[errorCode(error)]}`);
        return;
      }
      if (response.diverged) {
        // The server lost revisions this client saw (a restored backup, SPEC.md §6.1, §8): pull everything again.
        this.context.log(`${this.name} resyncs: the server diverged from seq ${String(this.cursor)}`);
        // Retention may also lose the revision at the cursor once its purge marker is pruned (§11).
        if (!this.restoredSincePull() && this.context.purgedSeqs.size === this.historyEvents.purges) this.violation("seq", `${this.name} was told the server diverged from seq ${String(this.cursor)}, although it was neither restored nor purged since its last complete pull`);
        this.forget();
        continue;
      }
      for (const revision of response.revisions) {
        if (revision.seq <= this.cursor) {
          this.violation("seq", `${this.name} pulled seq ${String(revision.seq)} right after seq ${String(this.cursor)}`);
        }
        for (let skipped = this.cursor + 1n; skipped < revision.seq; skipped++) {
          if (this.context.purgedSeqs.has(skipped)) continue;
          this.violation("seq", `${this.name} pulled seq ${String(revision.seq)} right after seq ${String(this.cursor)}, skipping seq ${String(skipped)}, which retention did not purge`);
          break;
        }
        this.cursor = revision.seq;
        this.cursorAnchor = revision.anchor;
        this.unconfirmed.delete(revision.id);
        this.learn(revision);
      }
      if (response.headSeq < this.cursor) {
        this.violation("seq", `${this.name} pulled seq ${String(this.cursor)} beyond head_seq ${String(response.headSeq)}`);
      }
      if (!response.hasMore) {
        // One retention purged is not lost: the feed skips it (§11).
        const lost = [...this.unconfirmed].find(([id, seq]) => !this.context.purgedRevisions.has(id) && (seq <= this.cursor || seq > response.headSeq));
        if (lost !== undefined) {
          // The feed passed (or never reached) one of this client's acknowledged commits without delivering it.
          this.context.log(`${this.name} resyncs: the server lost its commit ${this.context.ids.label(lost[0])} at seq ${String(lost[1])}`);
          if (this.context.restoredAway.get(lost[0]) !== String(lost[1])) this.violation("seq", `${this.name}'s acknowledged commit ${this.context.ids.label(lost[0])} at seq ${String(lost[1])} is not in the feed, although no restore removed it`);
          this.forget();
          continue;
        }
        this.synced = true;
        this.historyEvents = { restores: this.context.restores(), purges: this.context.purgedSeqs.size };
        this.context.log(`${this.name} pulled up to seq ${String(this.cursor)}`);
        return;
      }
    }
    this.violation("seq", `${this.name} pull did not finish within ${String(maxPages)} pages`);
  }

  /**
   * Commits `fields` as a new revision. On FAILED_PRECONDITION it rebases onto
   * the head the error reports and on ALREADY_EXISTS it moves to a conflict
   * path, each time with a new revision id.
   */
  private async commitWithRetries(operation: string, initial: CommitFields): Promise<void> {
    let fields = initial;
    const document = this.context.ids.label(fields.documentId);
    for (let attempt = 0; attempt <= maxConflictRetries; attempt++) {
      const revisionId = this.context.ids.generate(`${this.name}.r`);
      const result = await this.commit(revisionId, fields);
      if (result.status === "ok") {
        this.context.log(`${this.name} ${operation} ${document} acknowledged ${this.context.ids.label(revisionId)} seq=${String(result.revision.seq)}`);
        return;
      }
      if (result.status === "gave-up") {
        this.context.log(`${this.name} ${operation} ${document} gave up after network failures`);
        return;
      }
      const { error } = result;
      if (error.code === Code.FailedPrecondition && fields.baseRevisionId !== "") {
        const head = error.findDetails(DocumentSchema)[0]?.headRevId;
        if ((head === undefined || head === "") && this.context.restoredAway.has(fields.baseRevisionId)) {
          // A restore removed the document (SPEC.md §8): it is gone from the server, as is what this client knew of it.
          // X-24 (docs/design/engine-path-ownership.md §5.5): only for a base a restore removed.
          this.context.log(`${this.name} ${operation} ${document}: the document is gone after a restore, giving up`);
          return;
        }
        if (head === undefined || head === "") {
          this.violation("protocol", `FAILED_PRECONDITION for ${document} carried no Document detail with the head`);
          return;
        }
        if (head === revisionId) {
          this.violation("protocol", `retry of ${this.context.ids.label(revisionId)} was rejected as stale although it is the head`);
          return;
        }
        this.context.log(`${this.name} ${operation} ${document}: head moved to ${this.context.ids.label(head)}, rebasing`);
        fields = { ...fields, baseRevisionId: head };
        continue;
      }
      if (error.code === Code.AlreadyExists && !fields.deleted) {
        const path = conflictPath(fields.path, this.name, attempt);
        this.context.log(`${this.name} ${operation} ${document}: path taken, retrying as "${path}"`);
        fields = { ...fields, path };
        continue;
      }
      if (this.accessRefused(error)) {
        this.context.log(`${this.name} ${operation} ${document} refused: ${Code[error.code]}`);
        return;
      }
      this.unexpected(error, `CommitRevision for ${operation} of ${document}`);
      return;
    }
    this.context.log(`${this.name} ${operation} ${document} gave up after ${String(maxConflictRetries + 1)} conflicts`);
  }

  /** One revision id, retried with identical fields after network failures (§6.2: a lost response must not become a conflict). */
  private async commit(revisionId: string, fields: CommitFields): Promise<CommitResult> {
    for (let attempt = 0; attempt < maxTransientRetries; attempt++) {
      try {
        const response = await this.api.sync.commitRevision({
          vaultId: this.context.vaultId,
          documentId: fields.documentId,
          revisionId,
          baseRevId: fields.baseRevisionId,
          kind: fields.kind,
          contentRef: fields.content,
          path: encoder.encode(fields.path),
          deleted: fields.deleted,
          deviceId: this.deviceId,
        });
        const revision = response.revision;
        if (revision === undefined) {
          this.violation("protocol", `CommitRevision for ${this.context.ids.label(revisionId)} returned no revision`);
          return { status: "gave-up" };
        }
        this.acknowledge(revision, fields);
        return { status: "ok", revision };
      } catch (error) {
        if (errorCode(error) !== Code.Unavailable) return { status: "rejected", error: ConnectError.from(error) };
        this.context.log(`${this.name} retries ${this.context.ids.label(revisionId)} after a network failure`);
      }
    }
    return { status: "gave-up" };
  }

  private acknowledge(revision: Revision, fields: CommitFields): void {
    const label = this.context.ids.label(revision.id);
    // A retry whose base retention purged since gets the re-parented revision back (SPEC.md §6.2, §11).
    const parentMatches = revision.parentRevId === fields.baseRevisionId || (this.context.purgedRevisions.has(fields.baseRevisionId) && !this.context.purgedRevisions.has(revision.parentRevId));
    if (revision.documentId !== fields.documentId || !parentMatches || revision.deleted !== fields.deleted) {
      this.violation("protocol", `acknowledged ${label} differs from the commit request`);
    }
    // A document's kind never changes (SPEC.md §7): the server refuses a commit of another kind, never acknowledges it as one (#317).
    if (revision.kind !== fields.kind) {
      this.violation("protocol", `acknowledged ${label} has kind ${DocumentKind[revision.kind]}, but the commit request had ${DocumentKind[fields.kind]}`);
    }
    this.context.acknowledged.push({
      client: this.index,
      revisionId: revision.id,
      documentId: revision.documentId,
      seq: String(revision.seq),
      parentRevisionId: revision.parentRevId,
      path: decoder.decode(revision.path),
      deleted: revision.deleted,
      blobId: bytesToHex(revision.contentRef?.blobId ?? new Uint8Array()),
      size: String(revision.contentRef?.size ?? 0n),
    });
    if (revision.seq > (this.ownCommit?.seq ?? 0n)) this.ownCommit = { seq: revision.seq, anchor: revision.anchor };
    if (revision.seq > this.cursor) this.unconfirmed.set(revision.id, revision.seq);
    this.learn(revision);
  }

  /** Uploads content (§6.2 step 1), resuming from BeginBlob after any interruption. Returns whether the blob is complete. */
  private async upload(content: Content): Promise<boolean> {
    const size = BigInt(content.bytes.length);
    const base = { vaultId: this.context.vaultId, blobId: content.blobId };
    for (let attempt = 0; attempt < maxUploadAttempts; attempt++) {
      let step = "BeginBlob";
      try {
        const begin = await this.api.blobs.beginBlob({ ...base, size });
        if (begin.complete) return true;
        let offset = begin.receivedSize;
        while (offset < size) {
          step = "PutBlobChunk";
          const end = Math.min(content.bytes.length, Number(offset) + begin.maxChunkSize);
          const put = await this.api.blobs.putBlobChunk({ ...base, offset, data: content.bytes.subarray(Number(offset), end) });
          offset = put.receivedSize;
        }
        step = "CommitBlob";
        await this.api.blobs.commitBlob(base);
        return true;
      } catch (error) {
        // Another client uploading the same blob can advance or finish the
        // shared session: resume from BeginBlob.
        const retryable = step === "BeginBlob" ? [Code.Unavailable] : [Code.Unavailable, Code.FailedPrecondition, Code.NotFound];
        if (this.accessRefused(error) && (step === "BeginBlob" || errorCode(error) === Code.PermissionDenied)) {
          this.context.log(`${this.name} upload of ${content.name} refused at ${step}: ${Code[errorCode(error)]}`);
          return false;
        }
        if (!retryable.includes(errorCode(error))) {
          this.unexpected(error, `${step} of ${content.name}`);
          return false;
        }
        this.context.log(`${this.name} upload of ${content.name} interrupted at ${step}: ${Code[errorCode(error)]}`);
      }
    }
    this.context.log(`${this.name} gave up uploading ${content.name}`);
    return false;
  }

  /** Content for a create or edit: often shared between clients, sometimes large. */
  private content(random: Random): Content {
    let text: string;
    if (random.chance(0.4)) {
      text = `shared content ${String(random.int(sharedContents))}\n`;
    } else {
      this.contentCounter++;
      text = `${this.name} content ${String(this.contentCounter)} ${String(random.uint32())}\n`;
    }
    let bytes = encoder.encode(text);
    if (random.chance(0.05)) {
      const large = new Uint8Array(largeContentBytes);
      for (let offset = 0; offset < large.length; offset += bytes.length) large.set(bytes.subarray(0, large.length - offset), offset);
      bytes = large;
    }
    const blobId = sha256(bytes);
    return { bytes, blobId, name: `blob ${bytesToHex(blobId).slice(0, 8)} (${String(bytes.length)} B)` };
  }

  /** A known document, chosen by label so the choice does not depend on random ids. */
  private pickDocument(random: Random, liveOnly: boolean): KnownDocument | undefined {
    const candidates = [...this.documents.values()]
      .filter((document) => !liveOnly || !document.deleted)
      .sort((left, right) => compareLabels(this.context.ids.label(left.id), this.context.ids.label(right.id)));
    return candidates.length === 0 ? undefined : random.pick(candidates);
  }

  private learn(revision: Revision): void {
    this.documents.set(revision.documentId, {
      id: revision.documentId,
      head: revision.id,
      kind: revision.kind,
      path: decoder.decode(revision.path),
      deleted: revision.deleted,
      blobId: revision.contentRef?.blobId ?? new Uint8Array(),
      size: revision.contentRef?.size ?? 0n,
    });
  }

  /** Whether `error` is the server refusing this client access (a viewer's write, or any call once its user was removed). */
  private accessRefused(error: unknown): boolean {
    const code = errorCode(error);
    return (code === Code.PermissionDenied || code === Code.NotFound) && this.context.mayLoseAccess?.(this.index) === true;
  }

  private unexpectedUnless(error: unknown, call: string, expected: readonly Code[]): void {
    if (!expected.includes(errorCode(error))) this.unexpected(error, call);
  }

  private unexpected(error: unknown, call: string): void {
    const connectError = ConnectError.from(error);
    this.violation("protocol", `${this.name} ${call} failed with ${Code[connectError.code]}: ${connectError.rawMessage}`);
  }

  private violation(invariant: string, detail: string): void {
    this.context.violations.push({ invariant, detail });
    this.context.log(`VIOLATION ${invariant}: ${detail}`);
  }
}

function contentRef(content: Content): { blobId: Uint8Array; size: bigint } {
  return { blobId: content.blobId, size: BigInt(content.bytes.length) };
}

/** `<name> (conflict <client> <n>).<ext>`, the shape of §6.3's conflict copies. */
export function conflictPath(path: string, client: string, attempt: number): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const [stem, extension] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  return `${stem} (conflict ${client} ${String(attempt + 1)})${extension}`;
}

/** Orders labels like c0.d2 < c0.d10 < c1.d1. */
function compareLabels(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}
