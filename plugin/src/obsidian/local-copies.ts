// Local copies of a viewer device (docs/design/sharing.md, Viewer devices):
// a local version that a read-only device does not push is kept under
// `.vault-sync/local-copies/<path>`, a dot folder the plugin never syncs. No
// Obsidian import: main.ts passes the vault's DataAdapter.

/** The folder local copies are kept in, relative to the vault's root. */
export const localCopiesFolder = ".vault-sync/local-copies";

/** Upper bound on numeric suffixes tried for one copy. */
const maxSuffix = 10_000;

/** The part of Obsidian's DataAdapter that keeps local copies; it reaches dot folders, which the Vault API does not. */
export interface LocalCopyStore {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

/**
 * Where the local copy of the file at `path` goes: `.vault-sync/local-copies/<path>`,
 * or, if that name is taken, the first free one with a numeric suffix before
 * the extension (`note 1.md`, `note 2.md`, ...).
 */
export async function localCopyPath(path: string, taken: (path: string) => Promise<boolean>): Promise<string> {
  const target = `${localCopiesFolder}/${path}`;
  if (!(await taken(target))) return target;
  const slash = target.lastIndexOf("/");
  const name = target.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? target.slice(0, slash + 1 + dot) : target;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let suffix = 1; suffix <= maxSuffix; suffix++) {
    const candidate = `${stem} ${String(suffix)}${extension}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error(`no free name for a local copy of ${path}`);
}

/** Keeps `content`, the local version of the file at `path`, as a local copy; returns the copy's path. */
export async function keepLocalCopy(store: LocalCopyStore, path: string, content: Uint8Array): Promise<string> {
  const copy = await localCopyPath(path, (candidate) => store.exists(candidate));
  const parts = copy.split("/");
  for (let length = 1; length < parts.length; length++) {
    const folder = parts.slice(0, length).join("/");
    if (!(await store.exists(folder))) await store.mkdir(folder);
  }
  await store.writeBinary(copy, new Uint8Array(content).buffer);
  return copy;
}
