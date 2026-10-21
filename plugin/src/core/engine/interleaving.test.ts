import { describe, expect, it } from "vitest";

import type { PathRules } from "../vaultpath/platform";
import type { MergeHook, MergeRequest } from "./merge";
import { copyOf, files, harness, InterleavingVault, text, type Harness } from "./testing";

// A local save that lands after the engine checked the disk against the
// journal's base and before its write or delete reaches the vault (#163):
// Obsidian's autosave can do that at any moment. The engine must treat it as
// the local edit it is (SPEC.md §7, §8), never overwrite or delete it.

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

const base = lines("one", "two", "three");
const remoteEdit = lines("ONE", "two", "three");
const localSave = lines("one", "two", "THREE");
const merged = lines("ONE", "two", "THREE");

function interleaved(pathRules?: PathRules): { h: Harness; vault: InterleavingVault } {
  let vault: InterleavingVault | undefined;
  const h = harness({
    merge: "default",
    ...(pathRules === undefined ? {} : { pathRules }),
    wrapVault: (inner) => {
      vault = new InterleavingVault(inner);
      return vault;
    },
  });
  if (vault === undefined) throw new Error("the harness did not wrap the vault");
  return { h, vault };
}

/** The local save the test lands, written as the user's would be. */
function save(h: Harness, path: string, content: string): () => Promise<void> {
  return () => h.vault.write(path, bytes(content));
}

describe("SyncEngine, given a local save between its check of the disk and its change", () => {
  it("merges a save that lands before the write of a remote edit, instead of overwriting it", async () => {
    const { h, vault } = interleaved();
    h.server.commit({ documentId: "a", path: "a.md", content: base });
    await h.engine.pull();
    h.server.commit({ documentId: "a", path: "a.md", content: remoteEdit });
    vault.beforeNextChange("a.md", save(h, "a.md", localSave));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(text(await h.vault.read("a.md"))).toBe(merged);
    expect(h.localChanges).toContainEqual({ type: "modify", path: "a.md" });
    await h.engine.push();
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", merged]]));
  });

  it("keeps a save that lands before the delete of a remote delete", async () => {
    const { h, vault } = interleaved();
    h.server.commit({ documentId: "a", path: "a.md", content: base });
    await h.engine.pull();
    h.server.commit({ documentId: "a", path: "a.md", deleted: true });
    vault.beforeNextChange("a.md", save(h, "a.md", localSave));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(await files(h.vault)).toEqual(new Map([["a.md", localSave]]));
    await h.engine.push();
    // The edit wins over the delete (SPEC.md §7).
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", localSave]]));
  });

  it("keeps a file the user creates before the write of a remote create at the same path", async () => {
    const { h, vault } = interleaved();
    h.server.commit({ documentId: "a", path: "a.md", content: "remote note\n" });
    vault.beforeNextChange("a.md", save(h, "a.md", "my own note\n"));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    const contents = [...(await files(h.vault)).values()].sort();
    expect(contents).toEqual(["my own note\n", "remote note\n"]);
    await h.engine.push();
    expect([...h.server.liveFiles().values()].sort()).toEqual(["my own note\n", "remote note\n"]);
  });

  it("merges a save that lands at the new path between a remote rename and its edit", async () => {
    const { h, vault } = interleaved();
    h.server.commit({ documentId: "a", path: "a.md", content: base });
    await h.engine.pull();
    h.server.commit({ documentId: "a", path: "b.md", content: remoteEdit });
    // The engine renames a.md to b.md first; the save lands at b.md before the edit is written.
    vault.beforeNextChange("b.md", save(h, "b.md", localSave));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(await files(h.vault)).toEqual(new Map([["b.md", merged]]));
    await h.engine.push();
    expect(h.server.liveFiles()).toEqual(new Map([["b.md", merged]]));
  });

  it("keeps a save that lands before the write of a merge result, and merges it next time", async () => {
    const { h, vault } = interleaved();
    h.server.commit({ documentId: "a", path: "a.md", content: base });
    await h.engine.pull();
    await h.vault.write("a.md", bytes(localSave));
    await h.engine.settled();
    h.server.commit({ documentId: "a", path: "a.md", content: remoteEdit });
    const later = lines("one", "two", "THREE", "four");
    vault.beforeNextChange("a.md", save(h, "a.md", later));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(text(await h.vault.read("a.md"))).toBe(later);
    await h.engine.push();
    const result = lines("ONE", "two", "THREE", "four");
    expect(await files(h.vault)).toEqual(new Map([["a.md", result]]));
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", result]]));
  });

  it("keeps a save that lands before the delete a merge result asks for, and asks the merge hook again with it", async () => {
    // A merge hook that accepts every delete: its result for a remote delete is no file.
    const requests: MergeRequest[] = [];
    const acceptDelete: MergeHook = (request) => {
      requests.push(request);
      return Promise.resolve({ status: "merged", content: null });
    };
    let vault: InterleavingVault | undefined;
    const h = harness({
      merge: acceptDelete,
      wrapVault: (inner) => {
        vault = new InterleavingVault(inner);
        return vault;
      },
    });
    if (vault === undefined) throw new Error("the harness did not wrap the vault");
    h.server.commit({ documentId: "a", path: "a.md", content: base });
    await h.engine.pull();
    await h.vault.write("a.md", bytes(localSave));
    await h.engine.settled();
    h.server.commit({ documentId: "a", path: "a.md", deleted: true });
    const later = lines("one", "two", "THREE", "four");
    vault.beforeNextChange("a.md", save(h, "a.md", later));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(await files(h.vault)).toEqual(new Map([["a.md", later]]));
    await h.engine.push();
    // The hook decides again, now given the newer save.
    expect(text(requests.at(-1)?.local.content ?? null)).toBe(later);
  });

  it("keeps a save to a file in the way of a remote rename that lands before the engine removes that file", async () => {
    const { h, vault } = interleaved();
    h.server.commit({ documentId: "a", path: "a.md", content: base });
    await h.engine.pull();
    // A local file, never synced, at the path the remote rename moves the note to.
    await h.vault.write("b.md", bytes("my own note\n"));
    await h.engine.settled();
    h.server.commit({ documentId: "a", path: "b.md", content: base });
    // The engine keeps "my own note" as a conflict copy, then removes b.md; the save lands in between.
    vault.beforeNextChange("b.md", save(h, "b.md", "my own note, saved again\n"));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(text(await h.vault.read("b.md"))).toBe("my own note, saved again\n");
    await h.engine.push();
    await h.engine.pull();
    await h.engine.settled();
    const contents = [...(await files(h.vault)).values()];
    expect(contents).toContain("my own note, saved again\n");
    expect(contents).toContain(base);
  });

  it("keeps a file the user creates at a conflict copy's path before the copy is written", async () => {
    const { h, vault } = interleaved();
    h.server.commit({ documentId: "a", path: "a.md", content: base });
    await h.engine.pull();
    await h.vault.write("a.md", bytes(lines("one", "TWO", "three")));
    await h.engine.settled();
    h.server.commit({ documentId: "a", path: "a.md", content: lines("one", "zwei", "three") });
    vault.beforeNextChange(copyOf("a", ".md"), save(h, copyOf("a", ".md"), "the user's own file\n"));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(text(await h.vault.read(copyOf("a", ".md")))).toBe("the user's own file\n");
    await h.engine.push();
    // Every version survives: the user's file, the local edit and the remote one.
    const contents = [...(await files(h.vault)).values()].sort();
    expect(contents).toEqual([lines("one", "TWO", "three"), lines("one", "zwei", "three"), "the user's own file\n"].sort());
    expect([...h.server.liveFiles().values()].sort()).toEqual(contents);
  });

  it("keeps a save that lands before it releases the file of a document a remote rename gives a name the platform cannot hold", async () => {
    const { h, vault } = interleaved({ platform: "windows" });
    h.server.commit({ documentId: "a", path: "a.md", content: base });
    await h.engine.pull();
    // Renamed and edited remotely to a name Windows cannot hold: the engine
    // removes the unchanged file (SPEC.md §8), and the save lands just before.
    h.server.commit({ documentId: "a", path: "a?.md", content: remoteEdit });
    vault.beforeNextChange("a.md", save(h, "a.md", localSave));

    await h.engine.pull();
    await h.engine.settled();

    expect(vault.pending).toBe(false);
    expect(await files(h.vault)).toEqual(new Map([["a.md", localSave]]));
    // Not released: the kept file is still the document's, as any locally edited one is.
    expect((await h.engine.unmaterializable()).map(({ path, localPath }) => ({ path, localPath }))).toEqual([{ path: "a?.md", localPath: "a.md" }]);
    expect(await h.journal.getDocument("a")).toMatchObject({ path: "a.md", deleted: false });

    // Once a later rename gives the document a legal name, the save is merged into it.
    h.server.commit({ documentId: "a", path: "b.md" });
    await h.engine.push();

    expect(await files(h.vault)).toEqual(new Map([["b.md", merged]]));
    expect(h.server.liveFiles()).toEqual(new Map([["b.md", merged]]));
  });
});
