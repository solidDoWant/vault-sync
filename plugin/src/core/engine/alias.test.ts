import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { harness, type Harness } from "./testing";

// Two live server documents whose paths differ under the server's key but
// name one file on the device (`ı.md` and `I.md` on Windows and macOS,
// design docs/design/engine-path-ownership.md §3.1). The device can hold only
// one: the document whose binding holds the file keeps it, and the other is
// unmaterializable here (`alias`), a non-disk blocker that claims no path,
// until the server moves the holder away (decision #52, #736).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function faithful(platform: "macos" | "windows"): Harness {
  const pathRules = { platform };
  return harness({ merge: "default", pathRules, vault: new InMemoryVault({ pathRules, filesystem: "faithful" }) });
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
});
