// The structural three-way merge shared by rule M's strategies for parsed
// files (Bases, JSON Canvas, JSON): maps merge per key, a change on one side
// is taken, identical changes are accepted, and two different changes to one
// value, or a deletion on one side against a change on the other, conflict.

import { isMap, type YamlMap, type YamlValue } from "./bases-schema";

/** A parsed YAML or JSON value. */
export type TreeValue = YamlValue;

/** A parsed mapping. */
export type TreeMap = YamlMap;

export { isMap };

/** A conflicting change: the merge falls back to the blob rule. */
export const conflict = Symbol("conflict");
export type Merged = TreeValue | undefined | typeof conflict;

/** A merged key that is absent: distinct from trivial's "not decided". */
const absent = Symbol("absent");

/** The merge when at most one side changed `base`, or both made the same change; undefined otherwise. */
function trivial(base: Merged, local: Merged, remote: Merged): Merged | typeof absent | undefined {
  if (equal(local, remote)) return local === undefined ? absent : local;
  if (equal(base, local)) return remote === undefined ? absent : remote;
  if (equal(base, remote)) return local === undefined ? absent : local;
  return undefined;
}

/** The trivial merge, or `undecided` when both sides changed `base` differently. */
export const undecided = Symbol("undecided");
export function decide(base: Merged, local: Merged, remote: Merged): Merged | typeof undecided {
  const decided = trivial(base, local, remote);
  if (decided === undefined) return undecided;
  return decided === absent ? undefined : decided;
}

/** Any value: maps changed on both sides merge per key; any other two different changes conflict. */
export function mergeValue(base: Merged, local: Merged, remote: Merged): Merged {
  return mergeMaps(base, local, remote, (_key, b, l, r) => mergeValue(b, l, r));
}

export type KeyMerge = (key: string, base: Merged, local: Merged, remote: Merged) => Merged;

/** Both sides changed: maps on both sides merge per key (a missing base counting as empty); anything else conflicts. */
export function mergeMaps(base: Merged, local: Merged, remote: Merged, mergeKey: KeyMerge): Merged {
  const decided = decide(base, local, remote);
  if (decided !== undecided) return decided;
  if (!isMap(local) || !isMap(remote)) return conflict;
  if (base === undefined) return mergeMap({}, local, remote, mergeKey);
  if (!isMap(base)) return conflict;
  return mergeMap(base, local, remote, mergeKey);
}

/** Per key, in the order: the base's keys, then local additions, then remote additions. */
export function mergeMap(base: TreeMap, local: TreeMap, remote: TreeMap, mergeKey: KeyMerge): Merged {
  const merged: TreeMap = {};
  for (const key of unionKeys(base, local, remote)) {
    const value = mergeKey(key, own(base, key), own(local, key), own(remote, key));
    if (value === conflict) return conflict;
    // defineProperty, not assignment: a "__proto__" key is data, not the prototype.
    if (value !== undefined) Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return merged;
}

/**
 * A list of maps matched by the string field `idKey`, each item merged with
 * `mergeItem`. Order: the base's, then local additions, then remote
 * additions; a side that reordered the items all three keep conflicts, so a
 * reordering is never dropped. A list without unique string ids on every side
 * conflicts.
 */
export function mergeById(base: Merged, local: Merged, remote: Merged, idKey: string, mergeItem: KeyMerge): Merged {
  const decided = decide(base, local, remote);
  if (decided !== undecided) return decided;
  const baseItems = base === undefined ? new Map<string, TreeValue>() : byId(base, idKey);
  const localItems = byId(local, idKey);
  const remoteItems = byId(remote, idKey);
  if (baseItems === null || localItems === null || remoteItems === null) return conflict;
  const kept = [...baseItems.keys()].filter((id) => localItems.has(id) && remoteItems.has(id));
  const baseOrder = kept;
  if (!equal([...localItems.keys()].filter((id) => kept.includes(id)), baseOrder)) return conflict;
  if (!equal([...remoteItems.keys()].filter((id) => kept.includes(id)), baseOrder)) return conflict;
  const merged: TreeValue[] = [];
  for (const id of unionKeys(baseItems, localItems, remoteItems)) {
    const item = mergeItem(id, baseItems.get(id), localItems.get(id), remoteItems.get(id));
    if (item === conflict) return conflict;
    if (item !== undefined) merged.push(item);
  }
  return merged;
}

function byId(items: Merged, idKey: string): Map<string, TreeValue> | null {
  if (!Array.isArray(items)) return null;
  const found = new Map<string, TreeValue>();
  for (const item of items) {
    if (!isMap(item)) return null;
    const id = own(item, idKey);
    if (typeof id !== "string" || found.has(id)) return null;
    found.set(id, item);
  }
  return found;
}

export function own(map: TreeMap, key: string): TreeValue | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function unionKeys(...maps: (TreeMap | Map<string, unknown> | string[])[]): string[] {
  const keys = new Set<string>();
  for (const map of maps) {
    const names = Array.isArray(map) ? map : map instanceof Map ? [...map.keys()] : Object.keys(map);
    for (const name of names) keys.add(name);
  }
  return [...keys];
}

/** Deep equality: arrays in order, maps regardless of key order. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  if (isMap(a) && isMap(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return false;
}

/** A key equal for equal values, maps regardless of key order. */
export function canonical(value: TreeValue): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: TreeValue): TreeValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isMap(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, item]) => [key, sortKeys(item)]));
}
