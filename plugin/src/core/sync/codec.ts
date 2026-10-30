/**
 * How the engine reads and writes revisions on the server: as they are in a
 * plaintext vault, or encrypted in an end-to-end encrypted vault
 * (docs/design/encryption.md, "Model" and "Formats and rules settled during
 * implementation"; byte formats in docs/design/crypto.md).
 *
 * The engine itself is the same for both: it works on plaintext paths, and
 * identifies content by its SHA-256 (`contentHash`) and plaintext size. In an
 * encrypted vault the codec seals content and paths under the vault's current
 * epoch on push, with HMAC `blob_id` and `path_key`, and opens them with each
 * revision's epoch on pull, checking `blob_id` after decryption.
 */
import { Code } from "@connectrpc/connect";
import { equalBytes } from "@noble/ciphers/utils.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import { DecryptError, blobId as hmacBlobId, deriveSubkey, open, pathKey as hmacPathKey, seal } from "../e2ee/e2ee";
import { contentAad, pathAad } from "../e2ee/revision";
import { sha256Hex } from "../hash";
import { isEpochNotCurrent } from "../keys/vault-keys";
import { isPathText, isVaultRelativePath } from "../vaultpath/vaultpath";
import { errorCode, vaultEncrypted } from "./errors";
import { RemoteContentError, baseContent, downloadBlob, downloadContent, toIncoming, type IncomingRevision, type PullApi } from "./remote";
import { isComplete, uploadBlob, uploadContent } from "./upload";

/** A blob to commit as a revision's content. */
export interface ContentRefFields {
  blobId: Uint8Array;
  size: bigint;
}

/** The fields of a CommitRevision that depend on the vault's encryption. */
export interface CommitFields {
  path: Uint8Array;
  pathKey: Uint8Array;
  epoch: number;
}

/** What a commit is about: the engine's pending operation, in plain form. */
export interface CommitSubject {
  documentId: string;
  revisionId: string;
  path: string;
}

/** The content of a pending operation, to be referenced by its commit. */
export interface ContentSubject {
  contentHash: string;
  size: number;
  /** Whether the operation deletes the document: its content is already on the server, as `baseRevId`'s. */
  deleted: boolean;
  /** The document's base revision, whose content a delete names. */
  baseRevId: string | undefined;
  /** Reads the local content; null when the file is gone. */
  read: () => Promise<Uint8Array | null>;
}

export interface RevisionCodec {
  /** Called at the start of every cycle: picks up new epochs (encrypted vaults). */
  prepare(): Promise<void>;
  /** A revision from the server in plain form. */
  decode(revision: Revision): Promise<IncomingRevision>;
  /** The content of `contentHash`, of `size` bytes, as `revisionId` (if given) references it. */
  download(contentHash: string, size: bigint, revisionId?: string): Promise<Uint8Array>;
  /** The content of a merge base, or null if retention purged it (SPEC.md §8, §11). */
  baseContent(revisionId: string): Promise<Uint8Array | null>;
  /**
   * Makes the content of an operation a complete blob on the server and
   * returns its reference, or "missing" when the local content no longer has
   * the operation's hash.
   */
  content(subject: ContentSubject): Promise<ContentRefFields | "missing">;
  /** The path, path key and epoch of a commit. */
  commitFields(subject: CommitSubject): CommitFields;
  /** Whether a commit refused with `error` is retried at once, re-encrypted: `epoch`, the one it used, is no longer current. */
  retryCommit(error: unknown, epoch: number): Promise<boolean>;
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** A plaintext vault's revisions: paths are UTF-8, and content is addressed by its SHA-256 (SPEC.md §5). */
export class PlaintextCodec implements RevisionCodec {
  constructor(
    private readonly api: PullApi,
    private readonly vaultId: string,
  ) {}

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  decode(revision: Revision): Promise<IncomingRevision> {
    return Promise.resolve(toIncoming(revision));
  }

  download(contentHash: string, size: bigint): Promise<Uint8Array> {
    return downloadContent(this.api, this.vaultId, contentHash, size);
  }

  baseContent(revisionId: string): Promise<Uint8Array | null> {
    return baseContent(this.api, this.vaultId, revisionId);
  }

  async content(subject: ContentSubject): Promise<ContentRefFields | "missing"> {
    const ref = { blobId: hexToBytes(subject.contentHash), size: BigInt(subject.size) };
    // A tombstone names the content being deleted, which the server holds.
    if (subject.deleted) return ref;
    return (await uploadContent(this.api, this.vaultId, subject.contentHash, ref.size, subject.read)) === "missing" ? "missing" : ref;
  }

  commitFields(subject: CommitSubject): CommitFields {
    return { path: encoder.encode(subject.path), pathKey: new Uint8Array(), epoch: 0 };
  }

  retryCommit(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** The epoch keys of an encrypted vault on this device (the vault key manager, `keys/vault-keys.ts`). */
export interface VaultKeyring {
  /** Brings the device's epoch keys up to date and resolves with the vault's current epoch (0 while it has none). */
  refresh(): Promise<number>;
  /** The key of `epoch`, if this device holds it and it matched the epoch's key commitment. */
  epochKey(epoch: number): Uint8Array | undefined;
  /**
   * For a vault converted to encryption in place, the vault's head seq at the
   * conversion, from the verified membership log (as of the last refresh):
   * epoch-0 revisions up to it are the vault's plaintext history. Undefined
   * for a vault created encrypted, which never accepts epoch 0.
   */
  conversionSeq(): bigint | undefined;
}

/** This device does not hold a key it needs: an owner has not shared it yet, or it was refused. */
export class VaultKeyUnavailableError extends Error {
  override readonly name = "VaultKeyUnavailableError";

  constructor(readonly epoch: number) {
    super(`This device does not hold the vault key of epoch ${String(epoch)} yet.`);
  }
}

/** A blob of an encrypted vault: sealed under `epoch`, `sealedSize` bytes on the server. */
interface SealedBlob {
  blobId: string;
  epoch: number;
  sealedSize: bigint;
}

/** Plaintext held for blobs read or written in this run, at most this many bytes, so a pull does not download a blob twice. */
const contentCacheBytes = 32 << 20;

/**
 * An end-to-end encrypted vault's revisions (docs/design/crypto.md):
 *
 * - a path is sealed with the `path` sub-key of the revision's epoch and
 *   `path_aad` (vault, document, epoch); its `path_key` is the HMAC of the
 *   normalized path under epoch 1's `path_key_secret`, for the vault's
 *   whole life;
 * - content is sealed with the `content` sub-key of the revision's epoch and
 *   `content_aad` (vault, epoch); its `blob_id` is the HMAC of the plaintext
 *   under that epoch's `blob_id_secret`, checked after every decryption;
 * - a commit under epoch E references only content sealed under E, so a
 *   rename, a delete or a retry after a rotation seals the content again
 *   under E when the server lacks it.
 */
export class EncryptedCodec implements RevisionCodec {
  private currentEpoch = 0;
  /** The blob of each content (by SHA-256) seen or sealed in this run, the latest one. */
  private readonly sealedByHash = new Map<string, SealedBlob>();
  /** Content hashes of plaintext history (epoch 0) seen in this run: their blob is the content itself. */
  private readonly plaintextHashes = new Set<string>();
  /** The SHA-256 and plaintext size of each blob opened or sealed in this run. */
  private readonly plainByBlob = new Map<string, { hash: string; size: bigint }>();
  /** Plaintext of recently opened blobs, oldest first. */
  private readonly contentCache = new Map<string, Uint8Array>();
  private cachedBytes = 0;
  /** Sealed bytes of blobs whose upload has not completed: a resumed upload continues with the same bytes. */
  private readonly uploading = new Map<string, Uint8Array>();

  constructor(
    private readonly api: PullApi,
    private readonly vaultId: string,
    private readonly keys: VaultKeyring,
  ) {}

  async prepare(): Promise<void> {
    this.currentEpoch = await this.keys.refresh();
  }

  decode(revision: Revision): Promise<IncomingRevision> {
    return this.decodeRevision(revision, false);
  }

  /**
   * Decodes a revision. A blob the server no longer has (a re-key job moved
   * the revision and cleanup deleted its old blob) re-reads the revision and
   * retries once with its current epoch and content reference
   * (docs/design/encryption.md, "Content gone mid-sync").
   */
  private async decodeRevision(revision: Revision, reread: boolean): Promise<IncomingRevision> {
    const epoch = revision.epoch;
    if (epoch === 0) return this.decodePlaintextHistory(revision);
    const key = await this.key(epoch);
    let path: string;
    try {
      path = strictDecoder.decode(open(deriveSubkey(key, "path"), revision.path, pathAad(this.vaultId, revision.documentId, epoch)));
    } catch (error) {
      if (!(error instanceof DecryptError) && !(error instanceof TypeError)) throw error;
      throw new RemoteContentError(`the path of revision ${revision.id} does not decrypt`, { cause: error });
    }
    const plain = toIncoming(revision);
    const ref = revision.contentRef;
    let contentHash = "";
    let size = 0n;
    if (ref !== undefined) {
      const blob: SealedBlob = { blobId: bytesToHex(ref.blobId), epoch, sealedSize: ref.size };
      let known = this.plainByBlob.get(blob.blobId);
      if (known === undefined) {
        let content: Uint8Array;
        try {
          content = await this.openBlob(blob);
        } catch (error) {
          if (reread || errorCode(error) !== Code.NotFound) throw error;
          return this.decodeRevision(await this.reread(revision.id), true);
        }
        known = { hash: sha256Hex(content), size: BigInt(content.length) };
        this.plainByBlob.set(blob.blobId, known);
        this.cache(blob.blobId, content);
      }
      contentHash = known.hash;
      size = known.size;
      this.sealedByHash.set(contentHash, blob);
    }
    return {
      ...plain,
      remote: { ...plain.remote, path, contentHash, size },
      pathAllowed: isPathText(path) && isVaultRelativePath(path),
    };
  }

  /**
   * A revision of a converted vault's plaintext history (epoch 0), which the
   * re-key job has not encrypted yet: read as in a plaintext vault. Only
   * revisions committed up to the conversion may be at epoch 0; a later one,
   * and every one of a vault created encrypted, is refused
   * (docs/design/encryption.md, "Epoch 0").
   */
  private decodePlaintextHistory(revision: Revision): IncomingRevision {
    const converted = this.keys.conversionSeq();
    if (converted === undefined || revision.seq > converted) throw new RemoteContentError(`revision ${revision.id} of an encrypted vault is not encrypted`);
    const plain = toIncoming(revision);
    if (revision.contentRef !== undefined) this.plaintextHashes.add(plain.remote.contentHash);
    return plain;
  }

  async download(contentHash: string, size: bigint, revisionId?: string): Promise<Uint8Array> {
    if (this.plaintextHashes.has(contentHash) && !this.sealedByHash.has(contentHash)) {
      try {
        return await downloadContent(this.api, this.vaultId, contentHash, size);
      } catch (error) {
        if (revisionId === undefined || errorCode(error) !== Code.NotFound) throw error;
        // The re-key job encrypted the revision and cleanup deleted its plaintext blob: read it as it is now.
        if ((await this.decodeRevision(await this.reread(revisionId), true)).remote.contentHash !== contentHash || !this.sealedByHash.has(contentHash)) {
          throw new RemoteContentError(`revision ${revisionId} no longer holds content ${contentHash}`);
        }
      }
    }
    let blob = this.sealedByHash.get(contentHash);
    if (blob === undefined && revisionId !== undefined) {
      const revision = (await this.api.sync.getRevision({ vaultId: this.vaultId, revisionId })).revision;
      if (revision === undefined) throw new RemoteContentError(`revision ${revisionId} was not returned`);
      if ((await this.decode(revision)).remote.contentHash === contentHash) blob = this.sealedByHash.get(contentHash);
    }
    if (blob === undefined) throw new RemoteContentError(`no blob of this vault is known to hold content ${contentHash}`);
    let content = this.contentCache.get(blob.blobId);
    if (content === undefined) {
      try {
        content = await this.openBlob(blob);
      } catch (error) {
        if (revisionId === undefined || errorCode(error) !== Code.NotFound) throw error;
        // The blob is gone (see decodeRevision): re-read the revision, and retry once with its current content.
        const moved = (await this.decodeRevision(await this.reread(revisionId), true)).remote;
        blob = this.sealedByHash.get(contentHash);
        if (moved.contentHash !== contentHash || blob === undefined) throw new RemoteContentError(`revision ${revisionId} no longer holds content ${contentHash}`);
        content = this.contentCache.get(blob.blobId) ?? (await this.openBlob(blob));
      }
    }
    if (BigInt(content.length) !== size || sha256Hex(content) !== contentHash) throw new RemoteContentError(`blob ${blob.blobId} does not hold content ${contentHash}`);
    return content;
  }

  async baseContent(revisionId: string): Promise<Uint8Array | null> {
    try {
      const revision = (await this.api.sync.getRevision({ vaultId: this.vaultId, revisionId })).revision;
      if (revision?.contentRef === undefined) throw new RemoteContentError(`revision ${revisionId} has no content`);
      const remote = (await this.decode(revision)).remote;
      return await this.download(remote.contentHash, remote.size);
    } catch (error) {
      if (errorCode(error) === Code.NotFound) return null;
      throw error;
    }
  }

  async content(subject: ContentSubject): Promise<ContentRefFields | "missing"> {
    const epoch = this.currentEpoch;
    const key = await this.key(epoch);
    // Content already sealed under the current epoch, and complete on the server, is referenced as it is.
    const known = this.sealedByHash.get(subject.contentHash);
    if (known?.epoch === epoch && !this.uploading.has(known.blobId) && (await isComplete(this.api, this.vaultId, hexToBytes(known.blobId), known.sealedSize))) {
      return { blobId: hexToBytes(known.blobId), size: known.sealedSize };
    }
    // A delete names the content being deleted: the base's, sealed again under the current epoch if needed.
    const content = subject.deleted
      ? subject.baseRevId === undefined
        ? null
        : await this.download(subject.contentHash, BigInt(subject.size), subject.baseRevId)
      : await subject.read();
    if (content === null || content.length !== subject.size || sha256Hex(content) !== subject.contentHash) return "missing";
    const blobId = hmacBlobId(deriveSubkey(key, "blob_id_secret"), content);
    const id = bytesToHex(blobId);
    const sealed = this.uploading.get(id) ?? seal(deriveSubkey(key, "content"), content, contentAad(this.vaultId, epoch));
    this.uploading.set(id, sealed);
    if (!(await isComplete(this.api, this.vaultId, blobId, BigInt(sealed.length)))) await uploadBlob(this.api, this.vaultId, blobId, sealed);
    this.uploading.delete(id);
    const blob: SealedBlob = { blobId: id, epoch, sealedSize: BigInt(sealed.length) };
    this.sealedByHash.set(subject.contentHash, blob);
    this.plainByBlob.set(id, { hash: subject.contentHash, size: BigInt(content.length) });
    return { blobId, size: blob.sealedSize };
  }

  commitFields(subject: CommitSubject): CommitFields {
    const epoch = this.currentEpoch;
    const key = this.keys.epochKey(epoch);
    if (key === undefined) throw new VaultKeyUnavailableError(epoch);
    // path_key_secret comes from epoch 1's key for the vault's whole life.
    const first = this.keys.epochKey(1);
    if (first === undefined) throw new VaultKeyUnavailableError(1);
    const sealed = seal(deriveSubkey(key, "path"), encoder.encode(subject.path), pathAad(this.vaultId, subject.documentId, epoch));
    return { path: sealed, pathKey: hmacPathKey(deriveSubkey(first, "path_key_secret"), subject.path), epoch };
  }

  async retryCommit(error: unknown, epoch: number): Promise<boolean> {
    // A rotation replaced the epoch, or the conversion refuses an epoch-0 (plaintext) commit sent before it: take the current epoch, and the commit is sealed again under it.
    if (!isEpochNotCurrent(error) && !(epoch === 0 && vaultEncrypted(error))) return false;
    await this.prepare();
    return this.currentEpoch !== epoch;
  }

  /** The revision `revisionId` as the server stores it now. */
  private async reread(revisionId: string): Promise<Revision> {
    const revision = (await this.api.sync.getRevision({ vaultId: this.vaultId, revisionId })).revision;
    if (revision === undefined) throw new RemoteContentError(`revision ${revisionId} was not returned`);
    return revision;
  }

  /** The key of `epoch`, refreshing the device's keys once if it does not hold it. */
  private async key(epoch: number): Promise<Uint8Array> {
    if (epoch === 0) throw new VaultKeyUnavailableError(epoch);
    let key = this.keys.epochKey(epoch);
    if (key === undefined) {
      this.currentEpoch = await this.keys.refresh();
      key = this.keys.epochKey(epoch);
    }
    if (key === undefined) throw new VaultKeyUnavailableError(epoch);
    return key;
  }

  /** Downloads and opens a blob sealed under `blob.epoch`, and checks that it is the blob its id names. */
  private async openBlob(blob: SealedBlob): Promise<Uint8Array> {
    const key = await this.key(blob.epoch);
    const sealed = await downloadBlob(this.api, this.vaultId, blob.blobId, blob.sealedSize);
    let content: Uint8Array;
    try {
      content = open(deriveSubkey(key, "content"), sealed, contentAad(this.vaultId, blob.epoch));
    } catch (error) {
      if (!(error instanceof DecryptError)) throw error;
      throw new RemoteContentError(`blob ${blob.blobId} does not decrypt`, { cause: error });
    }
    if (!equalBytes(hmacBlobId(deriveSubkey(key, "blob_id_secret"), content), hexToBytes(blob.blobId))) {
      throw new RemoteContentError(`blob ${blob.blobId} does not match its blob id`);
    }
    return content;
  }

  private cache(blobId: string, content: Uint8Array): void {
    if (content.length > contentCacheBytes) return;
    this.contentCache.set(blobId, content);
    this.cachedBytes += content.length;
    for (const [id, cached] of this.contentCache) {
      if (this.cachedBytes <= contentCacheBytes) break;
      this.contentCache.delete(id);
      this.cachedBytes -= cached.length;
    }
  }
}
