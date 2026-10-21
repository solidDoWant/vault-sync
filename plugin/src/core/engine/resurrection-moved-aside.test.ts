import { describe, expect, it } from "vitest";

import { files, harness, moveHeadBeforeCommit } from "./testing";

// Seeds 100083 and 100088 (#700): this device brings a deleted note back with
// an edit while a new note holds its path, so rule W moves the edit aside to a
// copy name, bound to the tombstone. Another device brings the note back at
// its own copy name just before this device's commit lands. The merge takes
// the bound file as the document's local version (design §4.5 step 4), so the
// edit is never left behind as a file no document holds (SPEC.md §2
// principle 1).

const bytes = (content: string) => new TextEncoder().encode(content);

describe.each(["posix", "macos", "windows"] as const)("a deleted note brought back here and on another device while a new note takes its path on %s", (platform) => {
  it("keeps this device's edit in a live document and converges", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    await h.vault.write("s.md", bytes("s\n"));
    await h.engine.push();
    const documentId = h.server.liveDocuments().get("s.md") ?? "";
    h.server.commit({ documentId, path: "s.md", deleted: true, deviceId: "phone" });
    h.server.commit({ documentId: "other", path: "s.md", content: "other\n", deviceId: "phone" });

    await h.vault.write("s.md", bytes("s\nlocal\n"));
    await h.engine.settled();
    await h.engine.pull();
    moveHeadBeforeCommit(h, () => h.server.commit({ documentId, path: "s (conflict phone 1).md", content: "s\nremote\n", deviceId: "phone" }));
    for (let round = 0; round < 4; round++) await h.engine.push();
    await h.engine.pull();

    const contents = [...h.server.liveFiles().values()];
    expect(contents.filter((content) => content.includes("local"))).toHaveLength(1);
    expect(contents.filter((content) => content.includes("remote"))).toHaveLength(1);
    expect(contents).toContain("other\n");
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.journal.listPending()).toEqual([]);
  });
});

// Seed 100039 (#700): the other device brings the note back at a path Windows cannot hold. The revision waits as
// unmaterializable, and this device keeps the moved-aside edit, reported as the document's kept file (SPEC.md §8).
describe("a deleted note brought back on another device at a path Windows cannot hold", () => {
  it("keeps this device's moved-aside edit and reports it as the document's kept file", async () => {
    const h = harness({ merge: "default", pathRules: { platform: "windows" } });
    await h.vault.write("s.md", bytes("s\n"));
    await h.engine.push();
    const documentId = h.server.liveDocuments().get("s.md") ?? "";
    h.server.commit({ documentId, path: "s.md", deleted: true, deviceId: "phone" });
    h.server.commit({ documentId: "other", path: "s.md", content: "other\n", deviceId: "phone" });

    await h.vault.write("s.md", bytes("s\nlocal\n"));
    await h.engine.settled();
    await h.engine.pull();
    moveHeadBeforeCommit(h, () => h.server.commit({ documentId, path: "ab:c.md", content: "s\nremote\n", deviceId: "phone" }));
    for (let round = 0; round < 4; round++) await h.engine.push();
    await h.engine.pull();

    const unmaterializable = await h.engine.unmaterializable();
    expect(unmaterializable.map((document) => [document.documentId, document.path])).toEqual([[documentId, "ab:c.md"]]);
    const kept = unmaterializable[0]?.localPath;
    expect(kept).toBeDefined();
    expect(new TextDecoder().decode((await h.vault.read(kept ?? "")) ?? new Uint8Array())).toBe("s\nlocal\n");
    // Every other file is a live document's.
    const local = await files(h.vault);
    local.delete(kept ?? "");
    const live = h.server.liveFiles();
    live.delete("ab:c.md");
    expect(local).toEqual(live);
  });
});
