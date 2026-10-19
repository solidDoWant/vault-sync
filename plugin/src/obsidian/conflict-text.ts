import type { RejectedReason } from "../core/engine/engine";
import type { ConflictReason } from "../core/journal/journal";
import type { UnmaterializableCause } from "../core/vaultpath/platform";

// The conflict view's wording (docs/plugin.md, "Conflicts"). No Obsidian
// import, so it is unit-tested directly.

/** Why the engine kept two versions, in the user's words. */
export function conflictReasonText(reason: ConflictReason): string {
  switch (reason) {
    case "overlapping-edits":
      return "Edited on this device and on another one, on the same lines.";
    case "binary":
      return "Edited on this device and on another one; this kind of file cannot be merged.";
    case "concurrent-create":
      return "Created on this device and on another one at the same path.";
    case "path-taken":
      return "Another document already had this path, so this device's document was moved.";
    case "base-purged":
      return "Edited on this device and on another one, but the version both started from is no longer kept on the server, so they could not be merged.";
  }
}

/** Why a document cannot be written on this device, in the user's words. */
export function unmaterializableReasonText(reason: UnmaterializableCause): string {
  switch (reason) {
    case "reserved-name":
      return "The name is reserved on this device's platform (such as CON or NUL on Windows).";
    case "forbidden-character":
      return "The path contains a character this device's platform does not allow in file names.";
    case "trailing-dot-or-space":
      return "A name in the path ends in a dot or a space, which this device's platform does not allow.";
    case "name-too-long":
      return "A name in the path is too long for this device's platform.";
    case "path-too-long":
      return "The path is too long for this device's platform.";
    case "refused-by-vault":
      return "This device refused to create a file at this path.";
  }
}

/** Why the server refuses a local file, in the user's words (#100); `detail` is the server's message, used for `refused`. */
export function rejectedReasonText(reason: RejectedReason, detail: string): string {
  switch (reason) {
    case "empty":
      return "The path is empty.";
    case "too-long":
      return "The path is longer than 4096 bytes, the server's limit.";
    case "invalid-character":
      return "The path contains a control character, such as a line break or a tab, which the server does not accept.";
    case "not-vault-relative":
      return "The path starts with a drive letter or a slash, or a folder or file name in it is made only of dots and spaces, which the server does not accept.";
    case "too-long-normalized":
      return "The path is longer than the server's limit of 8192 bytes once its letters are normalized.";
    case "backslash":
      return "The path contains a backslash (\\), which the server does not accept in a new path.";
    case "drive-prefix":
      return "The path starts with a character and a colon, which Windows reads as a drive.";
    case "path-taken":
      return "Another document has this path, and no other name for this file could be synced.";
    case "refused":
      return `The server refused it: ${detail}`;
  }
}

/**
 * `path` with every character that would not show (control characters, and
 * UTF-16 surrogates without their pair) written as `\uXXXX`, so the user can
 * see which name to fix.
 */
export function visiblePath(path: string): string {
  return path.replace(/\p{Cc}|[\ud800-\udfff]/gu, (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
}
