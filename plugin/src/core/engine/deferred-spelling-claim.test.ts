import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash";
import type { DeferredRevision, DocumentState } from "../journal/journal";
import { busyClaims } from "./push-plan";
import { harness } from "./testing";

// A document whose remote revision is deferred keeps its local changes from
// the push, and the paths it claims wait with it (busyClaims; design §4.5
// step 2, PO-11, C3): the deferred revision's path, and the file it is bound
// to here, wherever a local rename put it (#671 item 5).

const bytes = (value: string) => new TextEncoder().encode(value);

describe("busyClaims", () => {
  const remote = { revisionId: "D@2", documentId: "D", seq: 2n, parentRevisionId: "D@1", kind: "text" as const, path: "d.md", deleted: false, contentHash: "h2", size: 2n };
  const moved: DocumentState = { documentId: "D", path: "d.md", revisionId: "D@1", seq: 1n, baseHash: "h1", size: 2n, kind: "text", deleted: false, binding: { spelling: "q.md", fileKey: "q.md", seen: "h1" }, absence: null };

  it.each(["local-changes", "unmaterializable", "out-of-scope", "too-large"] as const)("holds a %s document's deferred path and the path a local rename moved its file to", (reason) => {
    const deferred: DeferredRevision = { revision: remote, reason };

    const busy = busyClaims([moved], [deferred]);

    expect(busy.documents).toEqual(new Set(["D"]));
    expect(busy.paths).toEqual(new Set(["d.md", "q.md"]));
  });

  it("holds the deferred path alone for a document with no file here", () => {
    const busy = busyClaims([{ ...moved, binding: null, absence: "user-deleted" }], [{ revision: remote, reason: "local-changes" }]);

    expect(busy.paths).toEqual(new Set(["d.md"]));
  });
});

describe("the file of a document with a deferred revision", () => {
  it("keeps the path a local rename moved it to from another document's outgoing operation", async () => {
    const h = harness();
    h.server.commit({ documentId: "D", path: "d.md", content: "d1" });
    await h.engine.pull();
    // A local edit, then a remote one: the merge hook defers, so D's revision waits.
    await h.vault.write("d.md", bytes("d-local"));
    h.server.commit({ documentId: "D", path: "d.md", content: "d2" });
    await h.engine.pull();
    expect(await h.journal.getDeferred("D")).toMatchObject({ reason: "local-changes" });
    // E's create at q.md is in the outbox (an interrupted push left it).
    await h.vault.write("q.md", bytes("e"));
    await h.engine.settled();
    h.engine.dispose();
    await h.journal.addPending({ revisionId: "create-E", documentId: "E", baseRevisionId: "", path: "q.md", contentHash: sha256Hex(bytes("e")), size: 1n, kind: "text", deleted: false });
    h.restart();
    await h.engine.settled();
    // The user deletes E's file and moves D's file to q.md.
    await h.vault.delete("q.md");
    await h.vault.rename("d.md", "q.md");
    await h.engine.settled();
    expect((await h.journal.getDocument("D"))?.binding?.spelling).toBe("q.md");

    await h.engine.push();
    await h.engine.settled();

    // D's file is D's: no other document takes it to the server.
    expect(h.server.liveDocuments().get("q.md")).toBeUndefined();
    expect([...h.server.liveFiles().values()]).not.toContain("d-local");
  });
});
