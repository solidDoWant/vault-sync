import { describe, expect, it } from "vitest";

import { InMemoryVault } from "../vault/memory";
import { files, harness, testStamp } from "./testing";

// #869 (INV-7, PO-12, design §4.6): of two ghosts a restore lost whose bound
// spellings collide under K, which one keeps its path and which yields to a
// copy name must not depend on their document ids. A restarted push re-plans
// its creates under fresh ids, so an id-ordered choice changes with a crash.

const encoder = new TextEncoder();

/**
 * Syncs `STRASSE.md` and `b.md`, in `order`, so their document ids order
 * them that way. Then it restores the server to nothing, renames `b.md` to
 * `Straße.md` (one path with `STRASSE.md` under K) and pushes the two ghosts.
 */
async function recreate(order: ("STRASSE.md" | "b.md")[]): Promise<{ server: string[]; vault: [string, string][] }> {
  const h = harness({ vault: new InMemoryVault(), merge: "default" });
  const contents = { "STRASSE.md": "upper\n", "b.md": "sharp\n" };
  for (const path of order) {
    await h.vault.write(path, encoder.encode(contents[path]));
    await h.engine.push();
  }
  h.server.restoreTo(0n);
  h.server.commit({ documentId: "other", path: "other.md", content: "other\n" });
  expect(await h.engine.pull()).toMatchObject({ resynced: true });
  await h.vault.rename("b.md", "Straße.md");
  await h.engine.push();
  await h.engine.pull();
  return {
    server: [...h.server.liveFiles()].map(([path, content]) => `${path}=${content}`).sort(),
    vault: [...(await files(h.vault))].sort(([a], [b]) => (a < b ? -1 : 1)),
  };
}

describe("SyncEngine re-creating ghosts that collide under K", () => {
  it("gives the path to the same ghost whichever document id is lower", async () => {
    const upperFirst = await recreate(["STRASSE.md", "b.md"]);
    const sharpFirst = await recreate(["b.md", "STRASSE.md"]);
    const copy = `Straße (conflict laptop ${testStamp}).md`;
    expect(upperFirst.server).toEqual(["STRASSE.md=upper\n", `${copy}=sharp\n`, "other.md=other\n"].sort());
    expect(sharpFirst).toEqual(upperFirst);
  });
});
