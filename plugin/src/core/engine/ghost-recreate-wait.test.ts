import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { files, harness, testStamp, text } from "./testing";

// #809 (follow-up to #801/#805, INV-7, PO-8): a push that displaces a ghost
// the restore lost to a copy name commits its re-create in the same push,
// unless the copy name is not the push's to commit now. Then the re-create
// waits in the outbox, and a later push commits it.

const encoder = new TextEncoder();
const copy = `STRASSE (conflict laptop ${testStamp}).md`;

describe("SyncEngine re-creating a ghost at a copy name", () => {
  it("leaves the re-create in the outbox while the copy name is out of scope, and commits it once it is back in scope", async () => {
    let copiesSynced = true;
    const vault = new InMemoryVault();
    const h = harness({
      vault,
      merge: "default",
      wrapVault: (inner) =>
        Object.assign(Object.create(inner) as InMemoryVault, {
          isSynced: (path: string) =>
            copiesSynced || !path.includes("(conflict"),
        }),
    });
    await h.vault.write("STRASSE.md", encoder.encode("ghost\n"));
    await h.engine.push();
    expect([...h.server.liveFiles()].map(([path]) => path)).toEqual([
      "STRASSE.md",
    ]);

    // The restore loses the document; this device's resync keeps it as a ghost.
    h.server.restoreTo(0n);
    h.server.commit({
      documentId: "other",
      path: "other.md",
      content: "other\n",
    });
    expect(await h.engine.pull()).toMatchObject({ resynced: true });

    // A new file whose path is one with the ghost's under K takes that path:
    // the ghost yields and is displaced to a copy name, out of scope for now.
    await h.vault.write("Straße.md", encoder.encode("new\n"));
    copiesSynced = false;
    await h.engine.push();

    expect(text(await h.vault.read(copy))).toBe("ghost\n");
    expect([...h.server.liveFiles()].map(([path]) => path).sort()).toEqual([
      "Straße.md",
      "other.md",
    ]);
    expect(
      (await h.journal.listPending()).map((operation) => ({
        path: operation.path,
        baseRevisionId: operation.baseRevisionId,
      })),
    ).toEqual([{ path: copy, baseRevisionId: "" }]);

    // Back in scope, the next push commits the re-create.
    copiesSynced = true;
    await h.engine.push();
    expect(await h.journal.listPending()).toEqual([]);
    expect([...h.server.liveFiles()].map(([path]) => path).sort()).toEqual(
      [copy, "Straße.md", "other.md"].sort(),
    );
  });

  it("leaves the re-create in the outbox, unsent, while an earlier commit's pull in the same push holds its copy name for another document", async () => {
    const vault = new InMemoryVault();
    const h = harness({ vault, merge: "default", maxDownloadBytes: 20 });
    await h.vault.write("n.md", encoder.encode("l1\nl2\nl3\n"));
    await h.engine.push();
    await h.vault.write("STRASSE.md", encoder.encode("ghost\n"));
    await h.engine.push();
    const note =
      [...h.server.liveDocuments()].find(([path]) => path === "n.md")?.[1] ??
      "";
    const ghost =
      [...h.server.liveDocuments()].find(
        ([path]) => path === "STRASSE.md",
      )?.[1] ?? "";

    // The restore keeps n.md and loses STRASSE.md; this device's resync keeps it as a ghost.
    h.server.restoreTo(1n);
    h.server.commit({
      documentId: "other",
      path: "other.md",
      content: "other\n",
    });
    expect(await h.engine.pull()).toMatchObject({ resynced: true });

    // The user edits n.md and creates Straße.md, which takes the ghost's path:
    // the ghost yields to a copy name. Before this push's first commit lands,
    // another device edits n.md (so that commit is refused and pulls) and
    // creates a document at the copy name too large to download here: the
    // pull defers it, and its claim holds the copy name (C3).
    await h.vault.write("Straße.md", encoder.encode("new\n"));
    await h.vault.write("n.md", encoder.encode("L1\nl2\nl3\n"));
    await h.engine.settled();
    const committed: string[] = [];
    let interfere = true;
    h.server.interceptor = (method, request) => {
      if (method !== "CommitRevision") return;
      committed.push((request as { documentId: string }).documentId);
      if (!interfere) return;
      interfere = false;
      h.server.commit({
        documentId: note,
        path: "n.md",
        content: "l1\nl2\nL3\n",
      });
      h.server.commit({
        documentId: "big",
        path: copy,
        content: "x".repeat(40),
      });
    };
    await h.engine.push();
    await h.engine.settled();

    expect(
      (await h.journal.listDeferred()).map((deferred) => [
        deferred.revision.documentId,
        deferred.revision.path,
        deferred.reason,
      ]),
    ).toEqual([["big", copy, "too-large"]]);
    // The ghost's bytes stay at the copy name, its re-create waits in the outbox, and the push never sent it.
    expect(text(await h.vault.read(copy))).toBe("ghost\n");
    expect(
      (await h.journal.listPending()).map((operation) => ({
        documentId: operation.documentId,
        path: operation.path,
        baseRevisionId: operation.baseRevisionId,
      })),
    ).toEqual([{ documentId: ghost, path: copy, baseRevisionId: "" }]);
    expect(committed).not.toContain(ghost);
    expect(h.server.liveFiles().get(copy)).toBe("x".repeat(40));
    // The rest of the push went through: both edits of n.md merged, Straße.md created.
    expect(await files(h.vault)).toEqual(
      new Map([
        [copy, "ghost\n"],
        ["Straße.md", "new\n"],
        ["n.md", "L1\nl2\nL3\n"],
        ["other.md", "other\n"],
      ]),
    );
  });
});
