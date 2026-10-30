// Three-way merge of Obsidian Bases (`.base`) files, rule M's strategy for
// them within the blob rule (docs/design/engine.md §5, SPEC.md §7).
//
// YAML is read and written with js-yaml (about 40 KB minified), chosen over
// injecting Obsidian's `parseYaml`/`stringifyYaml` so the merge stays
// platform-independent and its tests run the codec the plugin ships; Obsidian
// is understood to use js-yaml itself. Guarantee: when the merged content equals
// one side's (as a parsed value), that side's bytes are returned unchanged;
// otherwise the merged value is written by js-yaml, which keeps key order but
// drops comments.

import { CORE_SCHEMA, dump, load } from "js-yaml";
import { isMap, isValidBase, type YamlMap, type YamlValue } from "./bases-schema";
import { canonical, conflict, decide, equal, mergeMap, mergeMaps, mergeValue, type Merged, undecided, unionKeys } from "./tree-merge";

const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Merges `local` and `remote`, two versions of a `.base` file derived from
 * `base`. Returns null, so the caller keeps the blob rule, when a side fails to
 * parse or validate, when both sides made conflicting changes, or when the
 * merged result fails validation. Never writes conflict markers.
 */
export function mergeBases(base: Uint8Array, local: Uint8Array, remote: Uint8Array): Uint8Array | null {
  const parsedBase = parse(base);
  const parsedLocal = parse(local);
  const parsedRemote = parse(remote);
  if (parsedBase === null || parsedLocal === null || parsedRemote === null) return null;
  const merged = mergeRoot(parsedBase, parsedLocal, parsedRemote);
  if (merged === conflict || !isValidBase(merged)) return null;
  if (equal(merged, parsedLocal)) return local;
  if (equal(merged, parsedRemote)) return remote;
  return encoder.encode(dump(merged, { schema: CORE_SCHEMA, lineWidth: -1, noRefs: true }));
}

/** The parsed, valid `.base` content, or null. An empty file is an empty base. */
export function parse(bytes: Uint8Array): YamlMap | null {
  let value: unknown;
  try {
    value = load(strictDecoder.decode(bytes), { schema: CORE_SCHEMA });
  } catch {
    return null;
  }
  if (value === undefined || value === null) value = {};
  return isValidBase(value) ? value : null;
}

function mergeRoot(base: YamlMap, local: YamlMap, remote: YamlMap): Merged {
  return mergeMap(base, local, remote, (key, b, l, r) => {
    if (key === "views") return mergeViews(b, l, r);
    if (key === "filters") return mergeFilter(b, l, r);
    return mergeValue(b, l, r);
  });
}

function mergeView(base: Merged, local: Merged, remote: Merged): Merged {
  return mergeMaps(base, local, remote, (key, b, l, r) => (key === "filters" ? mergeFilter(b, l, r) : mergeValue(b, l, r)));
}

/** Views match by name; without unique names on every side the list is one value. */
function mergeViews(base: Merged, local: Merged, remote: Merged): Merged {
  const decided = decide(base, local, remote);
  if (decided !== undecided) return decided;
  const baseViews = base === undefined ? new Map<string, YamlValue>() : byName(base);
  const localViews = byName(local);
  const remoteViews = byName(remote);
  if (baseViews === null || localViews === null || remoteViews === null) return conflict;
  const merged = new Map<string, YamlValue>();
  for (const name of unionKeys(baseViews, localViews, remoteViews)) {
    const view = mergeView(baseViews.get(name), localViews.get(name), remoteViews.get(name));
    if (view === conflict) return conflict;
    if (view !== undefined) merged.set(name, view);
  }
  // Order: a reordering made on one side only is kept; both reordering the views differently conflicts.
  const order = mergeOrder([...baseViews.keys()], [...localViews.keys()], [...remoteViews.keys()], [...merged.keys()]);
  if (order === null) return conflict;
  return order.flatMap((name) => {
    const view = merged.get(name);
    return view === undefined ? [] : [view];
  });
}

function byName(views: Merged): Map<string, YamlValue> | null {
  if (!Array.isArray(views)) return null;
  const named = new Map<string, YamlValue>();
  for (const view of views) {
    if (!isMap(view) || typeof view["name"] !== "string" || named.has(view["name"])) return null;
    named.set(view["name"], view);
  }
  return named;
}

/** The merged names' order: the local order unless only the remote side reordered the names both kept. */
function mergeOrder(base: string[], local: string[], remote: string[], merged: string[]): string[] | null {
  const kept = new Set(merged);
  const common = (names: string[]) => names.filter((name) => kept.has(name) && local.includes(name) && remote.includes(name) && base.includes(name));
  const baseOrder = common(base);
  const localOrder = common(local);
  const remoteOrder = common(remote);
  const localMoved = !equal(localOrder, baseOrder);
  const remoteMoved = !equal(remoteOrder, baseOrder);
  if (localMoved && remoteMoved && !equal(localOrder, remoteOrder)) return null;
  const leading = remoteMoved && !localMoved ? remote : local;
  return unionKeys(leading.filter((name) => kept.has(name)), local.filter((name) => kept.has(name)), remote.filter((name) => kept.has(name)));
}

/** `and`/`or` lists merge as sets; any other filter change is one value. */
function mergeFilter(base: Merged, local: Merged, remote: Merged): Merged {
  const decided = decide(base, local, remote);
  if (decided !== undecided) return decided;
  const operator = setOperator(base, local, remote);
  if (operator === null) return conflict;
  const baseItems = (base as YamlMap)[operator] as YamlValue[];
  const localItems = (local as YamlMap)[operator] as YamlValue[];
  const remoteItems = (remote as YamlMap)[operator] as YamlValue[];
  const removed = new Set(baseItems.filter((item) => !includes(localItems, item) || !includes(remoteItems, item)).map(canonical));
  const merged: YamlValue[] = [];
  const seen = new Set<string>();
  for (const item of [...baseItems, ...localItems, ...remoteItems]) {
    const key = canonical(item);
    if (removed.has(key) || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return { [operator]: merged };
}

/** The `and` or `or` operator when all three sides are filter objects with it, else null. */
function setOperator(...filters: Merged[]): "and" | "or" | null {
  const first = filters[0];
  if (!isMap(first)) return null;
  const operator = Object.keys(first)[0];
  if (operator !== "and" && operator !== "or") return null;
  for (const filter of filters) {
    if (!isMap(filter) || Object.keys(filter).length !== 1 || !Array.isArray(filter[operator])) return null;
  }
  return operator;
}

function includes(items: YamlValue[], item: YamlValue): boolean {
  return items.some((candidate) => equal(candidate, item));
}
