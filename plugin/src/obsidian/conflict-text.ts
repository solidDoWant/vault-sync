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
