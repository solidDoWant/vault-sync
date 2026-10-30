// Three-way merge of JSON Canvas (`.canvas`) files, rule M's strategy for them
// within the blob rule (docs/design/engine.md §5, SPEC.md §7).
//
// The schema is written from the JSON Canvas 1.0 spec,
// https://jsoncanvas.org/spec/1.0/ (MIT; checked 2026-10-30), which publishes
// no JSON Schema. It is strict on the types of the documented fields and keeps
// unknown fields (plugin extensions) as any value. Groups in 1.0 have no list
// of children (membership is geometric), so the cross-references checked are
// edge endpoints.

import { mergeParsed, parseJson } from "./json-merge";
import { isMap, mergeById, mergeMaps, mergeValue, type Merged, type TreeMap, type TreeValue } from "./tree-merge";

const nodeTypes = new Set(["text", "file", "link", "group"]);
const sides = new Set(["top", "right", "bottom", "left"]);
const ends = new Set(["none", "arrow"]);
const backgroundStyles = new Set(["cover", "ratio", "repeat"]);

/**
 * Merges `local` and `remote`, two versions of a `.canvas` file derived from
 * `base`: `nodes` and `edges` match by `id`, and their fields merge as maps.
 * Returns null, so the caller keeps the blob rule, when a side is not a valid
 * canvas, both sides made conflicting changes, or the result is invalid (an
 * edge to a node the other side deleted, for example).
 */
export function mergeCanvas(base: Uint8Array, local: Uint8Array, remote: Uint8Array): Uint8Array | null {
  return mergeParsed(base, local, remote, parseCanvas, mergeRoot, isValidCanvas);
}

function parseCanvas(bytes: Uint8Array): { value: TreeValue } | null {
  const parsed = parseJson(bytes);
  return parsed !== null && isValidCanvas(parsed.value) ? parsed : null;
}

function mergeRoot(base: Merged, local: Merged, remote: Merged): Merged {
  return mergeMaps(base, local, remote, (key, b, l, r) =>
    key === "nodes" || key === "edges" ? mergeById(b, l, r, "id", (_id, bi, li, ri) => mergeMaps(bi, li, ri, (_field, bf, lf, rf) => mergeValue(bf, lf, rf))) : mergeValue(b, l, r),
  );
}


/** Whether `value` is a JSON Canvas 1.0 document with unique ids and every edge's endpoints present. */
export function isValidCanvas(value: TreeValue): boolean {
  if (!isMap(value)) return false;
  const nodes = value["nodes"] ?? [];
  const edges = value["edges"] ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false;
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!isMap(node) || !isValidNode(node) || nodeIds.has(node["id"] as string)) return false;
    nodeIds.add(node["id"] as string);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!isMap(edge) || !isValidEdge(edge) || edgeIds.has(edge["id"] as string)) return false;
    if (!nodeIds.has(edge["fromNode"] as string) || !nodeIds.has(edge["toNode"] as string)) return false;
    edgeIds.add(edge["id"] as string);
  }
  return true;
}

function isValidNode(node: TreeMap): boolean {
  if (typeof node["id"] !== "string" || typeof node["type"] !== "string" || !nodeTypes.has(node["type"])) return false;
  for (const field of ["x", "y", "width", "height"]) {
    if (!Number.isInteger(node[field])) return false;
  }
  if (!optionalString(node, "color")) return false;
  switch (node["type"]) {
    case "text":
      return typeof node["text"] === "string";
    case "file":
      return typeof node["file"] === "string" && optionalString(node, "subpath");
    case "link":
      return typeof node["url"] === "string";
    default:
      return optionalString(node, "label") && optionalString(node, "background") && optionalOf(node, "backgroundStyle", backgroundStyles);
  }
}

function isValidEdge(edge: TreeMap): boolean {
  return (
    typeof edge["id"] === "string" &&
    typeof edge["fromNode"] === "string" &&
    typeof edge["toNode"] === "string" &&
    optionalOf(edge, "fromSide", sides) &&
    optionalOf(edge, "toSide", sides) &&
    optionalOf(edge, "fromEnd", ends) &&
    optionalOf(edge, "toEnd", ends) &&
    optionalString(edge, "color") &&
    optionalString(edge, "label")
  );
}

function optionalString(map: TreeMap, field: string): boolean {
  return !Object.hasOwn(map, field) || typeof map[field] === "string";
}

function optionalOf(map: TreeMap, field: string, allowed: Set<string>): boolean {
  return !Object.hasOwn(map, field) || (typeof map[field] === "string" && allowed.has(map[field]));
}
