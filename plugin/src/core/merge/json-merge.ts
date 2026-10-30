// Three-way structural merge of JSON (`.json`) files, rule M's strategy for
// them within the blob rule (docs/design/engine.md §5, SPEC.md §7). Objects
// merge per key with the shared tree-merge core; an array is one value, as
// JSON has no identity for array items.

import { conflict, equal, mergeValue, type Merged, type TreeValue } from "./tree-merge";

const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Merges `local` and `remote`, two versions of a JSON file derived from
 * `base`. Returns null, so the caller keeps the blob rule, when a side is not
 * JSON or both sides made conflicting changes.
 */
export function mergeJson(base: Uint8Array, local: Uint8Array, remote: Uint8Array): Uint8Array | null {
  return mergeParsed(base, local, remote, parseJson, mergeValue, () => true);
}

/** A JSON value, or null when `bytes` are not UTF-8 JSON. */
export function parseJson(bytes: Uint8Array): { value: TreeValue } | null {
  try {
    return { value: JSON.parse(strictDecoder.decode(bytes)) as TreeValue };
  } catch {
    return null;
  }
}

/**
 * Parses the three sides, merges them and validates the result. When the
 * merge equals one side's value, that side's bytes are returned unchanged;
 * otherwise the value is written in the local side's indentation.
 */
export function mergeParsed(
  base: Uint8Array,
  local: Uint8Array,
  remote: Uint8Array,
  parse: (bytes: Uint8Array) => { value: TreeValue } | null,
  merge: (base: Merged, local: Merged, remote: Merged) => Merged,
  valid: (value: TreeValue) => boolean,
): Uint8Array | null {
  const parsedBase = parse(base);
  const parsedLocal = parse(local);
  const parsedRemote = parse(remote);
  if (parsedBase === null || parsedLocal === null || parsedRemote === null) return null;
  const merged = merge(parsedBase.value, parsedLocal.value, parsedRemote.value);
  if (merged === conflict || merged === undefined || !valid(merged)) return null;
  if (equal(merged, parsedLocal.value)) return local;
  if (equal(merged, parsedRemote.value)) return remote;
  return encoder.encode(stringifyLike(merged, strictDecoder.decode(local)));
}

/** `value` as JSON, indented like `sample` (tabs, its first indent's spaces, or none) and with its final newline. */
function stringifyLike(value: TreeValue, sample: string): string {
  const indent = /\n([\t ]+)\S/.exec(sample)?.[1] ?? "";
  const text = JSON.stringify(value, null, indent.startsWith("\t") ? "\t" : indent.length);
  return sample.endsWith("\n") ? `${text}\n` : text;
}
