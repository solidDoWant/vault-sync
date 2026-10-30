import { describe, expect, it } from "vitest";

import type { SyncEngineOptions } from "./engine";
import { InMemoryServer } from "./memory-server";
import { Device, encryptedServer } from "./testing";

const encoder = new TextEncoder();

/**
 * Device A creates new.md. Its commit lands, but the reply is lost, and the
 * app restarts. During the first sync after the restart the user is typing in
 * b.md, which device B has edited, so A's pull stops (undecided) before it
 * reaches A's own revision, and A's push retries the create with the same
 * revision id. Then B creates later.md, and A syncs several more times.
 */
async function lostReplyThenRestart(server: InMemoryServer, options: Partial<SyncEngineOptions>) {
  const a = new Device(server, "device-a", options);
  const b = new Device(server, "device-b", options);
  await b.write("b.md", "b one\n");
  await b.sync();
  await a.sync();
  await b.write("b.md", "b two\n");
  await b.sync();

  let typed = 0;
  server.interceptor = (method) => {
    if (method === "ListChanges") void a.vault.write("b.md", encoder.encode(`a typing ${String(++typed)}\n`));
  };
  let lost = false;
  server.responseInterceptor = (method) => {
    if (method === "CommitRevision" && !lost) {
      lost = true;
      throw new Error("connection reset");
    }
  };
  await a.write("new.md", "a new note\n");
  await a.sync().catch(() => undefined);
  expect(lost).toBe(true);
  server.responseInterceptor = undefined;

  a.restart();
  await a.sync().catch(() => undefined);
  server.interceptor = undefined;

  for (let round = 0; round < 3; round++) await a.sync().catch(() => undefined);
  await b.write("later.md", "from b\n");
  await b.sync();
  for (let round = 0; round < 5; round++) await a.sync().catch(() => undefined);
  return { a, b };
}

describe("a create whose commit landed but whose reply was lost, retried after a restart", () => {
  it("plaintext vault: the retry is acknowledged and later changes arrive", async () => {
    const server = new InMemoryServer();
    const { a } = await lostReplyThenRestart(server, {});
    expect(await a.engine.refusedNames()).toEqual([]);
    expect(Object.keys(await a.files())).toContain("later.md");
    expect((await a.journal.load()).cursor.seq).toBe(server.headSeq);
  });

  it("encrypted vault: the retry is acknowledged and later changes arrive", async () => {
    const { server, keys } = encryptedServer();
    const { a, b } = await lostReplyThenRestart(server, { keys });
    // Fails: new.md is listed as a refused name ("revision id reused with other fields").
    expect(await a.engine.refusedNames()).toEqual([]);
    // Fails: A's pull stops at its own new.md revision on every sync from now on.
    expect(Object.keys(await a.files())).toContain("later.md");
    expect((await a.journal.load()).cursor.seq).toBe(server.headSeq);

    // And A's later edit of a note B also edited never reaches the server, while A reports "idle".
    await b.write("b.md", "b three\n");
    await b.sync();
    await a.write("b.md", "a edit after the stall\n");
    for (let round = 0; round < 5; round++) await a.sync().catch(() => undefined);
    expect(a.engine.status).toBe("idle");
    expect([...server.liveFiles().values()].join("\n")).toContain("a edit after the stall");
  });
});
