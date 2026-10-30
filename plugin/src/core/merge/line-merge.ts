// Line-based three-way merge of plain-text files (CSV, source code, markup),
// rule M's strategy for them within the blob rule (docs/design/engine.md §5,
// SPEC.md §7). It uses diff3 semantics (node-diff3, MIT): changes to different
// lines combine, and any overlapping change refuses the merge rather than
// being patched fuzzily, which could silently break CSV or code.

import { loadAll } from "js-yaml";
import { diff3Merge } from "node-diff3";
import { parse as parseToml } from "smol-toml";

/** The extensions merged line by line, lower case and without the dot. */
export const lineMergeExtensions: ReadonlySet<string> = new Set([
  "txt",
  "csv",
  "tsv",
  "css",
  "js",
  "ts",
  "py",
  "sh",
  "html",
  "xml",
  "tex",
  "org",
  "rst",
  "yaml",
  "yml",
  "toml",
]);

/** Above this many bytes on any side the file is not merged line by line. */
export const maxLineMergeBytes = 1 << 20;

const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Merges `local` and `remote`, two versions of a plain-text file at a path
 * with extension `extension` derived from `base`. Returns null, so the caller
 * keeps the blob rule, when a side is over maxLineMergeBytes or not UTF-8,
 * when the changes overlap, or when a YAML or TOML result no longer parses.
 * Never writes conflict markers.
 */
export function mergeLines(extension: string, base: Uint8Array, local: Uint8Array, remote: Uint8Array): Uint8Array | null {
  if (base.length > maxLineMergeBytes || local.length > maxLineMergeBytes || remote.length > maxLineMergeBytes) return null;
  const baseText = decode(base);
  const localText = decode(local);
  const remoteText = decode(remote);
  if (baseText === null || localText === null || remoteText === null) return null;
  const regions = diff3Merge(lines(localText), lines(baseText), lines(remoteText), { excludeFalseConflicts: true });
  const merged: string[] = [];
  for (const region of regions) {
    if (region.ok === undefined) return null;
    merged.push(...region.ok);
  }
  const text = merged.join("");
  if (!parses(extension, text)) return null;
  if (text === localText) return local;
  if (text === remoteText) return remote;
  return encoder.encode(text);
}

function decode(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** The lines of `text`, each with its line ending, so joining them gives `text` back. */
function lines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

/** Whether a merged YAML or TOML file still parses; other formats are not checked. */
function parses(extension: string, text: string): boolean {
  try {
    if (extension === "yaml" || extension === "yml") loadAll(text);
    else if (extension === "toml") parseToml(text);
    return true;
  } catch {
    return false;
  }
}

