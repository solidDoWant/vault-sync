import { describe, expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

async function converge(a: Device, b: Device): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
}

/** Two started devices that both hold `old.md` and `draft.md`, after A deleted `old.md` and renamed `draft.md` onto its name, synced until idle. */
async function replacedByRename(): Promise<{ server: InMemoryServer; a: Device; b: Device }> {
  const server = new InMemoryServer();
  const a = new Device(server, "device-a");
  const b = new Device(server, "device-b");
  await a.engine.start();
  await b.engine.start();
  await a.write("old.md", "old note\n");
  await a.write("draft.md", "draft\n");
  await converge(a, b);
  await a.vault.delete("old.md");
  await a.vault.rename("draft.md", "old.md");
  await converge(a, b);
  return { server, a, b };
}

describe("a note deleted and replaced by renaming another note onto its name", () => {
  it("syncs as the delete plus the rename, and leaves nothing pending", async () => {
    const { server, a, b } = await replacedByRename();
    try {
      expect(await a.files()).toEqual({ "old.md": "draft\n" });
      expect(await b.files()).toEqual({ "old.md": "draft\n" });
      expect(server.liveFiles()).toEqual(new Map([["old.md", "draft\n"]]));
      expect((await a.journal.load()).pending).toEqual([]);
    } finally {
      a.engine.stop();
      b.engine.stop();
    }
  });

  it("keeps syncing later edits of the replaced name on both devices", async () => {
    const { server, a, b } = await replacedByRename();
    try {
      await a.write("old.md", "draft, edited on A\n");
      await b.write("old.md", "draft, edited on B\n");
      await converge(a, b);
      const onServer = Object.fromEntries(server.liveFiles());
      expect(await a.files()).toEqual(onServer);
      expect(await b.files()).toEqual(onServer);
      const contents = Object.values(onServer).join("");
      expect(contents).toContain("edited on A");
      expect(contents).toContain("edited on B");
      expect((await a.journal.load()).cursor.seq).toBe(server.currentHeadSeq);
      expect((await b.journal.load()).cursor.seq).toBe(server.currentHeadSeq);
      expect((await a.journal.load()).pending).toEqual([]);
      expect((await b.journal.load()).pending).toEqual([]);
    } finally {
      a.engine.stop();
      b.engine.stop();
    }
  });
});
