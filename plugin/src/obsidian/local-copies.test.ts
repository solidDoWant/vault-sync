import { describe, expect, it } from "vitest";

import { keepLocalCopy, localCopyPath, type LocalCopyStore } from "./local-copies";

/** A DataAdapter holding files and folders in memory. */
function memoryStore(): LocalCopyStore & { files: Map<string, string>; folders: Set<string> } {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  return {
    files,
    folders,
    exists: (path) => Promise.resolve(files.has(path) || folders.has(path)),
    mkdir: (path) => {
      folders.add(path);
      return Promise.resolve();
    },
    writeBinary: (path, data) => {
      files.set(path, new TextDecoder().decode(data));
      return Promise.resolve();
    },
  };
}

describe("local copies", () => {
  it("keeps a copy under .vault-sync/local-copies at the file's path, creating its folders", async () => {
    const store = memoryStore();
    expect(await keepLocalCopy(store, "Notes/a.md", new TextEncoder().encode("mine"))).toBe(".vault-sync/local-copies/Notes/a.md");
    expect(store.files).toEqual(new Map([[".vault-sync/local-copies/Notes/a.md", "mine"]]));
    expect([...store.folders].sort()).toEqual([".vault-sync", ".vault-sync/local-copies", ".vault-sync/local-copies/Notes"]);
  });

  it("adds a numeric suffix before the extension when the name is taken", async () => {
    const store = memoryStore();
    await keepLocalCopy(store, "a.md", new TextEncoder().encode("first"));
    await keepLocalCopy(store, "a.md", new TextEncoder().encode("second"));
    await keepLocalCopy(store, "a.md", new TextEncoder().encode("third"));
    expect(store.files).toEqual(
      new Map([
        [".vault-sync/local-copies/a.md", "first"],
        [".vault-sync/local-copies/a 1.md", "second"],
        [".vault-sync/local-copies/a 2.md", "third"],
      ]),
    );
  });

  it("adds the suffix at the end of a name without an extension", async () => {
    const taken = new Set([".vault-sync/local-copies/Folder.v2/README"]);
    expect(await localCopyPath("Folder.v2/README", (path) => Promise.resolve(taken.has(path)))).toBe(".vault-sync/local-copies/Folder.v2/README 1");
  });
});
