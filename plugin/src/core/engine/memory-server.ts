import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { BlobService } from "../../gen/vaultsync/v1/blob_pb";
import { SyncService } from "../../gen/vaultsync/v1/sync_pb";
import { DocumentKind, RevisionSchema, type Revision } from "../../gen/vaultsync/v1/types_pb";
import { sha256Hex } from "../hash";

export interface InMemoryServerOptions {
  vaultId?: string;
  /** Largest ListChanges page the server returns, whatever the client asks for. */
  maxPageSize?: number;
  /** Largest DownloadBlob range the server returns, so downloads take several calls. */
  maxDownloadBytes?: number;
}

export interface CommitInput {
  documentId: string;
  path: string;
  /** New content; omit to keep the document's current content (rename, delete). */
  content?: Uint8Array | string;
  deleted?: boolean;
  kind?: DocumentKind;
}

/** A call the server is about to handle; `fail` makes interceptors reject it. */
export type Interceptor = (method: string, request: unknown) => void;

const encoder = new TextEncoder();

/**
 * An in-process stand-in for the server's pull side (ListChanges, GetRevision,
 * DownloadBlob) over ConnectRPC's router transport, for engine unit tests: no
 * network. It keeps a plaintext vault's revision log and blobs in memory and
 * follows the protocol's paging and ranging rules (SPEC.md §6.1, §6.2).
 */
export class InMemoryServer {
  readonly vaultId: string;
  readonly transport: Transport;
  /** Called before every handled call; throw from it to fail the call. */
  interceptor: Interceptor | undefined;
  private revisions: Revision[] = [];
  private readonly blobs = new Map<string, Uint8Array>();
  private headSeq = 0n;
  private readonly maxPageSize: number;
  private readonly maxDownloadBytes: number;

  constructor(options: InMemoryServerOptions = {}) {
    this.vaultId = options.vaultId ?? "vault-1";
    this.maxPageSize = options.maxPageSize ?? 1000;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 1 << 20;
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
        commitRevision: () => {
          throw new ConnectError("not part of the in-memory pull server", Code.Unimplemented);
        },
        getDocumentHistory: () => {
          throw new ConnectError("not part of the in-memory pull server", Code.Unimplemented);
        },
      });
      service(BlobService, {
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
    });
    this.revisions.push(revision);
    return revision;
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

  private intercept(method: string, request: unknown): void {
    this.interceptor?.(method, request);
  }

  private checkVault(vaultId: string): void {
    if (vaultId !== this.vaultId) throw new ConnectError("vault not found", Code.NotFound);
  }
}
