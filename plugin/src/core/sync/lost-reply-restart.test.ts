import { describe, expect, it } from "vitest";

import { deriveSubkey, pathKey } from "../e2ee/e2ee";
import type { SyncEngineOptions } from "./engine";
import { InMemoryServer } from "./memory-server";
import { Device, TestKeyring, encryptedServer } from "./testing";

const encoder = new TextEncoder();

/**
 * Device A creates new.md. Its commit lands, but the reply is lost, and the
 * app restarts (after `beforeRestart`). During the first sync after the
 * restart the user is typing in b.md, which device B has edited, so A's pull
 * stops (undecided) before it reaches A's own revision, and A's push retries
 * the create with the same revision id. Then the user stops typing, B creates
 * later.md, and A syncs several more times.
 */
async function lostReplyThenRestart(server: InMemoryServer, options: Partial<SyncEngineOptions>, beforeRestart: (b: Device) => void = () => undefined) {
  const a = new Device(server, "device-a", options);
  const b = new Device(server, "device-b", options);
  await b.write("b.md", "b one\n");
  await b.sync();
  await a.sync();
  await b.write("b.md", "b two\n");
  await b.sync();

  let typed = 0;
  let commits = 0;
  server.interceptor = (method) => {
    if (method === "ListChanges") void a.vault.write("b.md", encoder.encode(`a typing ${String(++typed)}\n`));
    if (method === "CommitRevision") commits++;
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

  beforeRestart(b);
  a.restart();
  const before = commits;
  await a.sync().catch(() => undefined);
  server.interceptor = undefined;
  // The push retried the commit while the pull had not reached A's own revision.
  expect(commits).toBeGreaterThan(before);

  for (let round = 0; round < 3; round++) await a.sync().catch(() => undefined);
  await b.write("later.md", "from b\n");
  await b.sync();
  for (let round = 0; round < 5; round++) await a.sync().catch(() => undefined);
  return { a, b };
}

/** After the stall the issue describes, A's edit of a note B also edited still reaches the server. */
async function laterEditsSync(server: InMemoryServer, a: Device, b: Device) {
  await b.write("b.md", "b three\n");
  await b.sync();
  await a.write("b.md", "a edit after the restart\n");
  for (let round = 0; round < 5; round++) await a.sync().catch(() => undefined);
  expect(a.engine.status).toBe("idle");
  expect([...server.liveFiles().values()].join("\n")).toContain("a edit after the restart");
}

describe("a create whose commit landed but whose reply was lost, retried after a restart", () => {
  it("plaintext vault: the retry is the same commit and later changes sync both ways", async () => {
    const server = new InMemoryServer();
    const { a, b } = await lostReplyThenRestart(server, {});
    expect(await a.engine.refusedNames()).toEqual([]);
    expect(Object.keys(await a.files())).toContain("later.md");
    expect((await a.journal.load()).cursor.seq).toBe(server.currentHeadSeq);
    await laterEditsSync(server, a, b);
  });

  it("encrypted vault: the retry is the same commit and later changes sync both ways", async () => {
    const { server, keys } = encryptedServer();
    const { a, b } = await lostReplyThenRestart(server, { keys });
    expect(await a.engine.refusedNames()).toEqual([]);
    expect(Object.keys(await a.files())).toContain("later.md");
    expect((await a.journal.load()).cursor.seq).toBe(server.currentHeadSeq);
    expect(server.liveFiles().get("new.md")).toBe("a new note\n");
    await laterEditsSync(server, a, b);
  });

  it("vault converted in place before the restart: the plaintext commit's retry is the same commit", async () => {
    const server = new InMemoryServer({ vaultId: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e" });
    // Both devices' options, which unlocking them after the conversion gives the vault's keys.
    const options: Partial<SyncEngineOptions> = {};
    const keys = new TestKeyring(server);
    const { a, b } = await lostReplyThenRestart(server, options, (b) => {
      keys.rotate();
      const first = keys.epochKey(1);
      if (first === undefined) throw new Error("no epoch 1 key");
      server.convert((path) => pathKey(deriveSubkey(first, "path_key_secret"), path));
      server.reader = (revision, blob) => keys.reveal(revision, blob);
      options.keys = keys;
      b.restart();
    });
    expect(await a.engine.refusedNames()).toEqual([]);
    expect(Object.keys(await a.files())).toContain("later.md");
    expect((await a.journal.load()).cursor.seq).toBe(server.currentHeadSeq);
    expect(server.liveFiles().get("new.md")).toBe("a new note\n");
    await laterEditsSync(server, a, b);
  });
});
