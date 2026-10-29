import type { SkippedEntry } from "../core/sync/journal";
import { skippedReasonText } from "./conflict-text";
import { visiblePath } from "./display-text";

// The notices about paths that may not sync everywhere (docs/design/engine.md
// §6). No Obsidian import, so they are unit-tested directly.

/** A new path longer than this many characters, relative to the vault, gets a warning. */
export const longPathWarningLength = 200;

/** The warning for a path the user created, or undefined if it is short enough. */
export function longPathWarning(path: string): string | undefined {
  // UTF-16 code units, as Windows counts its path limit.
  const length = path.length;
  if (length <= longPathWarningLength) return undefined;
  return `Vault Sync: "${visiblePath(path)}" is ${String(length)} characters long, longer than ${String(longPathWarningLength)} characters. Devices with a shorter path limit, such as Windows, may not be able to store it, and it is then not synced to them.`;
}

/**
 * The notices for remote documents this device skips (§6, §7): each skipped
 * document is named once per reason, the first time it shows up.
 */
export class SkipNotices {
  private readonly noticed = new Set<string>();

  /** A notice for each entry of `skipped` not noticed before. */
  fresh(skipped: readonly SkippedEntry[]): string[] {
    const notices: string[] = [];
    for (const entry of skipped) {
      const key = `${entry.documentId}\n${entry.reason}`;
      if (this.noticed.has(key)) continue;
      this.noticed.add(key);
      notices.push(`Vault Sync: "${visiblePath(entry.path)}" is not synced to this device. ${skippedReasonText(entry.reason, entry.size)} It stays on the server and on your other devices; Show conflicts lists it.`);
    }
    return notices;
  }
}
