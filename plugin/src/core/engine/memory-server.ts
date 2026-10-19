import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { BlobService } from "../../gen/vaultsync/v1/blob_pb";
import { SyncService, type CommitRevisionRequest } from "../../gen/vaultsync/v1/sync_pb";
import { DocumentKind, DocumentSchema, RevisionSchema, type Revision } from "../../gen/vaultsync/v1/types_pb";
import { sha256Hex } from "../hash";
import { pathKey } from "../pathkey/pathkey";
import { isNewVaultPath, isVaultRelativePath } from "../vaultpath/vaultpath";

export interface InMemoryServerOptions {
  vaultId?: string;
  /** Largest ListChanges page the server returns, whatever the client asks for. */
  maxPageSize?: number;
  /** Largest DownloadBlob range the server returns, so downloads take several calls. */
  maxDownloadBytes?: number;
  /** Largest PutBlobChunk the server accepts, reported by BeginBlob. */
  maxChunkBytes?: number;
  /** Largest GetDocumentHistory page the server returns, whatever the client asks for. */
  maxHistoryPageSize?: number;
  /** The server clock: every revision's create_time. Defaults to the system clock. */
  now?: () => Date;
}

export interface CommitInput {
  documentId: string;
  path: string;
  /** New content; omit to keep the document's current content (rename, delete). */
  content?: Uint8Array | string;
  deleted?: boolean;
  kind?: DocumentKind;
  /** The committing device; empty by default. */
  deviceId?: string;
}

/** A call the server is about to handle; `fail` makes interceptors reject it. */
export type Interceptor = (method: string, request: unknown) => void;

/** A call the server has handled (its effects are in place); throwing loses the response. */
export type ResponseInterceptor = (method: string, request: unknown, response: unknown) => void;

interface Upload {
  size: number;
  chunks: Uint8Array[];
  received: number;
}

const encoder = new TextEncoder();

/**
 * An in-process stand-in for the server's sync and blob services over
 * ConnectRPC's router transport, for engine unit tests: no network. It keeps a
 * plaintext vault's revision log, blobs and upload sessions in memory and
 * follows the protocol's paging, ranging, upload and commit rules (SPEC.md
 * §6.1, §6.2): resumable sequential chunks, hash verification, optimistic
 * concurrency with the head as a Document detail, idempotent retries by
 * revision id, path-key uniqueness among live documents, including the
 * file/folder rule (a live document never at or under another's folder), and
 * the backslash rule (no document created or moved into a path with a "\").
 */
export class InMemoryServer {
  readonly vaultId: string;
  readonly transport: Transport;
  /** Called before every handled call; throw from it to fail the call. */
  interceptor: Interceptor | undefined;
  /** Called after every handled call; throw from it to lose the response. */
  responseInterceptor: ResponseInterceptor | undefined;
  private revisions: Revision[] = [];
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly uploads = new Map<string, Upload>();
  private headSeq = 0n;
  private readonly maxPageSize: number;
  private readonly maxDownloadBytes: number;
  readonly maxChunkBytes: number;
  private readonly maxHistoryPageSize: number;
  /** The server clock, read for every revision's create_time; replace it to move time on. */
  now: () => Date;

  constructor(options: InMemoryServerOptions = {}) {
    this.vaultId = options.vaultId ?? "vault-1";
    this.maxHistoryPageSize = options.maxHistoryPageSize ?? 1000;
    this.now = options.now ?? (() => new Date());
    this.maxPageSize = options.maxPageSize ?? 1000;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 1 << 20;
    this.maxChunkBytes = options.maxChunkBytes ?? 1 << 20;
    this.transport = createRouterTransport(({ service }) => {
      service(SyncService, {
        listChanges: (request) => {
          this.intercept("ListChanges", request);
          this.checkVault(request.vaultId);
          const limit = Math.min(request.pageSize === 0 ? 500 : request.pageSize, this.maxPageSize);
          const after = this.revisions.filter((revision) => revision.seq > request.sinceSeq);
          return { revisions: after.slice(0, limit), hasMore: after.length > limit, headSeq: this.headSeq };
        },
        getRevision: (request) => {
          this.intercept("GetRevision", request);
          this.checkVault(request.vaultId);
          const revision = this.revisions.find((candidate) => candidate.id === request.revisionId);
          if (revision === undefined) throw new ConnectError("revision not found", Code.NotFound);
          return { revision };
        },
        commitRevision: (request) => {
          this.intercept("CommitRevision", request);
          this.checkVault(request.vaultId);
          return this.respond("CommitRevision", request, { revision: this.commitRequest(request) });
        },
        getDocumentHistory: (request) => {
          this.intercept("GetDocumentHistory", request);
          this.checkVault(request.vaultId);
          // Newest first; the page token is the seq of the last revision returned.
          const all = this.history(request.documentId).reverse();
          const head = all[0];
          if (head === undefined) throw new ConnectError("document not found", Code.NotFound);
          const before = request.pageToken === "" ? undefined : BigInt(request.pageToken);
          const older = before === undefined ? all : all.filter((revision) => revision.seq < before);
          const limit = Math.min(request.pageSize === 0 ? 100 : request.pageSize, this.maxHistoryPageSize);
          const page = older.slice(0, limit);
          const last = page.at(-1);
          return {
            document: { id: head.documentId, vaultId: this.vaultId, kind: head.kind, headRevId: head.id },
            revisions: page,
            nextPageToken: older.length > limit && last !== undefined ? String(last.seq) : "",
          };
        },
      });
      service(BlobService, {
        beginBlob: (request) => {
          this.intercept("BeginBlob", request);
          this.checkVault(request.vaultId);
          const id = bytesToHex(request.blobId);
          const complete = this.blobs.get(id);
          const maxChunkSize = this.maxChunkBytes;
          if (complete !== undefined) return this.respond("BeginBlob", request, { complete: true, receivedSize: BigInt(complete.length), maxChunkSize });
          const size = Number(request.size);
          let upload = this.uploads.get(id);
          if (upload === undefined) {
            upload = { size, chunks: [], received: 0 };
            this.uploads.set(id, upload);
          }
          if (upload.size !== size) throw new ConnectError("size differs from the upload in progress", Code.InvalidArgument);
          return this.respond("BeginBlob", request, { complete: false, receivedSize: BigInt(upload.received), maxChunkSize });
        },
        putBlobChunk: (request) => {
          this.intercept("PutBlobChunk", request);
          this.checkVault(request.vaultId);
          const upload = this.uploads.get(bytesToHex(request.blobId));
          if (upload === undefined) throw new ConnectError("no upload in progress", Code.FailedPrecondition);
          if (request.data.length === 0 || request.data.length > this.maxChunkBytes) throw new ConnectError("chunk size out of bounds", Code.InvalidArgument);
          if (request.offset !== BigInt(upload.received)) throw new ConnectError("offset is not the received size", Code.FailedPrecondition);
          if (upload.received + request.data.length > upload.size) throw new ConnectError("chunk extends past the size", Code.InvalidArgument);
          upload.chunks.push(request.data.slice());
          upload.received += request.data.length;
          return this.respond("PutBlobChunk", request, { receivedSize: BigInt(upload.received) });
        },
        commitBlob: (request) => {
          this.intercept("CommitBlob", request);
          this.checkVault(request.vaultId);
          const id = bytesToHex(request.blobId);
          const complete = this.blobs.get(id);
          if (complete !== undefined) return this.respond("CommitBlob", request, { size: BigInt(complete.length) });
          const upload = this.uploads.get(id);
          if (upload === undefined) throw new ConnectError("no upload", Code.NotFound);
          if (upload.received < upload.size) throw new ConnectError("upload incomplete", Code.FailedPrecondition);
          const content = new Uint8Array(upload.size);
          let offset = 0;
          for (const chunk of upload.chunks) {
            content.set(chunk, offset);
            offset += chunk.length;
          }
          this.uploads.delete(id);
          if (sha256Hex(content) !== id) throw new ConnectError("content does not match blob_id", Code.InvalidArgument);
          this.blobs.set(id, content);
          return this.respond("CommitBlob", request, { size: BigInt(content.length) });
        },
        downloadBlob: (request) => {
          this.intercept("DownloadBlob", request);
          this.checkVault(request.vaultId);
          const blob = this.blobs.get(bytesToHex(request.blobId));
          if (blob === undefined) throw new ConnectError("blob not found", Code.NotFound);
          if (request.offset > BigInt(blob.length)) throw new ConnectError("offset beyond the blob", Code.OutOfRange);
          const length = Math.min(request.length === 0 ? this.maxDownloadBytes : request.length, this.maxDownloadBytes);
          const start = Number(request.offset);
          return { data: blob.slice(start, start + length), size: BigInt(blob.length) };
        },
      });
    });
  }

  /** Appends a revision as if a client had committed it, and returns it. */
  commit(input: CommitInput): Revision {
    const head = this.head(input.documentId);
    let blobId: Uint8Array;
    let size: bigint;
    if (input.content !== undefined) {
      const bytes = typeof input.content === "string" ? encoder.encode(input.content) : input.content.slice();
      const hash = sha256Hex(bytes);
      this.blobs.set(hash, bytes);
      blobId = hexToBytes(hash);
      size = BigInt(bytes.length);
    } else {
      if (head?.contentRef === undefined) throw new Error(`document ${input.documentId} has no content to keep`);
      blobId = head.contentRef.blobId;
      size = head.contentRef.size;
    }
    this.headSeq++;
    const revision = create(RevisionSchema, {
      id: `${input.documentId}@${String(this.headSeq)}`,
      documentId: input.documentId,
      vaultId: this.vaultId,
      seq: this.headSeq,
      parentRevId: head?.id ?? "",
      kind: input.kind ?? head?.kind ?? DocumentKind.TEXT,
      contentRef: { blobId, size },
      path: encoder.encode(input.path),
      deleted: input.deleted ?? false,
      deviceId: input.deviceId ?? "",
      createTime: timestampFromDate(this.now()),
    });
    this.revisions.push(revision);
    return revision;
  }

  /**
   * Purges a revision as the retention job does (SPEC.md §11): its child is
   * re-parented onto its parent, and the revision is gone from the change
   * feed, GetRevision and history. Its blob stays until collectBlob. A
   * document's head is never purged.
   */
  purge(revisionId: string): void {
    const revision = this.revisions.find((candidate) => candidate.id === revisionId);
    if (revision === undefined) throw new Error(`no revision ${revisionId}`);
    if (this.head(revision.documentId)?.id === revisionId) throw new Error(`revision ${revisionId} is its document's head`);
    for (const child of this.revisions) if (child.documentId === revision.documentId && child.parentRevId === revisionId) child.parentRevId = revision.parentRevId;
    this.revisions = this.revisions.filter((candidate) => candidate !== revision);
  }

  /** Garbage-collects a blob that no revision references any more (SPEC.md §11). */
  collectBlob(blobId: string): void {
    if (this.revisions.some((revision) => bytesToHex(revision.contentRef?.blobId ?? new Uint8Array()) === blobId)) throw new Error(`blob ${blobId} is still referenced`);
    if (!this.blobs.delete(blobId)) throw new Error(`no blob ${blobId}`);
  }

  /** Appends a revision with a raw (possibly invalid UTF-8) path. */
  commitRawPath(documentId: string, path: Uint8Array, content: string): Revision {
    const revision = this.commit({ documentId, path: "placeholder.md", content });
    revision.path = path;
    return revision;
  }

  /** Replaces the stored bytes of a blob, keeping its id: a corrupt store. */
  corruptBlob(revision: Revision, bytes: Uint8Array): void {
    if (revision.contentRef === undefined) throw new Error("revision has no content");
    this.blobs.set(bytesToHex(revision.contentRef.blobId), bytes);
  }

  /** Forgets every revision after `seq`, as a database restore from a backup would. */
  restoreTo(seq: bigint): void {
    this.revisions = this.revisions.filter((revision) => revision.seq <= seq);
    this.headSeq = seq;
  }

  get currentHeadSeq(): bigint {
    return this.headSeq;
  }

  get revisionCount(): number {
    return this.revisions.length;
  }

  revisionAt(seq: bigint): Revision {
    const revision = this.revisions.find((candidate) => candidate.seq === seq);
    if (revision === undefined) throw new Error(`no revision at seq ${String(seq)}`);
    return revision;
  }

  contentOf(revision: Revision): Uint8Array {
    const blob = revision.contentRef === undefined ? undefined : this.blobs.get(bytesToHex(revision.contentRef.blobId));
    if (blob === undefined) throw new Error(`revision ${revision.id} has no stored content`);
    return blob.slice();
  }

  /** The newest revision of `documentId`, if any. */
  head(documentId: string): Revision | undefined {
    return this.revisions.filter((revision) => revision.documentId === documentId).at(-1);
  }

  /** Path to content of every live document at its head: what a converged vault holds. */
  liveFiles(): Map<string, string> {
    const heads = new Map<string, Revision>();
    for (const revision of this.revisions) heads.set(revision.documentId, revision);
    const files = new Map<string, string>();
    for (const revision of heads.values()) {
      if (revision.deleted || revision.contentRef === undefined) continue;
      const blob = this.blobs.get(bytesToHex(revision.contentRef.blobId));
      if (blob === undefined) throw new Error("head without a blob");
      files.set(new TextDecoder().decode(revision.path), new TextDecoder().decode(blob));
    }
    return files;
  }

  /** Whether a blob is complete. */
  hasBlob(blobId: string): boolean {
    return this.blobs.has(blobId);
  }

  /** Path to document id of every live document at its head: which document holds each path. */
  liveDocuments(): Map<string, string> {
    const documents = new Map<string, string>();
    for (const [documentId, revision] of this.liveHeads()) documents.set(new TextDecoder().decode(revision.path), documentId);
    return documents;
  }

  /** Every retained revision of `documentId`, oldest first. */
  history(documentId: string): Revision[] {
    return this.revisions.filter((revision) => revision.documentId === documentId);
  }

  private intercept(method: string, request: unknown): void {
    this.interceptor?.(method, request);
  }

  private respond<T>(method: string, request: unknown, response: T): T {
    this.responseInterceptor?.(method, request, response);
    return response;
  }

  /** CommitRevision's checks, in the server's order (SPEC.md §6.2). */
  private commitRequest(request: CommitRevisionRequest): Revision {
    if (request.deviceId === "") throw new ConnectError("device not found", Code.NotFound);
    const existing = this.revisions.find((revision) => revision.id === request.revisionId);
    if (existing !== undefined) {
      const same =
        existing.documentId === request.documentId &&
        existing.parentRevId === request.baseRevId &&
        existing.kind === request.kind &&
        existing.deleted === request.deleted &&
        bytesToHex(existing.path) === bytesToHex(request.path) &&
        bytesToHex(existing.contentRef?.blobId ?? new Uint8Array()) === bytesToHex(request.contentRef?.blobId ?? new Uint8Array()) &&
        existing.contentRef?.size === request.contentRef?.size;
      if (!same) throw new ConnectError("revision id reused with other fields", Code.InvalidArgument);
      return existing;
    }
    const head = this.head(request.documentId);
    if (head === undefined && request.baseRevId !== "") throw new ConnectError("the document does not exist", Code.FailedPrecondition);
    if (head !== undefined && head.id !== request.baseRevId) {
      throw new ConnectError("base_rev_id is not the document's head", Code.FailedPrecondition, undefined, [
        { desc: DocumentSchema, value: { id: head.documentId, vaultId: this.vaultId, kind: head.kind, headRevId: head.id } },
      ]);
    }
    if (head !== undefined && head.kind !== request.kind) throw new ConnectError("kind differs from the document's kind", Code.InvalidArgument);
    const blobId = bytesToHex(request.contentRef?.blobId ?? new Uint8Array());
    const blob = this.blobs.get(blobId);
    if (blob === undefined) throw new ConnectError("content_ref is not a complete blob", Code.FailedPrecondition);
    if (BigInt(blob.length) !== request.contentRef?.size) throw new ConnectError("size mismatch", Code.InvalidArgument);
    const path = new TextDecoder().decode(request.path);
    if (!isVaultRelativePath(path)) throw new ConnectError("path is not vault-relative", Code.InvalidArgument);
    // A path with a "\" may only be kept by the live document already at it (#191).
    if (!isNewVaultPath(path) && (head === undefined || head.deleted || new TextDecoder().decode(head.path) !== path)) {
      throw new ConnectError('a new path must not contain "\\"', Code.InvalidArgument);
    }
    if (!request.deleted) {
      const key = pathKey(path);
      // Only a new live path key can collide: a create, rename or
      // resurrection. An edit that keeps its live path key is never refused,
      // as the server does not refuse one (#134).
      const newKey = head === undefined || head.deleted || pathKey(new TextDecoder().decode(head.path)) !== key;
      for (const [documentId, live] of this.liveHeads()) {
        if (documentId === request.documentId) continue;
        const other = pathKey(new TextDecoder().decode(live.path));
        if (other === key) throw new ConnectError("another live document has this path", Code.AlreadyExists);
        // File/folder rule (SPEC.md §6.3): no live document at, or under, the folder another one's path names.
        if (newKey && (other.startsWith(`${key}/`) || key.startsWith(`${other}/`))) {
          throw new ConnectError("another live document's path is a folder of this one, or this one of it", Code.AlreadyExists);
        }
      }
    }
    this.headSeq++;
    const revision = create(RevisionSchema, {
      id: request.revisionId,
      documentId: request.documentId,
      vaultId: this.vaultId,
      seq: this.headSeq,
      parentRevId: request.baseRevId,
      kind: request.kind,
      contentRef: { blobId: hexToBytes(blobId), size: BigInt(blob.length) },
      path: request.path,
      deleted: request.deleted,
      deviceId: request.deviceId,
      createTime: timestampFromDate(this.now()),
    });
    this.revisions.push(revision);
    return revision;
  }

  private liveHeads(): Map<string, Revision> {
    const heads = new Map<string, Revision>();
    for (const revision of this.revisions) heads.set(revision.documentId, revision);
    for (const [documentId, revision] of heads) if (revision.deleted) heads.delete(documentId);
    return heads;
  }

  private checkVault(vaultId: string): void {
    if (vaultId !== this.vaultId) throw new ConnectError("vault not found", Code.NotFound);
  }
}
