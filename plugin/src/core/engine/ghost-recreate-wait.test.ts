import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { harness, testStamp, text } from "./testing";

// #809 (follow-up to #801/#805, INV-7, PO-8): a push that displaces a ghost
// the restore lost to a copy name commits its re-create in the same push,
// unless the copy name is not the push's to commit now. Then the re-create
// waits in the outbox, and a later push commits it.

const encoder = new TextEncoder();
const copy = `STRASSE (conflict laptop ${testStamp}).md`;

describe("SyncEngine re-creating a ghost at a copy name", () => {
  it("leaves the re-create in the outbox while the copy name is out of scope, and commits it once it is back in scope", async () => {
    let copiesSynced = true;
    const vault = new InMemoryVault({ filesystem: "faithful" });
    const h = harness({
      vault,
      merge: "default",
      wrapVault: (inner) => Object.assign(Object.create(inner) as InMemoryVault, { isSynced: (path: string) => copiesSynced || !path.includes("(conflict") }),
    });
    await h.vault.write("STRASSE.md", encoder.encode("ghost\n"));
    await h.engine.push();
    expect([...h.server.liveFiles()].map(([path]) => path)).toEqual(["STRASSE.md"]);

    // The restore loses the document; this device's resync keeps it as a ghost.
    h.server.restoreTo(0n);
    h.server.commit({ documentId: "other", path: "other.md", content: "other\n" });
    expect(await h.engine.pull()).toMatchObject({ resynced: true });

    // A new file whose path is one with the ghost's under K takes that path:
    // the ghost yields and is displaced to a copy name, out of scope for now.
    await h.vault.write("Straße.md", encoder.encode("new\n"));
    copiesSynced = false;
    await h.engine.push();

    expect(text(await h.vault.read(copy))).toBe("ghost\n");
    expect([...h.server.liveFiles()].map(([path]) => path).sort()).toEqual(["Straße.md", "other.md"]);
    expect((await h.journal.listPending()).map((operation) => ({ path: operation.path, baseRevisionId: operation.baseRevisionId }))).toEqual([{ path: copy, baseRevisionId: "" }]);

    // Back in scope, the next push commits the re-create.
    copiesSynced = true;
    await h.engine.push();
    expect(await h.journal.listPending()).toEqual([]);
    expect([...h.server.liveFiles()].map(([path]) => path).sort()).toEqual([copy, "Straße.md", "other.md"].sort());
  });
});
