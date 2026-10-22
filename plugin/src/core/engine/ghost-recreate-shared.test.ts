import { describe, expect, it } from "vitest";

import { harness, text } from "./testing";

// #816 (INV-4, PO-12, design §4.6): document ids are shared, so after a
// restore two devices can both hold a document as a ghost. Another device's
// re-create of it is that device's revision of a document with local changes
// here: it is merged (§4.5 step 4), never taken as this device's own create
// and overwritten.

const encoder = new TextEncoder();

describe("SyncEngine re-creating a ghost another device re-created too", () => {
  it("merges the other device's re-create instead of committing over it", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("n.md", encoder.encode("n\n"));
    await h.engine.push();
    await h.vault.write("STRASSE.md", encoder.encode("ghost\n"));
    await h.engine.push();
    const ghost = (await h.journal.listDocuments()).find((state) => state.path === "STRASSE.md")?.documentId;
    if (ghost === undefined) throw new Error("STRASSE.md has no document");
    const note = (await h.journal.listDocuments()).find((state) => state.path === "n.md")?.documentId;
    if (note === undefined) throw new Error("n.md has no document");

    // The restore loses STRASSE.md; this device's resync keeps it as a ghost.
    h.server.restoreTo(1n);
    h.server.commit({ documentId: "other", path: "other.md", content: "other\n" });
    expect(await h.engine.pull()).toMatchObject({ resynced: true });

    // The ghost yields to a new file under K, and n.md changes.
    await h.vault.write("Straße.md", encoder.encode("new\n"));
    await h.vault.write("n.md", encoder.encode("n local\n"));
    // Before this device's first commit lands, another device edits n.md
    // (so the commit is refused and this device pulls) and re-creates the
    // ghost with its own content.
    let fired = false;
    h.server.interceptor = (method) => {
      if (method !== "CommitRevision" || fired) return;
      fired = true;
      h.server.commit({ documentId: note, path: "n.md", content: "n remote\n", deviceId: "device-2" });
      h.server.commit({ documentId: ghost, path: "elsewhere.md", content: "remote\n", deviceId: "device-2" });
    };
    await h.engine.push();
    h.server.interceptor = undefined;
    await h.engine.push();
    await h.engine.pull();

    // The other device's write survives in a file here, and the ghost's
    // content too: neither is only in history.
    const contents = await Promise.all((await h.vault.list()).map(async (path) => text(await h.vault.read(path)) ?? ""));
    expect(contents).toContain("remote\n");
    expect(contents.some((content) => content.includes("ghost"))).toBe(true);
    const live = [...h.server.liveFiles()].map(([, content]) => content);
    expect(live).toContain("remote\n");
    expect(live.some((content) => content.includes("ghost"))).toBe(true);
  });
});
