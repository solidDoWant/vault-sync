import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

it("nested folders deleted on A stay deleted when B syncs between A's commits", async () => {
  const server = new InMemoryServer();
  const a = new Device(server, "device-a");
  const b = new Device(server, "device-b");
  await a.engine.start();
  await b.engine.start();
  await a.vault.createFolder("Archive/Sub");
  await a.sync();
  await b.sync();
  expect((await b.vault.listFolders()).sort()).toEqual(["Archive", "Archive/Sub"]);

  await a.vault.deleteFolder("Archive/Sub");
  await a.vault.deleteFolder("Archive");
  // A's connection drops after its first commit (the tombstone of "Archive"); B syncs meanwhile.
  let commits = 0;
  server.interceptor = (method) => {
    if (method === "CommitRevision" && ++commits === 2) throw new ConnectError("unavailable", Code.Unavailable);
  };
  await a.sync().catch(() => undefined);
  server.interceptor = undefined;
  await b.sync();
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
  expect(await a.vault.listFolders()).toEqual([]); // actual: ["Archive"]
  expect(await b.vault.listFolders()).toEqual([]); // actual: ["Archive"]
  expect(server.liveDocuments()).toEqual(new Map()); // actual: a new live FOLDER document "Archive"
});
