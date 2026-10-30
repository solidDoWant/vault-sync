// Rule M's three-way merge for `BLOB` documents, picked by the path's
// extension (docs/design/engine.md §5, SPEC.md §7). Every strategy returns
// null to fall back to the blob rule: the newer side at the path and the
// other as a conflict copy.

import { mergeBases } from "./bases-merge";
import { mergeCanvas } from "./canvas-merge";
import { mergeJson } from "./json-merge";
import { lineMergeExtensions, mergeLines } from "./line-merge";

type Strategy = (base: Uint8Array, local: Uint8Array, remote: Uint8Array) => Uint8Array | null;

/** The merge for a `BLOB` at `path`, or null when its type is only handled by the blob rule. */
export function blobMergeFor(path: string): Strategy | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  if (extension === "base") return mergeBases;
  if (extension === "canvas") return mergeCanvas;
  if (extension === "json") return mergeJson;
  if (lineMergeExtensions.has(extension)) return (base, local, remote) => mergeLines(extension, base, local, remote);
  return null;
}

/** The merged content, or null when the merge falls back; a failure inside a merge (deep nesting, say) also falls back. */
export function mergeBlob(path: string, base: Uint8Array, local: Uint8Array, remote: Uint8Array): Uint8Array | null {
  const strategy = blobMergeFor(path);
  if (strategy === null) return null;
  try {
    return strategy(base, local, remote);
  } catch {
    return null;
  }
}
