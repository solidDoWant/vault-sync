import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import type { Revision } from "../../gen/vaultsync/v1/types_pb";
import { sha256Hex } from "../hash";
import { unmaterializableReason, type PathRules } from "../vaultpath/platform";
import { pathProblem } from "../vaultpath/vaultpath";
import { blobMissing, errorCode, headMoved } from "./errors";
import { downloadContent, downloadStart, RemoteContentError, toIncoming, type DocumentKindName, type PullApi, type RemoteRevision } from "./remote";
import { uploadContent } from "./upload";

/** One retained revision of a document, as the history view shows it (SPEC.md §11). */
export interface HistoryEntry {
  revisionId: string;
  documentId: string;
  seq: bigint;
  /** The document's path at this revision. */
  path: string;
  /** Whether this revision is a tombstone: the document was deleted. Its content is what the document held then. */
  deleted: boolean;
  kind: DocumentKindName;
  contentHash: string;
  size: bigint;
  /** The user that committed the revision. */
  userId: string;
  /** That user's display name, if the server named them (docs/design/sharing.md, Attribution). */
  userName: string | undefined;
  /** The device that committed the revision. */
  deviceId: string;
  /** That device's registered name, if the server named it. */
  deviceName: string | undefined;
  /** Whether that is this device. */
  thisDevice: boolean;
  /** When the server accepted the revision; undefined if the server did not say. */
  createdAt: Date | undefined;
}

/** One page of a document's history, newest first. */
export interface HistoryPage {
  documentId: string;
  /** The document's current head revision. */
  headRevisionId: string;
  entries: HistoryEntry[];
  /** Pass to the next call for older revisions; empty when there are none. */
  nextPageToken: string;
}

export type RestoreFailure =
  /** Another live document holds the path the document would come back at (a deleted document's path was reused). */
  | "path-taken"
  /** Retention purged the revision and its content is gone from the server, and no preview of it was at hand. */
  | "unavailable"
  /** The other path chosen for the restore is one the server would refuse, this device cannot hold, or this vault does not sync now. */
  | "invalid-path";

/** A restore that cannot be done; nothing was committed. */
export class RestoreError extends Error {
  override readonly name = "RestoreError";
  constructor(
    readonly reason: RestoreFailure,
    /** The path the document would have come back at. */
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** Attempts of one restore's commit: a moved head, a collected blob or a transient failure each cost one. */
const maxRestoreAttempts = 5;

/** Reads one page of a document's history (GetDocumentHistory), newest first. */
export async function documentHistory(api: PullApi, vaultId: string, deviceId: string, documentId: string, pageToken = "", pageSize = 0): Promise<HistoryPage> {
  const response = await api.sync.getDocumentHistory({ vaultId, documentId, pageToken, pageSize });
  if (response.document === undefined) throw new RemoteContentError(`GetDocumentHistory for ${documentId} returned no document`);
  const names = new Map(response.deviceNames.map((device) => [device.deviceId, device.name]));
  const users = new Map(response.userNames.map((user) => [user.userId, user.name]));
  return {
    documentId: response.document.id,
    headRevisionId: response.document.headRevId,
    entries: response.revisions.map((revision) => historyEntry(revision, deviceId, names.get(revision.deviceId), users.get(revision.userId))),
    nextPageToken: response.nextPageToken,
  };
}

function historyEntry(revision: Revision, deviceId: string, deviceName: string | undefined, userName: string | undefined): HistoryEntry {
  const { remote } = toIncoming(revision);
  return {
    revisionId: remote.revisionId,
    documentId: remote.documentId,
    seq: remote.seq,
    path: remote.path,
    deleted: remote.deleted,
    kind: remote.kind,
    contentHash: remote.contentHash,
    size: remote.size,
    userId: revision.userId,
    userName,
    deviceId: revision.deviceId,
    deviceName,
    thisDevice: revision.deviceId !== "" && revision.deviceId === deviceId,
    createdAt: revision.createTime === undefined ? undefined : timestampDate(revision.createTime),
  };
}

/**
 * Downloads a history entry's content, verified against its hash. With
 * `limit`, an entry larger than that is read only as far as its first
 * `limit` bytes (#656), for a preview: that start is not verified, and a
 * result shorter than `entry.size` is never the content to restore.
 */
export function readRevision(api: PullApi, vaultId: string, entry: HistoryEntry, limit?: number): Promise<Uint8Array> {
  if (limit !== undefined && entry.size > BigInt(limit)) return downloadStart(api, vaultId, entry.contentHash, entry.size, limit);
  return downloadContent(api, vaultId, entry.contentHash, entry.size);
}

/**
 * Commits `entry`'s content as a new revision of its document (SPEC.md §11):
 * based on the current head, at the head's path, never a tombstone, so a
 * deleted document comes back. A head that moves meanwhile is fetched again
 * and the commit retried on it. A commit refused because the content is no
 * longer a complete blob (garbage collection after a purge) uploads it again,
 * from `content` (a preview the caller holds) if it matches, or else from a
 * download; if neither has it, RestoreError `unavailable`. A path another
 * live document holds is RestoreError `path-taken`. With `path` it commits
 * there instead (#420): how a deleted document whose path another document
 * took comes back; check it with restorePathProblem first.
 */
export async function commitRestore(api: PullApi, vaultId: string, deviceId: string, entry: HistoryEntry, revisionId: string, content?: Uint8Array, path?: string): Promise<RemoteRevision> {
  let head = await currentHead(api, vaultId, entry.documentId);
  let held = content !== undefined && BigInt(content.length) === entry.size && sha256Hex(content) === entry.contentHash ? content : undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await api.sync.commitRevision({
        vaultId,
        documentId: entry.documentId,
        revisionId,
        baseRevId: head.id,
        kind: head.kind,
        contentRef: { blobId: hexToBytes(entry.contentHash), size: entry.size },
        path: path === undefined ? head.path : new TextEncoder().encode(path),
        deleted: false,
        deviceId,
      });
      const revision = response.revision;
      if (revision?.id !== revisionId || revision.documentId !== entry.documentId) throw new RemoteContentError(`CommitRevision for ${revisionId} returned another revision`);
      return toIncoming(revision).remote;
    } catch (error) {
      const target = path ?? new TextDecoder().decode(head.path);
      if (errorCode(error) === Code.AlreadyExists) throw new RestoreError("path-taken", target, `another file is at ${target} now; move it away or restore at another path`);
      if (attempt >= maxRestoreAttempts) throw error;
      if (headMoved(error)) {
        head = await currentHead(api, vaultId, entry.documentId);
      } else if (blobMissing(error)) {
        held ??= await downloadOrNull(api, vaultId, entry);
        const bytes = held;
        if (bytes === undefined) throw new RestoreError("unavailable", target, "this version is no longer stored on the server");
        await uploadContent(api, vaultId, entry.contentHash, entry.size, () => Promise.resolve(bytes));
      } else if (!transient(error)) {
        throw error;
      }
    }
  }
}

/**
 * Why a document cannot be restored at `path`, another path than its own
 * (#420): a path the server refuses for a new document (SPEC.md §6.2), one
 * this platform cannot hold (`rules`, §8), or one outside what this vault
 * syncs now (`inScope`), where the restored file would not show up. A
 * RestoreError `invalid-path`, or undefined if the path will do.
 */
export function restorePathProblem(path: string, rules: PathRules, inScope: (path: string) => boolean): RestoreError | undefined {
  const problem = pathProblem(path) ?? unmaterializableReason(path, rules) ?? (inScope(path) ? undefined : "not synced");
  if (problem === undefined) return undefined;
  return new RestoreError("invalid-path", path, `${path === "" ? "an empty path" : path} cannot be used (${problem}); choose another path`);
}

/** The document's head revision. */
async function currentHead(api: PullApi, vaultId: string, documentId: string): Promise<Revision> {
  const response = await api.sync.getDocumentHistory({ vaultId, documentId, pageSize: 1 });
  const head = response.revisions[0];
  if (head === undefined || head.id !== response.document?.headRevId) throw new RemoteContentError(`GetDocumentHistory for ${documentId} did not start with the head`);
  return head;
}

async function downloadOrNull(api: PullApi, vaultId: string, entry: HistoryEntry): Promise<Uint8Array | undefined> {
  try {
    return await readRevision(api, vaultId, entry);
  } catch (error) {
    if (errorCode(error) === Code.NotFound) return undefined;
    throw error;
  }
}

function transient(error: unknown): boolean {
  const code = errorCode(error);
  return code === Code.Unavailable || code === Code.DeadlineExceeded;
}
