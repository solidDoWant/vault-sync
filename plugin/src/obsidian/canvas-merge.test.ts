import { describe, expect, it } from "vitest";

import { mergeCanvas } from "./canvas-merge";

const node = (id: string, text = id, x = 0) => ({ id, type: "text", text, x, y: 0, width: 200, height: 60 });
const edge = (id: string, fromNode: string, toNode: string) => ({ id, fromNode, fromSide: "right", toNode, toSide: "left" });
const canvas = (nodes: object[], edges: object[] = [], extra: object = {}) => JSON.stringify({ nodes, edges, ...extra });
const parsed = (text: string | null) => (text === null ? null : (JSON.parse(text) as unknown));

describe("mergeCanvas", () => {
  const base = canvas([node("a"), node("b")], [edge("e1", "a", "b")]);

  it("keeps a node added locally and one added remotely, local order first", () => {
    const local = canvas([node("a"), node("b"), node("local")], [edge("e1", "a", "b")]);
    const remote = canvas([node("a"), node("b"), node("remote")], [edge("e1", "a", "b")]);
    expect(parsed(mergeCanvas(base, local, remote))).toEqual({ nodes: [node("a"), node("b"), node("local"), node("remote")], edges: [edge("e1", "a", "b")] });
  });

  it("takes each side's change to a different node, and a node moved on one side", () => {
    const local = canvas([node("a", "local text"), node("b")], [edge("e1", "a", "b")]);
    const remote = canvas([node("a"), node("b", "b", 300)], [edge("e1", "a", "b")]);
    expect(parsed(mergeCanvas(base, local, remote))).toEqual({ nodes: [node("a", "local text"), node("b", "b", 300)], edges: [edge("e1", "a", "b")] });
  });

  it("applies a remote removal of a node the local side left alone", () => {
    const local = canvas([node("a"), node("b"), node("c")], [edge("e1", "a", "b")]);
    const remote = canvas([node("a")], []);
    expect(parsed(mergeCanvas(base, local, remote))).toEqual({ nodes: [node("a"), node("c")], edges: [] });
  });

  it("keeps the same change made on both sides once", () => {
    const both = canvas([node("a", "same"), node("b")], [edge("e1", "a", "b")]);
    expect(parsed(mergeCanvas(base, both, both))).toEqual(parsed(both));
  });

  it("compares nodes by value, not by key order or formatting", () => {
    const reordered = JSON.stringify({ edges: [{ toSide: "left", toNode: "b", fromSide: "right", fromNode: "a", id: "e1" }], nodes: [node("b"), node("a")].map((item) => Object.fromEntries(Object.entries(item).reverse())) }, null, "\t");
    const remote = canvas([node("a"), node("b"), node("remote")], [edge("e1", "a", "b")]);
    expect(mergeCanvas(base, reordered, remote)).not.toBeNull();
  });

  const refusals: { name: string; local: string; remote: string }[] = [
    { name: "one node changed differently on both sides", local: canvas([node("a", "local"), node("b")], [edge("e1", "a", "b")]), remote: canvas([node("a", "remote"), node("b")], [edge("e1", "a", "b")]) },
    { name: "a node changed locally and removed remotely", local: canvas([node("a", "local"), node("b")], [edge("e1", "a", "b")]), remote: canvas([node("b")], []) },
    { name: "a node removed locally and changed remotely", local: canvas([node("b")], []), remote: canvas([node("a", "remote"), node("b")], [edge("e1", "a", "b")]) },
    { name: "one id added with different content on both sides", local: canvas([node("a"), node("b"), node("n", "local")], [edge("e1", "a", "b")]), remote: canvas([node("a"), node("b"), node("n", "remote")], [edge("e1", "a", "b")]) },
    { name: "a local edge to a node removed remotely", local: canvas([node("a"), node("b")], [edge("e1", "a", "b"), edge("e2", "b", "a")]), remote: canvas([node("a")], []) },
    { name: "a local edge to a node removed remotely, at its target", local: canvas([node("a"), node("b")], [edge("e1", "a", "b"), edge("e2", "a", "b")]), remote: canvas([node("a")], []) },
    { name: "a top-level field changed differently on both sides", local: canvas([node("a"), node("b")], [edge("e1", "a", "b")], { meta: 1 }), remote: canvas([node("a"), node("b")], [edge("e1", "a", "b")], { meta: 2 }) },
    { name: "a local side that is not JSON", local: "{ nodes: [", remote: base },
    { name: "a remote side whose nodes are not a list", local: base, remote: JSON.stringify({ nodes: {} }) },
    { name: "a node without an id", local: canvas([node("a"), node("b"), { type: "text" }], [edge("e1", "a", "b")]), remote: base },
    { name: "two nodes with one id", local: canvas([node("a"), node("b"), node("a", "again")], [edge("e1", "a", "b")]), remote: base },
  ];
  for (const { name, local, remote } of refusals) {
    it(`refuses ${name}`, () => {
      expect(mergeCanvas(base, local, remote)).toBeNull();
    });
  }

  // JSON.parse keeps a "__proto__" key as an own property; assigning it to a
  // plain object would set the prototype instead, and the field would vanish.
  const withProto = (nodes: object[], proto: string) => `{"nodes":${JSON.stringify(nodes)},"edges":[],"__proto__":${proto}}`;
  const protoOf = (text: string | null) => {
    expect(text).not.toBeNull();
    const value = JSON.parse(text ?? "null") as object;
    return Object.hasOwn(value, "__proto__") ? (value as { ["__proto__"]: unknown })["__proto__"] : "absent";
  };

  it("keeps a top-level __proto__ field both sides have", () => {
    const merged = mergeCanvas(withProto([node("a")], `{"x":1}`), withProto([node("a"), node("local")], `{"x":1}`), withProto([node("a"), node("remote")], `{"x":1}`));
    expect(protoOf(merged)).toEqual({ x: 1 });
    expect((parsed(merged) as { nodes: unknown }).nodes).toEqual([node("a"), node("local"), node("remote")]);
  });

  it("keeps a top-level __proto__ field only the remote side added", () => {
    expect(protoOf(mergeCanvas(canvas([node("a")]), canvas([node("a"), node("local")]), withProto([node("a")], `{"x":1}`)))).toEqual({ x: 1 });
  });

  it("keeps a top-level __proto__ field only the local side changed", () => {
    expect(protoOf(mergeCanvas(withProto([node("a")], `{"x":1}`), withProto([node("a")], `{"x":2}`), withProto([node("a"), node("remote")], `{"x":1}`)))).toEqual({ x: 2 });
  });

  it("removes a top-level __proto__ field the remote side removed", () => {
    expect(protoOf(mergeCanvas(withProto([node("a")], `{"x":1}`), withProto([node("a"), node("local")], `{"x":1}`), canvas([node("a")])))).toBe("absent");
  });

  it("refuses a __proto__ field changed differently on both sides", () => {
    expect(mergeCanvas(withProto([node("a")], `{"x":1}`), withProto([node("a")], `{"x":2}`), withProto([node("a")], `{"x":3}`))).toBeNull();
  });

  it("keeps numbers that read back as written", () => {
    const remote = `{"nodes":[{"id":"a","x":9007199254740991,"y":-12.5,"width":0.1}],"edges":[]}`;
    expect(parsed(mergeCanvas(canvas([]), canvas([]), remote))).toEqual({ nodes: [{ id: "a", x: 9007199254740991, y: -12.5, width: 0.1 }], edges: [] });
  });

  // JSON.parse keeps only the last of duplicate keys and rounds numbers it
  // cannot hold, so merging such a side would rewrite it silently.
  const unfaithful: { name: string; text: string }[] = [
    { name: "a duplicate top-level key", text: `{"nodes":[],"edges":[],"meta":1,"meta":2}` },
    { name: "a duplicate key inside a node", text: `{"nodes":[{"id":"a","text":"one","text":"two"}],"edges":[]}` },
    { name: "a duplicate key spelled with an escape", text: `{"nodes":[{"id":"a","text":"one","\u0074ext":"two"}],"edges":[]}` },
    { name: "an integer beyond 2^53", text: `{"nodes":[{"id":"a","x":9007199254740993}],"edges":[]}` },
    { name: "a number written in a form JSON.stringify does not keep", text: `{"nodes":[{"id":"a","x":1.0}],"edges":[]}` },
  ];
  for (const { name, text } of unfaithful) {
    it(`refuses a local side with ${name}`, () => {
      expect(mergeCanvas(canvas([]), text, canvas([node("remote")]))).toBeNull();
    });
    it(`refuses a remote side with ${name}`, () => {
      expect(mergeCanvas(canvas([]), canvas([node("local")]), text)).toBeNull();
    });
  }

  it("keeps a key that is the same string as a value elsewhere, and equal keys in different objects", () => {
    const remote = `{"nodes":[{"id":"text","text":"id"},{"id":"b","text":"x"}],"edges":[]}`;
    expect(mergeCanvas(canvas([]), canvas([]), remote)).not.toBeNull();
  });

  it("merges into an empty canvas file", () => {
    expect(parsed(mergeCanvas("", canvas([node("local")]), canvas([node("remote")])))).toEqual({ nodes: [node("local"), node("remote")], edges: [] });
  });
});
