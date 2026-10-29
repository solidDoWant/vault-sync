import type { SkipReason } from "../core/sync/journal";
import type { UnmaterializableCause } from "../core/vaultpath/platform";

// The conflict view's wording (docs/plugin.md, "Conflicts"). No Obsidian
// import, so it is unit-tested directly.

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
    case "alias":
      return "Another note's file already has this name on this device, which does not tell the two names apart.";
  }
}

/** Why a remote document is not on this device (docs/design/engine.md §6, §7), in the user's words. */
export function skippedReasonText(reason: SkipReason, size: number): string {
  if (reason === "too-large") return tooLargeText(BigInt(size));
  if (reason === "temporary-name") return temporaryNameText;
  return unmaterializableReasonText(reason);
}

/** Why a document named like Vault Sync's temporary files is not written on this device. */
const temporaryNameText = "The name ends like Vault Sync's temporary files (.vault-sync-tmp or .vault-sync-new), which this device removes. Rename it on another device to sync it here.";

/** Why a document is not downloaded on this device: its size, in the user's words. */
export function tooLargeText(size: bigint): string {
  return `Its newest version is ${formatBytes(size)}, more than the size limit.`;
}

/** Why a local file is not uploaded: its size, in the user's words. */
export function tooLargeUploadText(size: number): string {
  return `It is ${formatBytes(BigInt(size))}, more than the size limit, so it stays on this device only.`;
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
