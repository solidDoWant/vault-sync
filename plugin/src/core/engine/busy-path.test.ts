import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { harness, type Harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);

/** The server refuses every CommitRevision as invalid until `allow` is called. */
function refuseCommits(h: Harness): { allow: () => void } {
  h.server.interceptor = (method) => {
    if (method === "CommitRevision") throw new ConnectError("refused", Code.InvalidArgument);
  };
  return {
    allow: () => {
      h.server.interceptor = undefined;
    },
  };
}

// #167 item 3: a push skips a changed path while a pending operation or the
// merge path has it, and must look at it again on a later push, not only after
// a restart's full scan.
describe("SyncEngine changes at a busy path", () => {
  it("pushes a file created at the old path of a refused rename once the rename commits, without another local change", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "d", path: "a.md", content: "one" });
    await h.engine.pull();
    const server = refuseCommits(h);
    await h.vault.rename("a.md", "b.md");
    await h.engine.push();
    // The journal still has d at a.md, so the new file there is at d's path while the rename is pending.
    await h.vault.write("a.md", bytes("new note"));
    const refused = await h.engine.push();
    expect(refused.rejected.map(({ operation }) => operation.path)).toEqual(["b.md"]);
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", "one"]]));
    server.allow();

    await h.engine.push();

    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["a.md", "new note"],
        ["b.md", "one"],
      ]),
    );
    expect(h.server.liveDocuments().get("b.md")).toBe("d");
    expect(h.server.liveDocuments().get("a.md")).not.toBe("d");
    expect(await h.journal.listPending()).toEqual([]);
  });

  it("pushes an edit made while the document's own refused operation was pending on top of it", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "d", path: "a.md", content: "one" });
    await h.engine.pull();
    const server = refuseCommits(h);
    await h.vault.write("a.md", bytes("two"));
    await h.engine.push();
    await h.vault.write("a.md", bytes("three"));
    await h.engine.push();
    server.allow();

    await h.engine.push();

    expect(h.server.liveFiles()).toEqual(new Map([["a.md", "three"]]));
    expect(await h.journal.listPending()).toEqual([]);
  });
});
