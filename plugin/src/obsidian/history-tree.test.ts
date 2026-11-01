import { describe, expect, it } from "vitest";

import { documentTree, foldersOf, type TreeNode } from "./history-tree";

/** A tree as nested names: a folder as `name/` with its children and file count, a file by name, `(deleted)` marked. */
function shape(nodes: TreeNode[]): unknown[] {
  return nodes.map((node) => (node.kind === "folder" ? { [`${node.name}/ (${String(node.files)})`]: shape(node.children) } : `${node.name}${node.document.deleted ? " (deleted)" : ""}`));
}

describe("documentTree", () => {
  it("nests files in their folders, folders first and each by name, with the number of files in each folder", () => {
    const tree = documentTree([
      { documentId: "1", path: "Projects/Software/vault-sync/Test file.md", deleted: false },
      { documentId: "2", path: "Projects/PCB/Part tracking.md", deleted: false },
      { documentId: "3", path: "Projects/PCB/Oven/Design notes.md", deleted: false },
      { documentId: "4", path: "Inbox.md", deleted: false },
      { documentId: "5", path: "Projects/F150/Purchasing.md", deleted: true },
    ]);
    expect(shape(tree)).toEqual([
      {
        "Projects/ (4)": [
          { "F150/ (1)": ["Purchasing.md (deleted)"] },
          { "PCB/ (2)": [{ "Oven/ (1)": ["Design notes.md"] }, "Part tracking.md"] },
          { "Software/ (1)": [{ "vault-sync/ (1)": ["Test file.md"] }] },
        ],
      },
      "Inbox.md",
    ]);
  });

  it("orders names as people count, and puts a live file before a deleted one at the same path", () => {
    const tree = documentTree([
      { documentId: "1", path: "Note 10.md", deleted: false },
      { documentId: "2", path: "Note 9.md", deleted: true },
      { documentId: "3", path: "Note 9.md", deleted: false },
    ]);
    expect(shape(tree)).toEqual(["Note 9.md", "Note 9.md (deleted)", "Note 10.md"]);
  });

  it("is empty without documents", () => {
    expect(documentTree([])).toEqual([]);
  });
});

describe("foldersOf", () => {
  it("lists the folders that hold a path, outermost first", () => {
    expect(foldersOf("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(foldersOf("c.md")).toEqual([]);
  });
});
