import { describe, expect, it } from "vitest";

import { files, harness, newestServerClaims } from "./testing";

// #913 (INV-2, PO-12, PO-4, design §4.6): a revision the pull or the resync
// defers is its document's newest server claim, whatever its blocker. A
// document the restored server lost (a ghost) whose synced path collides
// with it under the server's key yields in the step that defers it, as it
// does to a head applied, merged or rolled back there. Here the blocker is
// the download cap (`too-large`, written by the same deferral routine as
// `path-conflict` and `local-changes`); the property suite covers an
// `F`-alias (`unmaterializable`).

const encoder = new TextEncoder();
const cap = 10;

describe("SyncEngine deferring a head at a ghost's synced path", () => {
  it("makes the ghost yield the path in the resync that defers the head, re-creating it where the user moved its file", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: cap });
    await h.vault.write("note.md", encoder.encode("ghost\n"));
    await h.engine.push();
    const ghost = [...h.server.liveDocuments()].find(([path]) => path === "note.md")?.[1] ?? "";
    await h.vault.rename("note.md", "moved.md");

    // The restore loses the ghost; another device's document over the cap now has its synced path.
    h.server.restoreTo(0n);
    h.server.commit({ documentId: "big", path: "note.md", content: "x".repeat(cap + 1) });
    expect(await h.engine.pull()).toMatchObject({ resynced: true, deferred: 1 });

    expect((await h.journal.getDeferred("big"))?.reason).toBe("too-large");
    // The deferral is the only claim of the path: the ghost's base no longer claims it.
    expect(await newestServerClaims(h.journal)).not.toContainEqual([ghost, "note.md"]);

    // The ghost's file stays where the user moved it, and the push re-creates it there under its own id.
    await h.engine.push();
    expect(await files(h.vault)).toEqual(new Map([["moved.md", "ghost\n"]]));
    expect([...h.server.liveDocuments()].sort()).toEqual([
      ["moved.md", ghost],
      ["note.md", "big"],
    ]);
  });
});
