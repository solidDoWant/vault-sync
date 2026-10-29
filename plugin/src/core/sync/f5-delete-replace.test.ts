import { expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

async function converge(a: Device, b: Device): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
}

it("deleting a note and renaming another note onto its name syncs", async () => {
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
  // actual: server and B still hold old.md = "old note" and draft.md; A's journal has no delete for old.md, and the rename is refused.
  expect(new Map(Object.entries(await a.files()))).toEqual(server.liveFiles());
  expect(await b.files()).toEqual({ "old.md": "draft\n" });
});

it("after replacing a note that way, edits on both sides still sync", async () => {
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
  await a.write("old.md", "draft, edited on A\n");
  await b.write("old.md", "old note, edited on B\n");
  await converge(a, b);
  expect([...server.liveFiles().values()]).toContain("draft, edited on A\n"); // actual: A's edit never pushed
  expect((await a.journal.load()).cursor.seq).toBe(server.currentHeadSeq); // actual: A's pull stops at 2, head 3, status idle
});
