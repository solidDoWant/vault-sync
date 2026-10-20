import type { DeferredDocumentReason } from "../core/engine/deferred";
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

/** Why a document is not downloaded on this device (#316): its size, in the user's words. */
export function tooLargeText(size: bigint): string {
  return `Its newest version is ${formatBytes(size)}, more than this device downloads.`;
}

/** `size` in bytes as B, KiB, MiB, GiB or TiB, with one decimal above bytes. */
export function formatBytes(size: bigint): string {
  const units = ["KiB", "MiB", "GiB", "TiB"];
  if (size < 1024n) return `${String(size)} B`;
  let value = Number(size) / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "TiB"}`;
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

/**
 * Why the vault refused a remote revision's path (`path-conflict`), as far as
 * the path tells: Obsidian would store it under another name (`normalize`,
 * Obsidian's normalizePath, rewrites it: letters not in Unicode NFC form, a
 * non-breaking space, doubled or edge slashes), a name in it is hidden (starts
 * with a dot), or else something on this device is in the way.
 */
export type PathConflictCause = "renamed-by-obsidian" | "hidden" | "occupied";

export function pathConflictCause(path: string, normalize: (path: string) => string): PathConflictCause {
  if (normalize(path) !== path) return "renamed-by-obsidian";
  if (path.split("/").some((segment) => segment.startsWith("."))) return "hidden";
  return "occupied";
}

/** Why a remote revision waits for its path (#417), in the user's words; `cause` explains a `path-conflict`. */
export function deferredReasonText(reason: DeferredDocumentReason, cause: PathConflictCause): string {
  switch (reason) {
    case "invalid-path":
      return "Its path on the server is not a valid path for a file in a vault (it starts with a slash or a drive letter, has a name made only of dots, contains a control character, or is not valid text).";
    case "out-of-scope":
      return "Another device moved it to a path this device does not sync, such as one in the config folder. The version on this device stays where it is, and its changes are not synced.";
    case "path-conflict":
      switch (cause) {
        case "renamed-by-obsidian":
          return "Obsidian would store its path under another name: Obsidian rewrites letters written in another Unicode form (such as an accent typed as a separate character) and non-breaking spaces. Rename it on another device to bring it here.";
        case "hidden":
          return "A folder or file name in its path starts with a dot, which Obsidian hides and this vault does not sync.";
        case "occupied":
          return "A file or folder on this device is in the way at its path. It arrives once the path is free.";
      }
  }
}

/** Why a pull could not write a file open in a view (#417), in the user's words. */
export function openViewText(path: string): string {
  return `"${visiblePath(path)}" is open in a view that cannot take the incoming change: an editor whose unsaved edits overlap it, a canvas or another plugin's view with unsaved changes, or content that is not text. Sync waits at this change; save or close the file to let it continue.`;
}
