import { describe, expect, it } from "vitest";
import type { DocumentState, RemoteRevision } from "../journal/journal";
import { mergePath } from "./decide";
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

  it("takes the remote path for a tombstone brought back by a bound file elsewhere", () => {
    expect(mergePath(state({ deleted: true }), "copy.md", remote({ path: "back.md" }))).toBe("back.md");
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
    };
  }

  it("returns no path, whatever the local or remote rename", async () => {
    const outcome = await threeWayMerge(request({ path: "renamed.md", content: "one\n" }, remote({ path: "moved.md" }), "two\n", "one\n"));
    expect(outcome).toEqual({ status: "merged", content: encoder.encode("two\n") });
    expect(outcome).not.toHaveProperty("path");
  });
});
