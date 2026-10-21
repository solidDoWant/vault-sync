import { describe, expect, it } from "vitest";

import type { CommitRevisionRequest } from "../../gen/vaultsync/v1/sync_pb";
import { files, harness, testDeviceName } from "./testing";

// A create refused because another document holds one of its folders moves
// under a conflict-named folder (SPEC.md §7, PO-14): the outermost folder a
// file holds gets the suffix, so the path keeps its place inside it (#359).
// Here an untracked file `A` holds the outer folder `a` by path key and a
// remote document `a/B` the inner folder `a/b`: `a/b (conflict …)/c.md` would
// still be under the file `A`, so the note moves under `a (conflict …)/` and
// is committed there, never reported rejected (#592, #596).

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const stamp = `${testDeviceName} 2026-10-18 040506`;

describe("a refused create under folders an untracked file and a remote document hold", () => {
  it("moves the note under the outer conflict-named folder and commits it there (posix)", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("a/b/c.md", encoder.encode("new note\n"));
    // While the note's create is on its way, another device commits `a/B`
    // (so the server refuses the create) and the user saves the file `A`,
    // which this push has not seen yet: it is listed, but no document's.
    h.server.interceptor = (method, request) => {
      if (method !== "CommitRevision" || decoder.decode((request as CommitRevisionRequest).path) !== "a/b/c.md") return;
      h.server.interceptor = undefined;
      h.server.commit({ documentId: "remote", path: "a/B", content: "remote\n" });
      void h.vault.write("A", encoder.encode("untracked\n"));
    };

    const first = await h.engine.push();
    expect(first.rejected).toEqual([]);
    for (let round = 0; round < 3; round++) {
      await h.engine.pull();
      await h.engine.push();
    }

    const note = `a (conflict ${stamp})/b/c.md`;
    // The file `A` was pushed too and then moved aside from the remote folder `a`, under a name clear of the note's folder.
    const untracked = `A (conflict ${stamp} 2)`;
    expect(await files(h.vault)).toEqual(
      new Map([
        [untracked, "untracked\n"],
        [note, "new note\n"],
        ["a/B", "remote\n"],
      ]),
    );
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["a/B", "remote\n"],
        [note, "new note\n"],
        [untracked, "untracked\n"],
      ]),
    );
    const conflicts = (await h.journal.listConflicts()).map(({ path, reason, copyPath }) => ({ path, reason, copyPath }));
    expect(conflicts).toContainEqual({ path: "a/b/c.md", reason: "path-taken", copyPath: note });
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.listDeferred()).toEqual([]);
  });
});
