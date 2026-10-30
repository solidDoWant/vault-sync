import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isValidCanvas, mergeCanvas } from "./canvas-merge";
import type { TreeMap, TreeValue } from "./tree-merge";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, "\t"));
}

function merge(base: unknown, local: unknown, remote: unknown): TreeMap | null {
  const merged = mergeCanvas(bytes(base), bytes(local), bytes(remote));
  return merged === null ? null : (JSON.parse(decoder.decode(merged)) as TreeMap);
}

const node = (id: string, fields: Record<string, unknown> = {}) => ({ id, type: "text", text: id, x: 0, y: 0, width: 250, height: 60, ...fields });
const edge = (id: string, fromNode: string, toNode: string) => ({ id, fromNode, toNode });

const base = { nodes: [node("a"), node("b")], edges: [edge("ab", "a", "b")] };

describe("mergeCanvas", () => {
  it("keeps nodes added on both sides, with their ids, after the base's in local-then-remote order", () => {
    const local = { ...base, nodes: [...base.nodes, node("l")] };
    const remote = { ...base, nodes: [...base.nodes, node("r")] };
    expect(merge(base, local, remote)).toEqual({ nodes: [node("a"), node("b"), node("l"), node("r")], edges: base.edges });
  });

  it("merges one side moving a node with the other recolouring it", () => {
    const local = { ...base, nodes: [node("a", { x: 100, y: -40 }), node("b")] };
    const remote = { ...base, nodes: [node("a", { color: "4" }), node("b")] };
    expect(merge(base, local, remote)).toEqual({ nodes: [node("a", { x: 100, y: -40, color: "4" }), node("b")], edges: base.edges });
  });

  it("falls back when both sides move the same node", () => {
    const local = { ...base, nodes: [node("a", { x: 100 }), node("b")] };
    const remote = { ...base, nodes: [node("a", { x: 300 }), node("b")] };
    expect(merge(base, local, remote)).toBeNull();
  });

  it("falls back when one side deletes a node the other adds an edge to", () => {
    const local = { nodes: [node("a")], edges: [] };
    expect(merge(base, local, { ...base, edges: [...base.edges, edge("ba", "b", "a")] })).toBeNull();
    expect(merge(base, local, { ...base, edges: [...base.edges, edge("ab2", "a", "b")] })).toBeNull();
  });

  it("falls back when one side deletes a node the other changed", () => {
    const local = { nodes: [node("a")], edges: [] };
    const remote = { ...base, nodes: [node("a"), node("b", { color: "2" })] };
    expect(merge(base, local, remote)).toBeNull();
  });

  it("keeps unknown fields from either side", () => {
    const local = { ...base, nodes: [node("a", { "x-plugin": { pinned: true } }), node("b")] };
    const remote = { ...base, extension: "kept", nodes: [node("a"), node("b", { text: "B" })] };
    expect(merge(base, local, remote)).toEqual({ extension: "kept", nodes: [node("a", { "x-plugin": { pinned: true } }), node("b", { text: "B" })], edges: base.edges });
  });

  it("falls back when a side reorders the nodes (their z-order) rather than dropping the reorder", () => {
    const local = { ...base, nodes: [node("b"), node("a")] };
    const remote = { ...base, nodes: [...base.nodes, node("r")] };
    expect(merge(base, local, remote)).toBeNull();
  });

  it("falls back when a side is not a valid canvas", () => {
    expect(merge(base, { ...base, nodes: [node("a"), node("a")] }, base)).toBeNull();
    expect(merge(base, { ...base, nodes: [node("a", { type: "shape" })] }, base)).toBeNull();
    expect(mergeCanvas(bytes(base), encoder.encode("{ not json"), bytes(base))).toBeNull();
  });

  it("returns the remote side's bytes unchanged when the merge equals it", () => {
    const remote = encoder.encode(JSON.stringify({ ...base, nodes: [node("a", { color: "1" }), node("b")] }));
    expect(mergeCanvas(bytes(base), bytes(base), remote)).toBe(remote);
  });
});

const nodeIds = ["n1", "n2", "n3", "n4"];
const edgeIds = ["e1", "e2", "e3"];

const canvasArbitrary: fc.Arbitrary<TreeMap> = fc.subarray(nodeIds, { minLength: 1 }).chain((ids) =>
  fc.record({
    nodes: fc.tuple(...ids.map((id) => fc.record({ x: fc.integer({ min: 0, max: 2 }), color: fc.option(fc.constantFrom("1", "2"), { nil: undefined }) }).map(({ x, color }) => node(id, color === undefined ? { x } : { x, color })))),
    edges: fc.subarray(edgeIds).chain((edges) => fc.tuple(...edges.map((id) => fc.tuple(fc.constantFrom(...ids), fc.constantFrom(...ids)).map(([from, to]) => edge(id, from, to))))),
  }),
);

function byId(canvas: TreeMap): unknown {
  const sort = (items: TreeValue) => [...(items as TreeMap[])].sort((left, right) => (left["id"] as string).localeCompare(right["id"] as string));
  return { ...canvas, nodes: sort(canvas["nodes"] ?? []), edges: sort(canvas["edges"] ?? []) };
}

describe("mergeCanvas properties", () => {
  it("merge(base, x, base) = x and merge(base, x, x) = x", () => {
    fc.assert(
      fc.property(canvasArbitrary, canvasArbitrary, (b, x) => {
        expect(merge(b, x, b)).toEqual(x);
        expect(merge(b, x, x)).toEqual(x);
      }),
    );
  });

  it("is symmetric up to item order, and every merged result is a valid canvas", () => {
    fc.assert(
      fc.property(canvasArbitrary, canvasArbitrary, canvasArbitrary, (b, x, y) => {
        const forward = merge(b, x, y);
        const backward = merge(b, y, x);
        expect(forward === null).toBe(backward === null);
        if (forward === null || backward === null) return;
        expect(isValidCanvas(forward)).toBe(true);
        expect(byId(forward)).toEqual(byId(backward));
      }),
      { numRuns: 500 },
    );
  });
});
