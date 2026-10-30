/**
 * The re-key job (docs/design/encryption.md, "Re-encrypting history"): an
 * owner's device moves every retained revision of an end-to-end encrypted
 * vault that is not on the current epoch onto it, then retires the old
 * epochs.
 *
 * It pages through ListStaleRevisions. The page's current epoch is the
 * target: when it changes (a rotation during the job), the job restarts from
 * the first page with the newer target. For each revision it opens the path
 * and content with the revision's epoch (epoch 0, a converted vault's
 * plaintext history, is plaintext), seals them under the target, uploads the
 * content under the target's `blob_id` if the server lacks it, and calls
 * ReplaceRevisionCiphertext. A rewrite that loses (another run moved the
 * revision, or the target is no longer current) is skipped, and the job
 * repeats passes until one finds no stale revision. It then retires every
 * epoch from 2 below the target; epoch 1 is never retired, because its key
 * derives every `path_key`.
 *
 * The job keeps no local state: the server lists only revisions still
 * stale, so a run after an interrupted one resumes where it stopped. It never
 * changes which revision is current, so sync is unaffected while it runs.
 */
import { Code } from "@connectrpc/connect";
import { equalBytes } from "@noble/ciphers/utils.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import { DecryptError, blobId as hmacBlobId, deriveSubkey, open, seal } from "../e2ee/e2ee";
import { contentAad, pathAad } from "../e2ee/revision";
import type { ProtocolClient } from "../protocol/client";
import { VaultKeyUnavailableError, type VaultKeyring } from "./codec";
import { errorCode } from "./errors";
import { RemoteContentError, downloadBlob, downloadContent } from "./remote";
import { isComplete, uploadBlob } from "./upload";

/** The calls the re-key job makes. */
export type RekeyApi = Pick<ProtocolClient, "sync" | "blobs" | "vaultKeys">;

/** What a run of the re-key job did. */
export interface RekeyResult {
  /** The epoch every revision is on afterwards. */
  epoch: number;
  /** Revisions this run moved; a rewrite another run won is not counted. */
  moved: number;
  /** The epochs retired, each one also when an earlier run had already retired it. */
  retired: number[];
}

export interface RekeyOptions {
  /** ListStaleRevisions page size; the server's default when unset. */
  pageSize?: number;
}

/** Passes after which a job whose rewrites keep losing gives up: rotations or other runs never let it finish. */
const maxPasses = 100;

/** A content sealed under the target in this run, by `blob_id` (hex): sent again as the same bytes when an upload resumes. */
interface SealedContent {
  blobId: Uint8Array;
  sealed: Uint8Array;
}

/** Re-encrypts the history of an encrypted vault onto its current epoch and retires the old epochs (see the module comment). */
export async function reencryptHistory(api: RekeyApi, vaultId: string, keys: VaultKeyring, options: RekeyOptions = {}): Promise<RekeyResult> {
  const job = new RekeyJob(api, vaultId, keys, options.pageSize ?? 0);
  return job.run();
}

class RekeyJob {
  private moved = 0;
  private readonly sealed = new Map<string, SealedContent>();

  constructor(
    private readonly api: RekeyApi,
    private readonly vaultId: string,
    private readonly keys: VaultKeyring,
    private readonly pageSize: number,
  ) {}

  async run(): Promise<RekeyResult> {
    let retiredBelow = 0;
    let retired: number[] = [];
    for (let pass = 0; pass < maxPasses; pass++) {
      const { stale, target } = await this.pass();
      if (stale) continue;
      // Retiring runs after a pass found nothing stale; a pass after it confirms no rotation came in between.
      if (retiredBelow === target) return { epoch: target, moved: this.moved, retired };
      retired = await this.retireBelow(target);
      retiredBelow = target;
    }
    throw new Error(`re-encrypting history did not finish after ${String(maxPasses)} passes`);
  }

  /** One pass over the stale revisions: whether it saw any (or the target changed), and the target it ended on. */
  private async pass(): Promise<{ stale: boolean; target: number }> {
    let target: number | undefined;
    let stale = false;
    let pageToken = "";
    do {
      const page = await this.api.vaultKeys.listStaleRevisions({ vaultId: this.vaultId, pageSize: this.pageSize, pageToken });
      if (page.currentEpoch === 0) throw new Error("the vault has no key epoch to re-encrypt its history under");
      // A rotation during the pass: restart from the first page with the newer target.
      if (target !== undefined && page.currentEpoch !== target) return { stale: true, target: page.currentEpoch };
      target = page.currentEpoch;
      for (const revision of page.revisions) {
        stale = true;
        if (revision.epoch < target && (await this.move(revision, target))) this.moved++;
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== "");
    return { stale, target };
  }

  /** Moves one revision onto `target`; whether the server applied the rewrite. */
  private async move(revision: Revision, target: number): Promise<boolean> {
    const targetKey = await this.key(target);
    const plainPath = await this.openPath(revision);
    const path = seal(deriveSubkey(targetKey, "path"), plainPath, pathAad(this.vaultId, revision.documentId, target));
    let contentRef: { blobId: Uint8Array; size: bigint } | undefined;
    if (revision.contentRef !== undefined) {
      const content = await this.openContent(revision);
      // The revision moved or its content changed since it was listed: a later pass sees it as it is now.
      if (content === "moved") return false;
      const sealed = await this.sealContent(content, target, targetKey);
      contentRef = { blobId: sealed.blobId, size: BigInt(sealed.sealed.length) };
    }
    const response = await this.api.vaultKeys.replaceRevisionCiphertext({
      vaultId: this.vaultId,
      revisionId: revision.id,
      fromEpoch: revision.epoch,
      toEpoch: target,
      path,
      contentRef,
    });
    return response.replaced;
  }

  /** The plaintext path of a stored revision. */
  private async openPath(revision: Revision): Promise<Uint8Array> {
    if (revision.epoch === 0) return revision.path;
    const key = await this.key(revision.epoch);
    try {
      return open(deriveSubkey(key, "path"), revision.path, pathAad(this.vaultId, revision.documentId, revision.epoch));
    } catch (error) {
      if (!(error instanceof DecryptError)) throw error;
      throw new RemoteContentError(`the path of revision ${revision.id} does not decrypt`, { cause: error });
    }
  }

  /**
   * The plaintext content of a stored revision. A blob the server no longer
   * has (another run moved the revision and cleanup deleted it) re-reads the
   * revision and retries once; "moved" when it is no longer at that epoch.
   */
  private async openContent(revision: Revision, reread = false): Promise<Uint8Array | "moved"> {
    try {
      return await this.readContent(revision);
    } catch (error) {
      if (reread || errorCode(error) !== Code.NotFound) throw error;
    }
    const current = (await this.api.sync.getRevision({ vaultId: this.vaultId, revisionId: revision.id })).revision;
    if (current === undefined) throw new RemoteContentError(`revision ${revision.id} was not returned`);
    if (current.epoch !== revision.epoch || current.contentRef === undefined) return "moved";
    return this.openContent(current, true);
  }

  private async readContent(revision: Revision): Promise<Uint8Array> {
    const ref = revision.contentRef;
    if (ref === undefined) throw new RemoteContentError(`revision ${revision.id} has no content`);
    const blobId = bytesToHex(ref.blobId);
    if (revision.epoch === 0) return downloadContent(this.api, this.vaultId, blobId, ref.size);
    const key = await this.key(revision.epoch);
    const sealed = await downloadBlob(this.api, this.vaultId, blobId, ref.size);
    let content: Uint8Array;
    try {
      content = open(deriveSubkey(key, "content"), sealed, contentAad(this.vaultId, revision.epoch));
    } catch (error) {
      if (!(error instanceof DecryptError)) throw error;
      throw new RemoteContentError(`blob ${blobId} does not decrypt`, { cause: error });
    }
    if (!equalBytes(hmacBlobId(deriveSubkey(key, "blob_id_secret"), content), ref.blobId)) throw new RemoteContentError(`blob ${blobId} does not match its blob id`);
    return content;
  }

  /** Seals `content` under `target` and makes it a complete blob on the server. */
  private async sealContent(content: Uint8Array, target: number, targetKey: Uint8Array): Promise<SealedContent> {
    const blobId = hmacBlobId(deriveSubkey(targetKey, "blob_id_secret"), content);
    const id = `${String(target)}:${bytesToHex(blobId)}`;
    let sealed = this.sealed.get(id);
    if (sealed === undefined) {
      sealed = { blobId, sealed: seal(deriveSubkey(targetKey, "content"), content, contentAad(this.vaultId, target)) };
      this.sealed.set(id, sealed);
    }
    if (!(await isComplete(this.api, this.vaultId, blobId, BigInt(sealed.sealed.length)))) await uploadBlob(this.api, this.vaultId, blobId, sealed.sealed);
    return sealed;
  }

  /** Retires every epoch from 2 below `target`; retiring one already retired changes nothing. */
  private async retireBelow(target: number): Promise<number[]> {
    const retired: number[] = [];
    for (let epoch = 2; epoch < target; epoch++) {
      await this.api.vaultKeys.retireEpoch({ vaultId: this.vaultId, epoch });
      retired.push(epoch);
    }
    return retired;
  }

  /** The key of `epoch`, refreshing the device's keys once if it does not hold it. */
  private async key(epoch: number): Promise<Uint8Array> {
    let key = this.keys.epochKey(epoch);
    if (key === undefined) {
      await this.keys.refresh();
      key = this.keys.epochKey(epoch);
    }
    if (key === undefined) throw new VaultKeyUnavailableError(epoch);
    return key;
  }
}
