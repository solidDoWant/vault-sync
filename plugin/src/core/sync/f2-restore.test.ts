import { expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

async function converge(a: Device, b: Device): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
}

it("restore: a note deleted after the backup and re-created at the same name keeps syncing", async () => {
  const server = new InMemoryServer();
  const a = new Device(server, "device-a");
  const b = new Device(server, "device-b");
  await a.engine.start();
  await b.engine.start();
  await a.write("a.md", "original note\n");
  await converge(a, b);
  const backupSeq = server.currentHeadSeq;
  await a.vault.delete("a.md");
  await converge(a, b);
  await a.write("a.md", "a new note\n");
  await converge(a, b);
  server.restoreTo(backupSeq); // offline restore of the backup
  await converge(a, b);
  // After the resync, A's a.md is held by a pending create the server refuses for good.
  expect(await a.engine.refusedNames()).toEqual([]); // actual: [{ path: "a.md", reason: "another live document has this path" }]
  await a.write("a.md", "edited on A after the resync\n");
  await converge(a, b);
  expect(server.liveFiles().get("a.md")).toBe("edited on A after the resync\n"); // actual: "original note\n"
  expect((await b.files())["a.md"]).toBe("edited on A after the resync\n"); // actual: "original note\n"
});

it("restore: a note renamed after the backup, with a new note at its old name, converges", async () => {
  const server = new InMemoryServer();
  const a = new Device(server, "device-a");
  const b = new Device(server, "device-b");
  await a.engine.start();
  await b.engine.start();
  await a.write("a.md", "original note\n");
  await converge(a, b);
  const backupSeq = server.currentHeadSeq;
  await a.vault.rename("a.md", "b.md");
  await a.write("a.md", "a new note\n");
  await converge(a, b);
  server.restoreTo(backupSeq);
  await converge(a, b);
  // Devices: a.md = "a new note"; server: a.md = "original note" plus a duplicate b.md. A fresh device never gets "a new note".
  expect(new Map(Object.entries(await a.files()))).toEqual(server.liveFiles());
});
