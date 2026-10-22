import { describe, expect, it } from "vitest";
import type { DocumentState, RemoteRevision } from "../journal/journal";
import { sha256Hex } from "../hash";
import { boundLocalChange, mergePath } from "./decide";
import { threeWayMerge, type MergeRequest } from "./merge";

const encoder = new TextEncoder();

function state(overrides: Partial<DocumentState> = {}): DocumentState {
  return { documentId: "d", path: "a.md", revisionId: "r1", seq: 1n, baseHash: "h1", size: 1n, kind: "text", deleted: false, ...overrides };
}

function remote(overrides: Partial<RemoteRevision> = {}): RemoteRevision {
  return { revisionId: "r2", documentId: "d", seq: 2n, parentRevisionId: "r1", kind: "text", path: "a.md", deleted: false, contentHash: "h2", size: 1n, ...overrides };
}

// The path merge of design §4.7 (PO-9), which the merge hook no longer does (decision 6).
describe("mergePath (design §4.7, PO-9)", () => {
  it("keeps a local rename against a remote edit", () => {
    expect(mergePath(state(), "renamed.md", remote())).toBe("renamed.md");
  });

  it("applies a remote rename against a local edit", () => {
    expect(mergePath(state(), "a.md", remote({ path: "moved.md" }))).toBe("moved.md");
  });

  it("lets the local rename win when both sides renamed", () => {
    expect(mergePath(state(), "local.md", remote({ path: "remote.md" }))).toBe("local.md");
  });

  it("keeps a case-only local rename against a remote edit", () => {
    expect(mergePath(state(), "A.md", remote())).toBe("A.md");
  });

  it("brings a locally deleted document back at the remote path", () => {
    // A local delete's version is at the synced path (no file there).
    expect(mergePath(state(), "a.md", remote({ path: "moved.md" }))).toBe("moved.md");
  });

  it("keeps the local path when an edit wins over a remote delete", () => {
    expect(mergePath(state(), "renamed.md", remote({ deleted: true }))).toBe("renamed.md");
    expect(mergePath(state(), "a.md", remote({ path: "a.md", deleted: true }))).toBe("a.md");
  });

  it("takes the remote path for a document this device never synced", () => {
    expect(mergePath(undefined, "other.md", remote({ path: "new.md" }))).toBe("new.md");
  });

  // Ruling on #52 (#802): the user's unpushed rename wins over another device's re-create of a document bound on its
  // tombstone, as over any remote revision.
  it("keeps the user's rename of a document bound on its tombstone against a revision that brings it back", () => {
    const bound = { spelling: "A.md", fileKey: "a.md", seen: "h1" };
    expect(mergePath(state({ deleted: true, binding: bound }), "A.md", remote({ path: "notes/f.md" }))).toBe("A.md");
  });

  it("takes the remote path for a document bound on its tombstone at the tombstone's path", () => {
    const bound = { spelling: "a.md", fileKey: "a.md", seen: "h1" };
    expect(mergePath(state({ deleted: true, binding: bound }), "a.md", remote({ path: "back.md" }))).toBe("back.md");
  });

  it("takes the remote path for a document bound on its tombstone whose file the engine moved aside", () => {
    const displaced = { spelling: "s (conflict laptop 1).md", fileKey: "s (conflict laptop 1).md", seen: "h1", displaced: true };
    expect(mergePath(state({ path: "s.md", deleted: true, binding: displaced }), "s (conflict laptop 1).md", remote({ path: "ab:c.md" }))).toBe("ab:c.md");
  });

  it("takes the remote path for a tombstone with no file here", () => {
    expect(mergePath(state({ deleted: true, binding: null }), "back.md", remote({ path: "back.md" }))).toBe("back.md");
    expect(mergePath(state({ deleted: true }), "copy.md", remote({ path: "back.md" }))).toBe("back.md");
  });
});

// The bound file that is a document's local change against a remote revision (design §4.5 step 4, PO-1, PO-9).
describe("boundLocalChange (design §4.5 step 4)", () => {
  const bound = (spelling: string) => ({ spelling, fileKey: spelling, seen: "h1" });

  it("takes a moved file not pushed yet against a remote delete", () => {
    expect(boundLocalChange(state({ binding: bound("x.md") }), remote({ deleted: true }))).toBe("x.md");
  });

  it("takes no unmoved file against a remote delete, nor a moved one against a remote edit", () => {
    expect(boundLocalChange(state({ binding: bound("a.md") }), remote({ deleted: true }))).toBeUndefined();
    expect(boundLocalChange(state({ binding: bound("x.md") }), remote())).toBeUndefined();
  });

  it("takes the file of a document bound on its tombstone against a revision that brings it back (#790)", () => {
    expect(boundLocalChange(state({ deleted: true, binding: bound("x.md") }), remote({ path: "elsewhere.md" }))).toBe("x.md");
    expect(boundLocalChange(state({ deleted: true, binding: bound("a.md") }), remote())).toBe("a.md");
  });

  it("takes nothing for a document with no file here", () => {
    expect(boundLocalChange(undefined, remote())).toBeUndefined();
    expect(boundLocalChange(state({ deleted: true, binding: null, absence: "never" }), remote())).toBeUndefined();
    expect(boundLocalChange(state({ binding: null, absence: "user-deleted" }), remote({ deleted: true }))).toBeUndefined();
  });
});

describe("threeWayMerge (content only, decision 6)", () => {
  function request(local: { path: string; content: string | null }, remoteRevision: RemoteRevision, remoteContent: string, baseContent: string): MergeRequest {
    return {
      remote: remoteRevision,
      base: state(),
      local: { path: local.path, content: local.content === null ? null : encoder.encode(local.content) },
      readRemoteContent: () => Promise.resolve(encoder.encode(remoteContent)),
      readBaseContent: () => Promise.resolve(encoder.encode(baseContent)),
      descendsFromBase: true,
    };
  }

  it("returns no path, whatever the local or remote rename", async () => {
    const outcome = await threeWayMerge(request({ path: "renamed.md", content: "one\n" }, remote({ path: "moved.md" }), "two\n", "one\n"));
    expect(outcome).toEqual({ status: "merged", content: encoder.encode("two\n") });
    expect(outcome).not.toHaveProperty("path");
  });

  // #790: a tombstone's merge has no common base, unless the engine gives the deleted revision's content.
  describe("when the base is a tombstone", () => {
    function tombstone(local: string, before: string | null): MergeRequest {
      return {
        remote: remote(),
        base: state({ deleted: true }),
        local: { path: "moved.md", content: encoder.encode(local) },
        readRemoteContent: () => Promise.resolve(encoder.encode("back\n")),
        readBaseContent: () => Promise.resolve(before === null ? null : encoder.encode(before)),
        descendsFromBase: false,
      };
    }

    it("takes the remote content when the local file is exactly the deleted revision's content", async () => {
      expect(await threeWayMerge(tombstone("old\n", "old\n"))).toEqual({ status: "merged", content: encoder.encode("back\n") });
    });

    it("keeps both versions when the local file differs from it, or there is none", async () => {
      const both = (local: string) => ({ status: "merged", content: encoder.encode("back\n"), conflict: { reason: "concurrent-create", content: encoder.encode(local) } });
      expect(await threeWayMerge(tombstone("old\nmine\n", "old\n"))).toEqual(both("old\nmine\n"));
      expect(await threeWayMerge(tombstone("old\n", null))).toEqual(both("old\n"));
    });
  });

  // #719 (design §4.6): a base retention purged leaves no content to merge on.
  describe("when the base's content is gone", () => {
    function purged(local: string, descendsFromBase: boolean, baseText: string): MergeRequest {
      return {
        remote: remote(),
        base: state({ baseHash: sha256Hex(encoder.encode(baseText)) }),
        local: { path: "renamed.md", content: encoder.encode(local) },
        readRemoteContent: () => Promise.resolve(encoder.encode("remote edit\n")),
        readBaseContent: () => Promise.resolve(null),
        descendsFromBase,
      };
    }

    it("takes the remote content when the local file is the base and the remote descends from it", async () => {
      expect(await threeWayMerge(purged("base\n", true, "base\n"))).toEqual({ status: "merged", content: encoder.encode("remote edit\n") });
    });

    it("keeps both versions when the remote is not known to descend from the base", async () => {
      expect(await threeWayMerge(purged("base\n", false, "base\n"))).toEqual({
        status: "merged",
        content: encoder.encode("remote edit\n"),
        conflict: { reason: "base-purged", content: encoder.encode("base\n") },
      });
    });

    it("keeps both versions when the local file changed since the base", async () => {
      expect(await threeWayMerge(purged("local edit\n", true, "base\n"))).toEqual({
        status: "merged",
        content: encoder.encode("remote edit\n"),
        conflict: { reason: "base-purged", content: encoder.encode("local edit\n") },
      });
    });
  });
});
