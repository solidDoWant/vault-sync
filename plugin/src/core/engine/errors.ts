import { Code, ConnectError } from "@connectrpc/connect";

import { DocumentSchema } from "../../gen/vaultsync/v1/types_pb";
import type { PendingOperation } from "../journal/journal";

/** The Connect code of `error`, or undefined if it is not a ConnectError. */
export function errorCode(error: unknown): Code | undefined {
  return error instanceof ConnectError ? error.code : undefined;
}

/** A CommitRevision refused because the document's head moved: FAILED_PRECONDITION carrying the document (SPEC.md §6.2). */
export function headMoved(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.FailedPrecondition && error.findDetails(DocumentSchema).length > 0;
}

/**
 * A CommitRevision refused with FAILED_PRECONDITION without a document
 * detail: its content_ref is not a complete blob (SPEC.md §6.2), as when blob
 * garbage collection removed it (§11). Uploading the content again fixes it.
 */
export function blobMissing(error: unknown): boolean {
  return errorCode(error) === Code.FailedPrecondition && !headMoved(error);
}

/**
 * A CommitRevision of `operation`, which has a base, refused with
 * FAILED_PRECONDITION without a document detail once its content is
 * uploaded: the document does not exist (SPEC.md §6.2), so the server lost
 * the base, as a restore does (#861, PO-12). Uploading again cannot fix it;
 * the resync after the pull does.
 */
export function baseLost(error: unknown, operation: Pick<PendingOperation, "baseRevisionId">): boolean {
  return operation.baseRevisionId !== "" && blobMissing(error);
}
