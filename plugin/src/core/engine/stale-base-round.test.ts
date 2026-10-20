import { describe, expect, it } from "vitest";

import { files, harness, moveHeadBeforeCommit } from "./testing";

// A push detects every changed file of a round before it commits any. A
// commit refused because the head moved pulls, and that pull can merge a
// remote revision of another document of the same round, which moves the
// document's base on (#482). Where the merge leaves the file as it was, the
// round's operation for that document, detected against the old base, must
// not be committed as it is: the server refuses it as head moved for good,
// since the pull after each refusal finds nothing left to merge, and the
// engine would never stop committing.

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

describe("SyncEngine, given a pull during a push that merges a remote revision of a document the push has yet to commit", () => {
  it("commits the local edit of a note deleted remotely meanwhile on top of the delete, and then quiesces", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "a", path: "a.md", content: "a\n" });
    h.server.commit({ documentId: "b", path: "b.md", content: "b\n" });
    await h.engine.pull();
    await h.vault.write("a.md", bytes("a\nmine\n"));
    await h.vault.write("b.md", bytes("b\nmine\n"));
    await h.engine.settled();
    // Another device edits a.md and deletes b.md just before this push's
    // first commit: whichever note it commits first is refused, and the pull
    // then merges both.
    moveHeadBeforeCommit(h, () => {
      h.server.commit({ documentId: "a", path: "a.md", content: "theirs\na\n" });
      h.server.commit({ documentId: "b", path: "b.md", deleted: true });
    });

    const first = await h.engine.push();
    const second = await h.engine.push();

    // The edit wins over the delete (SPEC.md §7), and both edits of a.md merge.
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["a.md", "theirs\na\nmine\n"],
        ["b.md", "b\nmine\n"],
      ]),
    );
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(first.pending).toBe(0);
    expect(second).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
  });

  it("drops the local edit of a note another device made the same edit to meanwhile, and then quiesces", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "a", path: "a.md", content: "a\n" });
    h.server.commit({ documentId: "b", path: "b.md", content: "b\n" });
    await h.engine.pull();
    await h.vault.write("a.md", bytes("a\nmine\n"));
    await h.vault.write("b.md", bytes("b\nsame\n"));
    await h.engine.settled();
    // The merge of b.md leaves the file as it is: it already holds the head's content.
    moveHeadBeforeCommit(h, () => {
      h.server.commit({ documentId: "a", path: "a.md", content: "theirs\na\n" });
      h.server.commit({ documentId: "b", path: "b.md", content: "b\nsame\n" });
    });

    const first = await h.engine.push();
    const second = await h.engine.push();

    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["a.md", "theirs\na\nmine\n"],
        ["b.md", "b\nsame\n"],
      ]),
    );
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(first.pending).toBe(0);
    expect(second).toEqual({ committed: 0, conflicts: 0, pending: 0, rejected: [] });
  });
});
