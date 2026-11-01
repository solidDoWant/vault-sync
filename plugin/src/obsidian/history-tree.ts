import type { HistoryDocument } from "../core/sync/history";

// The synced files of the history view as a folder tree. No Obsidian import,
// so it is unit-tested; history-modal.ts renders it.

export interface FolderNode {
  kind: "folder";
  /** The folder's own name. */
  name: string;
  /** Its vault-relative path. */
  path: string;
  /** Its folders, then its files, each by name. */
  children: TreeNode[];
  /** How many files are in it, at any depth. */
  files: number;
}

export interface FileNode {
  kind: "file";
  /** The file's own name. */
  name: string;
  document: HistoryDocument;
}

export type TreeNode = FolderNode | FileNode;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * `documents` as a tree of folders and files, the way Obsidian's file
 * explorer shows a vault: in each folder, its folders first, then its files,
 * each by name. A live and a deleted file at one path both show.
 */
export function documentTree(documents: readonly HistoryDocument[]): TreeNode[] {
  const root: FolderNode = { kind: "folder", name: "", path: "", children: [], files: 0 };
  const folders = new Map<string, FolderNode>([["", root]]);
  const folderAt = (path: string): FolderNode => {
    const known = folders.get(path);
    if (known !== undefined) return known;
    const slash = path.lastIndexOf("/");
    const parent = folderAt(slash === -1 ? "" : path.slice(0, slash));
    const folder: FolderNode = { kind: "folder", name: path.slice(slash + 1), path, children: [], files: 0 };
    parent.children.push(folder);
    folders.set(path, folder);
    return folder;
  };
  for (const document of documents) {
    const slash = document.path.lastIndexOf("/");
    const folderPath = slash === -1 ? "" : document.path.slice(0, slash);
    folderAt(folderPath).children.push({ kind: "file", name: document.path.slice(slash + 1), document });
    for (let path: string | undefined = folderPath; path !== undefined; path = path === "" ? undefined : parentOf(path)) {
      const folder = folders.get(path);
      if (folder !== undefined) folder.files++;
    }
  }
  const sort = (folder: FolderNode) => {
    folder.children.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) || Number(fileDeleted(a)) - Number(fileDeleted(b)) : a.kind === "folder" ? -1 : 1));
    for (const child of folder.children) if (child.kind === "folder") sort(child);
  };
  sort(root);
  return root.children;
}

function fileDeleted(node: TreeNode): boolean {
  return node.kind === "file" && node.document.deleted;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The folders that hold `path`, outermost first: what must be open for it to show. */
export function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}
