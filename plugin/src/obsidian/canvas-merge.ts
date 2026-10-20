// No Obsidian import: the vault adapter uses this, and its unit tests run
// without Obsidian.

/**
 * Three-way merge of a canvas (`.canvas`, JSON Canvas): `base` is the file
 * on disk, `local` an open canvas view's data with unsaved changes, and
 * `remote` new content to write. Nodes and edges are merged by `id`: one
 * changed, added or removed on one side only takes that side's version; the
 * same change on both sides is kept once. Any other top-level field is merged
 * whole. Returns the merged canvas (tab-indented JSON), or null when the
 * sides cannot be merged without one overwriting the other: a node, edge or
 * field changed differently on both sides, one side changing what the other
 * removed, an edge left without its node, or anything that is not a canvas.
 *
 * The local order is kept; nodes and edges only the remote side added follow,
 * in its order.
 */
export function mergeCanvas(base: string, local: string, remote: string): string | null {
  const [baseCanvas, localCanvas, remoteCanvas] = [parseCanvas(base), parseCanvas(local), parseCanvas(remote)];
  if (baseCanvas === undefined || localCanvas === undefined || remoteCanvas === undefined) return null;
  const merged: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(localCanvas), ...Object.keys(remoteCanvas), ...Object.keys(baseCanvas)]);
  for (const key of keys) {
    if (key === "nodes" || key === "edges") {
      const items = mergeItems(itemsOf(baseCanvas, key), itemsOf(localCanvas, key), itemsOf(remoteCanvas, key));
      if (items === null) return null;
      merged[key] = items;
      continue;
    }
    const value = mergeValue(baseCanvas[key], localCanvas[key], remoteCanvas[key]);
    if (value === conflict) return null;
    if (value !== undefined) merged[key] = value;
  }
  // Keep the canvas's own key order (nodes, then edges) where it has one.
  const ordered: Record<string, unknown> = {};
  for (const key of ["nodes", "edges"]) ordered[key] = merged[key];
  for (const [key, value] of Object.entries(merged)) ordered[key] ??= value;
  const nodeIds = new Set((ordered.nodes as CanvasItem[]).map((node) => node.id));
  const dangling = (end: unknown) => typeof end === "string" && !nodeIds.has(end);
  if ((ordered.edges as CanvasItem[]).some((edge) => dangling(edge.fromNode) || dangling(edge.toNode))) return null;
  return JSON.stringify(ordered, null, "\t");
}

interface CanvasItem {
  id: string;
  [field: string]: unknown;
}

type Canvas = Record<string, unknown>;

const conflict = Symbol("conflict");

function parseCanvas(text: string): Canvas | undefined {
  let value: unknown;
  try {
    value = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const canvas = value as Canvas;
  for (const key of ["nodes", "edges"]) {
    const items = canvas[key];
    if (items === undefined) continue;
    if (!Array.isArray(items)) return undefined;
    const ids = new Set<string>();
    for (const item of items as unknown[]) {
      if (typeof item !== "object" || item === null || typeof (item as { id?: unknown }).id !== "string") return undefined;
      const { id } = item as CanvasItem;
      if (ids.has(id)) return undefined;
      ids.add(id);
    }
  }
  return canvas;
}

function itemsOf(canvas: Canvas, key: string): CanvasItem[] {
  return (canvas[key] as CanvasItem[] | undefined) ?? [];
}

function mergeItems(base: CanvasItem[], local: CanvasItem[], remote: CanvasItem[]): CanvasItem[] | null {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const merged: CanvasItem[] = [];
  for (const item of [...local, ...remote.filter((candidate) => !localById.has(candidate.id))]) {
    const value = mergeValue(baseById.get(item.id), localById.get(item.id), remoteById.get(item.id));
    if (value === conflict) return null;
    if (value !== undefined) merged.push(value as CanvasItem);
  }
  return merged;
}

/** Three-way merge of one value (undefined: absent): the side that changed it wins; both changing it differently conflicts. */
function mergeValue(base: unknown, local: unknown, remote: unknown): unknown {
  if (same(local, remote)) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;
  return conflict;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

/** JSON with object keys sorted, so two serializations of one value compare equal; undefined for an absent value. */
function canonical(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field !== "object" || field === null || Array.isArray(field)) return field;
    return Object.fromEntries(Object.entries(field).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  });
}
