// The verified core's transport (#1044, the fourth part of #952;
// docs/design/verified-core.md §2.3, §4; plugin/verified/spec/Contracts.dfy
// `Diverged`, `ShellRun`). `CoreTransport` pulls the feed after a journal's
// cursor and commits an outbox over the server's API (SPEC.md §6.1, §6.2),
// and tells a diverged device from one that only lags. `ShellSync` runs the
// core's sync steps on it so that a device a restore diverged resyncs before
// its next round and before its next pulled revision, as `ShellRun` requires.
//
// The transport makes no sync decision: what a round, a resync, a pulled
// revision or a push result does to the journal and the disk is the core's
// (`SyncCore`), which the switch-over (#1046) backs with the compiled steps.

import { Code, ConnectError } from "@connectrpc/connect";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { DocumentKind, type Revision } from "../gen/vaultsync/v1/types_pb";
import { headMoved } from "../core/engine/errors";
import type { PullApi } from "../core/engine/remote";
import { uploadContent } from "../core/engine/upload";
import { emptyJournal, type CoreJournal, type CoreOutbox, type CoreRevision, type Kind } from "./journal-store";

/** One feed entry: the revision as the core sees it, and the server's anchor of it (SPEC.md §6.1). */
export interface FeedEntry {
  revision: CoreRevision;
  anchor: Uint8Array;
}

/**
 * A pull's result. `feed`: the entries after the cursor, in feed order.
 * `diverged`: a restore lost history the journal names (`Diverged`), so no
 * entry may reach the core before its resync.
 */
export type Pull = { kind: "feed"; entries: FeedEntry[] } | { kind: "diverged"; reason: DivergenceReason };

/**
 * Why the device is `Diverged` (Contracts.dfy): the server's anchor check
 * failed (the cursor's entry is gone, or the feed was cut and grew back:
 * `AnchorOnFeed`), its head is below the cursor (the cursor is past the
 * restored feed), or a revision the journal names above the cursor is gone
 * (`JournalOnServer`; an own acknowledged commit, SPEC.md §6.1 #261).
 */
export type DivergenceReason = "anchor" | "head-below-cursor" | "named-revision-lost";

/** A push result event (§2.3): the server's answer to one commit. */
export type PushResult =
  | { kind: "accepted"; entry: FeedEntry }
  | { kind: "head-moved" }
  | { kind: "already-exists" }
  | { kind: "invalid-argument" }
  | { kind: "unavailable" };

/** Reads the content an outbox names (its hash), for the upload; null if the vault no longer has it. */
export type ContentReader = (doc: string, outbox: CoreOutbox) => Promise<Uint8Array | null>;

export interface CoreTransportOptions {
  api: PullApi;
  vaultId: string;
  /** This device, recorded with every commit (SPEC.md §6.2). */
  deviceId: string;
  readContent: ContentReader;
  /** ListChanges page size; the server's default if 0 or unset. */
  pageSize?: number;
}

/** The server sent a revision the core cannot represent. */
export class TransportError extends Error {
  override readonly name = "TransportError";
}

/** Reads of the whole feed a resync makes before it gives up on a feed restored meanwhile. */
const maxFeedAttempts = 3;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export class CoreTransport {
  private readonly api: PullApi;
  private readonly vaultId: string;
  private readonly deviceId: string;
  private readonly readContent: ContentReader;
  private readonly pageSize: number;

  constructor(options: CoreTransportOptions) {
    this.api = options.api;
    this.vaultId = options.vaultId;
    this.deviceId = options.deviceId;
    this.readContent = options.readContent;
    this.pageSize = options.pageSize ?? 0;
  }

  /**
   * The feed after the journal's cursor, or `diverged`. Every page is
   * checked against the journal's anchor; the whole feed past the cursor is
   * read before anything is returned, so a revision the journal names above
   * its cursor is checked before any entry reaches the core.
   */
  async pull(journal: CoreJournal): Promise<Pull> {
    // Each page is anchored at the entry before it: the cursor's, then the
    // last one read, so a restore between two pages is caught too.
    let anchor = journal.cursor > 0n && journal.anchor !== null ? journal.anchor : new Uint8Array();
    const entries: FeedEntry[] = [];
    let since = journal.cursor;
    for (;;) {
      const response = await this.api.sync.listChanges({ vaultId: this.vaultId, sinceSeq: since, pageSize: this.pageSize, sinceAnchor: anchor });
      if (response.headSeq < journal.cursor) return { kind: "diverged", reason: "head-below-cursor" };
      if (response.diverged) return { kind: "diverged", reason: "anchor" };
      for (const revision of response.revisions) {
        if (revision.seq <= since) throw new TransportError(`ListChanges returned seq ${String(revision.seq)} after ${String(since)}`);
        const entry = feedEntry(revision);
        entries.push(entry);
        since = revision.seq;
        anchor = entry.anchor;
      }
      if (!response.hasMore || response.revisions.length === 0) {
        if (namedRevisionLost(journal, entries, response.headSeq)) return { kind: "diverged", reason: "named-revision-lost" };
        return { kind: "feed", entries };
      }
    }
  }

  /** The whole feed, from its start, for a resync: the server the core re-anchors the journal on. */
  async feed(): Promise<FeedEntry[]> {
    // Read again if a restore cut the feed between two of its pages.
    for (let attempt = 1; ; attempt++) {
      const pull = await this.pull(emptyJournal());
      if (pull.kind === "feed") return pull.entries;
      if (attempt >= maxFeedAttempts) throw new TransportError("the feed was restored while it was read");
    }
  }

  /**
   * Commits one outbox (SPEC.md §6.2): uploads its content unless it is a
   * delete, then sends CommitRevision with the outbox's fields, so a retry
   * of the same outbox is the same request. Any failure to reach the server
   * is `unavailable`; the core keeps the outbox and the next round retries.
   */
  async commit(doc: string, outbox: CoreOutbox): Promise<PushResult> {
    try {
      let size: bigint;
      if (outbox.deleted) {
        size = await this.headSize(doc, outbox);
      } else {
        const content = await this.readContent(doc, outbox);
        if (content === null) return { kind: "unavailable" };
        size = BigInt(content.length);
        if ((await uploadContent(this.api, this.vaultId, outbox.content, size, () => Promise.resolve(content))) === "missing") return { kind: "unavailable" };
      }
      const response = await this.api.sync.commitRevision({
        vaultId: this.vaultId,
        documentId: doc,
        revisionId: outbox.rev,
        baseRevId: outbox.baseRev ?? "",
        kind: kindValue(outbox.kind),
        contentRef: { blobId: hexToBytes(outbox.content), size },
        path: encoder.encode(outbox.path),
        deleted: outbox.deleted,
        deviceId: this.deviceId,
      });
      if (response.revision === undefined) throw new TransportError("CommitRevision returned no revision");
      return { kind: "accepted", entry: feedEntry(response.revision) };
    } catch (error) {
      return refusal(error);
    }
  }

  /** The size of the content a delete keeps: its base's, which the server holds. */
  private async headSize(doc: string, outbox: CoreOutbox): Promise<bigint> {
    if (outbox.baseRev === null) throw new ConnectError("a delete needs a base", Code.InvalidArgument);
    const response = await this.api.sync.getRevision({ vaultId: this.vaultId, revisionId: outbox.baseRev });
    return response.revision?.contentRef?.size ?? 0n;
  }
}

/**
 * Whether a revision the journal names above its cursor (a base or an ahead
 * revision; only an own acknowledged commit can be there) is gone: the
 * restored head is below it, or the feed holds another revision at its
 * position. A position the feed skips is a purge, which never diverges a
 * device (SPEC.md §6.1, §11). The journal keeps no anchor per commit, so the
 * check is by id, which a device never commits twice.
 */
function namedRevisionLost(journal: CoreJournal, entries: FeedEntry[], headSeq: bigint): boolean {
  const atPosition = new Map(entries.map((entry) => [entry.revision.position, entry.revision.id]));
  for (const document of Object.values(journal.documents)) {
    const named: { rev: string; position: bigint }[] = [];
    if (document.base !== null) named.push(document.base);
    if (document.ahead !== null) named.push({ rev: document.ahead.revision.id, position: document.ahead.revision.position });
    for (const { rev, position } of named) {
      if (position <= journal.cursor) continue;
      if (position > headSeq) return true;
      const id = atPosition.get(position);
      if (id !== undefined && id !== rev) return true;
    }
  }
  return false;
}

function refusal(error: unknown): PushResult {
  if (error instanceof TransportError) throw error;
  if (headMoved(error)) return { kind: "head-moved" };
  if (!(error instanceof ConnectError)) return { kind: "unavailable" };
  switch (error.code) {
    case Code.AlreadyExists:
      return { kind: "already-exists" };
    case Code.InvalidArgument:
      return { kind: "invalid-argument" };
    case Code.PermissionDenied:
    case Code.Unauthenticated:
    case Code.NotFound:
      throw error;
    default:
      return { kind: "unavailable" };
  }
}

function feedEntry(revision: Revision): FeedEntry {
  if (revision.contentRef === undefined) throw new TransportError(`revision ${revision.id} has no content`);
  let path: string;
  try {
    path = decoder.decode(revision.path);
  } catch {
    throw new TransportError(`revision ${revision.id} has a path that is not UTF-8`);
  }
  return {
    revision: {
      id: revision.id,
      doc: revision.documentId,
      position: revision.seq,
      parent: revision.parentRevId === "" ? null : revision.parentRevId,
      path,
      content: bytesToHex(revision.contentRef.blobId),
      kind: kindOf(revision),
      deleted: revision.deleted,
      device: revision.deviceId,
    },
    anchor: revision.anchor,
  };
}

function kindOf(revision: Revision): Kind {
  switch (revision.kind) {
    case DocumentKind.TEXT:
      return "note";
    case DocumentKind.BLOB:
      return "binary";
    default:
      throw new TransportError(`revision ${revision.id} has a kind the core has none for`);
  }
}

function kindValue(kind: Kind): DocumentKind {
  return kind === "note" ? DocumentKind.TEXT : DocumentKind.BLOB;
}

/** A commit the core requests in a round (its sealed outboxes, in the order it sends them). */
export interface CommitRequest {
  doc: string;
  outbox: CoreOutbox;
}

/**
 * The core's sync steps, as the shell hands them their inputs. Each step
 * reads and replaces the device's journal (and executes its effects) itself;
 * `journal()` is the journal as the last step left it. #1046 backs these
 * with the compiled `RoundStepOf`, `ResyncStepOf`, `RemoteStep` and
 * `AcceptStep`/`RefusedStep`. A step that moves the cursor stores, as the
 * journal's anchor, the anchor of the feed entry at the new cursor, which
 * the entries it is handed carry.
 */
export interface SyncCore {
  journal(): CoreJournal;
  /** A sync round's pull and push request: the entries after the cursor; returns the commits to send. */
  round(entries: FeedEntry[]): Promise<CommitRequest[]>;
  /** The resync on the divergence signal: the whole restored feed; returns the commits to send. */
  resync(feed: FeedEntry[]): Promise<CommitRequest[]>;
  /** One revision delivered outside a round. */
  remote(entry: FeedEntry): Promise<void>;
  /** The answer to a commit the core requested. */
  pushed(request: CommitRequest, result: PushResult): Promise<void>;
}

/** What one `ShellSync` call did: whether it resynced, and the push results. */
export interface SyncOutcome {
  resynced: DivergenceReason | null;
  results: PushResult[];
}

/**
 * Runs the core's sync steps over the transport (`ShellRun`): every round
 * and every delivery of pulled revisions pulls first, and if the device is
 * diverged it runs the resync instead, so no round or pulled revision of a
 * diverged device reaches the core before its resync. A device that only
 * lags a restored feed (every revision it names still there) gets no resync.
 */
export class ShellSync {
  constructor(
    private readonly core: SyncCore,
    private readonly transport: CoreTransport,
  ) {}

  /** A sync round: pull, then push what the core requests. */
  async round(): Promise<SyncOutcome> {
    const pull = await this.transport.pull(this.core.journal());
    if (pull.kind === "diverged") return this.resync(pull.reason);
    return { resynced: null, results: await this.push(await this.core.round(pull.entries)) };
  }

  /** Revisions delivered outside a round (on a realtime signal, SPEC.md §6.4). */
  async pullRemote(): Promise<SyncOutcome> {
    const pull = await this.transport.pull(this.core.journal());
    if (pull.kind === "diverged") return this.resync(pull.reason);
    for (const entry of pull.entries) await this.core.remote(entry);
    return { resynced: null, results: [] };
  }

  private async resync(reason: DivergenceReason): Promise<SyncOutcome> {
    return { resynced: reason, results: await this.push(await this.core.resync(await this.transport.feed())) };
  }

  private async push(requests: CommitRequest[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (const request of requests) {
      const result = await this.transport.commit(request.doc, request.outbox);
      await this.core.pushed(request, result);
      results.push(result);
    }
    return results;
  }
}
