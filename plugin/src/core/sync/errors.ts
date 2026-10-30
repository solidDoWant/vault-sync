import { Code, ConnectError } from "@connectrpc/connect";

import { ErrorDetailSchema, ErrorReason } from "../../gen/vaultsync/v1/errors_pb";
import { DocumentSchema } from "../../gen/vaultsync/v1/types_pb";

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
 * A commit refused with FAILED_PRECONDITION and reason VAULT_ENCRYPTED: an
 * owner converted the vault to end-to-end encryption, and this device must
 * be unlocked before it can commit (docs/design/encryption.md).
 */
export function vaultEncrypted(error: unknown): boolean {
  return (
    error instanceof ConnectError &&
    error.code === Code.FailedPrecondition &&
    error.findDetails(ErrorDetailSchema).some((detail) => detail.reason === ErrorReason.VAULT_ENCRYPTED)
  );
}
