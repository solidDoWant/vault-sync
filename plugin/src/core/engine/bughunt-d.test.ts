import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

const bytes = (value: string) => new TextEncoder().encode(value);

describe.each(["posix", "macos", "windows"] as const)("renames on %s", (platform) => {
  it("moves a note into the path another note just left", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "X", path: "x.md", content: "x\n" });
    h.server.commit({ documentId: "P", path: "b.md", content: "p\n" });
    await h.engine.pull();
    await h.vault.rename("b.md", "c.md");
    await h.vault.rename("x.md", "b.md");
    await h.engine.push();
    console.log(platform, "plain", JSON.stringify([...h.server.liveDocuments()]));
    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "X"], ["c.md", "P"]]));
  });

  // POSIX: a respelling is a different file, and a rename lost to a restart is the known #167/#349 limitation.
  it.skipIf(platform === "posix")("moves a note whose file the user respelled before a restart", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "X", path: "Foo.md", content: "x\n" });
    await h.engine.pull();
    await h.vault.rename("Foo.md", "foo.md");
    h.restart();
    await h.engine.push();
    console.log(platform, "after-restart-push", JSON.stringify([...h.server.liveDocuments()]), JSON.stringify((await h.journal.listDocuments()).map((s) => [s.documentId, s.path, s.deleted])));
    await h.vault.rename("foo.md", "b.md");
    await h.engine.push();
    console.log(platform, "respelled", JSON.stringify([...h.server.liveDocuments()]), JSON.stringify([...(await files(h.vault))]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "X"]]));
  });

  it.skipIf(platform === "posix")("moves a respelled note into the path another note just left", async () => {
    const h = harness({ merge: "default", pathRules: { platform } });
    h.server.commit({ documentId: "X", path: "Foo.md", content: "x\n" });
    h.server.commit({ documentId: "P", path: "b.md", content: "p\n" });
    await h.engine.pull();
    await h.vault.rename("Foo.md", "foo.md");
    h.restart();
    await h.engine.push();
    await h.vault.rename("b.md", "c.md");
    await h.vault.rename("foo.md", "b.md");
    await h.engine.push();
    await h.engine.push();
    console.log(platform, "respelled+swap", JSON.stringify([...h.server.liveDocuments()]), JSON.stringify([...(await files(h.vault))]));
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
  });
});
