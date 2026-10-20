import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

describe.each(["posix", "macos", "windows"] as const)("vacated path + remote rename on %s", (platform) => {
  it.each([
    ["Notes/C.md", "NOTES/b.md"],
    ["notes/C.md", "NOTES/b.md"],
    ["notes/C.md", "notes/x.md"],
    ["notes/z.md", "NOTES/b.md"],
    ["notes/z.md", "Notes/x.md"],
    ["z.md", "NOTES/b.md"],
  ])("a local move into a just-vacated path %s, remote rename to %s", async (target, remoteTarget) => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "A", path: "notes/C.md", content: "a\n" });
    h.server.commit({ documentId: "B", path: "notes/b.md", content: "b\n" });
    await h.engine.pull();

    if (process.env.NO_VACATE === undefined) await h.vault.rename("notes/C.md", "moved/C.md");
    await h.vault.rename("notes/b.md", "moved/b.md");
    await h.vault.rename("moved/b.md", target);
    h.server.commit({ documentId: "B", path: remoteTarget });
    for (let round = 0; round < 3; round++) await h.engine.push();
    console.log(platform, target, remoteTarget, JSON.stringify([...h.server.liveDocuments()]), JSON.stringify([...(await files(h.vault))]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });
});
