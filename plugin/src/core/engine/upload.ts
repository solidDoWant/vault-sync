import { Code } from "@connectrpc/connect";
import { hexToBytes } from "@noble/hashes/utils.js";

import { sha256Hex } from "../hash";
import { RemoteContentError, type PullApi } from "./remote";
import { errorCode } from "./errors";

/** Attempts to upload one blob when another uploader of the same blob races this one (SPEC.md §6.2). */
const maxUploadAttempts = 3;

/**
 * Whether the blob is complete on the server (`complete`), or could not be
 * uploaded because the local content no longer has the expected hash
 * (`missing`: it changed or disappeared since the operation was recorded).
 */
export type UploadResult = "complete" | "missing";

/**
 * Uploads a blob (SPEC.md §6.2 step 1): BeginBlob, then PutBlobChunk from the
 * bytes the server already holds, in chunks of at most the server's
 * max_chunk_size, then CommitBlob. An already-complete blob short-circuits,
 * and an interrupted upload resumes where the server's session stands, so no
 * chunk the server stored is sent again. The content is read and checked
 * against `contentHash` before BeginBlob, so content that changed or
 * disappeared since the operation was recorded never opens an upload session
 * (#370): the blob is then only looked up, with a zero-length DownloadBlob,
 * and is `complete` if the server already holds it, `missing` otherwise.
 *
 * A FAILED_PRECONDITION or NOT_FOUND from PutBlobChunk or CommitBlob means
 * another uploader of the same blob advanced, finished or lost the shared
 * session, or that the server reclaimed the session after it sat idle with
 * the vault at its session limit (SPEC.md §6.2); the upload then resumes
 * from BeginBlob, with a new session if needed, a bounded number of times.
 */
export async function uploadContent(
  api: PullApi,
  vaultId: string,
  contentHash: string,
  size: bigint,
  readContent: () => Promise<Uint8Array | null>,
): Promise<UploadResult> {
  const blobId = hexToBytes(contentHash);
  const content = await readContent();
  if (content === null || BigInt(content.length) !== size || sha256Hex(content) !== contentHash) return (await isComplete(api, vaultId, blobId, size)) ? "complete" : "missing";
  for (let attempt = 1; ; attempt++) {
    const begin = await api.blobs.beginBlob({ vaultId, blobId, size });
    if (begin.complete) return "complete";
    if (begin.maxChunkSize === 0) throw new RemoteContentError("BeginBlob reported a maximum chunk size of 0");
    if (begin.receivedSize > size) throw new RemoteContentError(`BeginBlob reported ${String(begin.receivedSize)} bytes received of ${String(size)}`);
    try {
      let offset = Number(begin.receivedSize);
      while (offset < content.length) {
        const end = Math.min(content.length, offset + begin.maxChunkSize);
        const put = await api.blobs.putBlobChunk({ vaultId, blobId, offset: BigInt(offset), data: content.subarray(offset, end) });
        if (put.receivedSize <= BigInt(offset) || put.receivedSize > size) {
          throw new RemoteContentError(`PutBlobChunk at ${String(offset)} reported ${String(put.receivedSize)} bytes received of ${String(size)}`);
        }
        offset = Number(put.receivedSize);
      }
      await api.blobs.commitBlob({ vaultId, blobId });
      return "complete";
    } catch (error) {
      const code = errorCode(error);
      const raced = code === Code.FailedPrecondition || code === Code.NotFound;
      if (!raced || attempt >= maxUploadAttempts) throw error;
    }
  }
}

/** Whether the server holds the blob complete, looked up without opening an upload session or reading its content. */
async function isComplete(api: PullApi, vaultId: string, blobId: Uint8Array, size: bigint): Promise<boolean> {
  try {
    // A range starting at the blob's end returns no bytes, only its size.
    const response = await api.blobs.downloadBlob({ vaultId, blobId, offset: size, length: 1 });
    if (response.size !== size) throw new RemoteContentError(`blob has size ${String(response.size)}, expected ${String(size)}`);
    return true;
  } catch (error) {
    if (errorCode(error) === Code.NotFound) return false;
    throw error;
  }
}
