import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { harness, type Harness } from "./testing";

// Two live server documents whose paths differ under the server's key but
// name one file on the device (`ı.md` and `I.md` on Windows and macOS,
// design docs/design/engine-path-ownership.md §3.1). The device can hold only
// one: the document whose binding holds the file keeps it, and the other is
// unmaterializable here (`alias`), a non-disk blocker that claims no path,
// until the server moves or deletes the holder (decision #52, #736).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** With `recordMerges`, the harness's merge hook, which defers every merge, instead of the engine's default. */
function faithful(platform: "macos" | "windows", recordMerges = false): Harness {
  const pathRules = { platform };
  return harness({ ...(recordMerges ? {} : { merge: "default" as const }), pathRules, vault: new InMemoryVault({ pathRules }) });
}

async function rounds(h: Harness): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await h.engine.pull();
    await h.engine.push();
    await h.engine.settled();
  }
}

describe.each(["windows", "macos"] as const)("two live documents ı.md and I.md on %s", (platform) => {
  it("keeps the first one's file and lists the second as unmaterializable, with no path-conflict deferral", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "upper", path: "I.md", content: "upper\n" });
    await rounds(h);
    h.server.commit({ documentId: "dotless", path: "ı.md", content: "dotless\n" });
    await rounds(h);

    expect(decoder.decode((await h.vault.read("I.md")))).toBe("upper\n");
    expect(await h.vault.list()).toEqual(["I.md"]);
    const deferred = await h.journal.listDeferred();
    expect(deferred.map((entry) => [entry.revision.documentId, entry.reason, entry.unmaterializable])).toEqual([["dotless", "unmaterializable", "alias"]]);
    expect((await h.engine.unmaterializable()).map((document) => [document.documentId, document.path, document.reason])).toEqual([["dotless", "ı.md", "alias"]]);
    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["I.md", "upper\n"],
        ["ı.md", "dotless\n"],
      ]),
    );
  });

  it("pushes a write through the alias spelling as an edit of the document holding the file", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "upper", path: "I.md", content: "upper\n" });
    await rounds(h);
    h.server.commit({ documentId: "dotless", path: "ı.md", content: "dotless\n" });
    await rounds(h);
    await h.vault.write("ı.md", encoder.encode("through the alias\n"));
    await rounds(h);

    expect(h.server.liveFiles()).toEqual(
      new Map([
        ["I.md", "through the alias\n"],
        ["ı.md", "dotless\n"],
      ]),
    );
  });

  it("materializes the second document once the server moves the holder away", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "upper", path: "I.md", content: "upper\n" });
    await rounds(h);
    h.server.commit({ documentId: "dotless", path: "ı.md", content: "dotless\n" });
    await rounds(h);
    h.server.commit({ documentId: "upper", path: "moved.md", content: "upper\n" });
    await rounds(h);

    expect((await h.vault.list()).sort()).toEqual(["moved.md", "ı.md"].sort());
    expect(decoder.decode((await h.vault.read("ı.md")))).toBe("dotless\n");
    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await h.engine.unmaterializable()).toEqual([]);
  });

  it("materializes the second document once the server deletes the holder (#749)", async () => {
    const h = faithful(platform);
    h.server.commit({ documentId: "upper", path: "I.md", content: "upper\n" });
    await rounds(h);
    h.server.commit({ documentId: "dotless", path: "ı.md", content: "dotless\n" });
    await rounds(h);
    h.server.commit({ documentId: "upper", path: "I.md", deleted: true });
    await rounds(h);

    expect(await h.vault.list()).toEqual(["ı.md"]);
    expect(decoder.decode((await h.vault.read("ı.md")))).toBe("dotless\n");
    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await h.engine.unmaterializable()).toEqual([]);
    expect(h.server.liveFiles()).toEqual(new Map([["ı.md", "dotless\n"]]));
  });

  it("materializes the second document once the holder's file is gone, while the holder's server delete is still deferred (#749)", async () => {
    const h = faithful(platform, true);
    h.server.commit({ documentId: "upper", path: "I.md", content: "upper\n" });
    await rounds(h);
    h.server.commit({ documentId: "dotless", path: "ı.md", content: "dotless\n" });
    await rounds(h);
    // An unpushed edit meets the server's delete: the merge hook defers it,
    // so the holder's newest server claim is a deferred tombstone.
    await h.vault.write("I.md", encoder.encode("edited\n"));
    h.server.commit({ documentId: "upper", path: "I.md", deleted: true });
    await h.engine.pull();
    await h.engine.settled();
    expect((await h.journal.listDeferred()).map((entry) => [entry.revision.documentId, entry.revision.deleted, entry.reason])).toEqual(
      expect.arrayContaining([["upper", true, "local-changes"]]),
    );
    // The user deletes the file too: nothing on the device holds the one file any more.
    await h.vault.delete("I.md");
    await rounds(h);

    expect(await h.vault.list()).toEqual(["ı.md"]);
    expect(decoder.decode((await h.vault.read("ı.md")))).toBe("dotless\n");
    expect(await h.engine.unmaterializable()).toEqual([]);
    expect((await h.journal.listDeferred()).map((entry) => [entry.revision.documentId, entry.revision.deleted, entry.reason])).toEqual([["upper", true, "local-changes"]]);
  });
});
