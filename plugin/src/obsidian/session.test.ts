import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import { createProtocolClient } from "../core/protocol/client";
import type { RealtimeTimers } from "../core/realtime/client";
import { InMemoryRealtimeServer } from "../core/realtime/memory";
import { MemorySyncJournal } from "../core/sync/journal";
import { InMemoryServer } from "../core/sync/memory-server";
import { InMemoryVault } from "../core/vault/memory";
import { SyncSession, type SessionStatus, type SyncSessionOptions } from "./session";

// The session over the sync engine (docs/design/engine.md): it starts once
// the vault is ready, syncs both ways, reports its status, lists what the
// conflict view shows, offers history and restore, and leaves the vault,
// the journal and the server alone once stopped.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Reconnect timers that never fire. */
const idleTimers: RealtimeTimers = { setTimeout: () => 0, clearTimeout: () => undefined };

function setup(options: Partial<SyncSessionOptions> = {}, server = new InMemoryServer(), journal = new MemorySyncJournal(), vault = new InMemoryVault()) {
  const statuses: SessionStatus[] = [];
  const session = new SyncSession({
    vaultId: server.vaultId,
    deviceId: "device-b",
    deviceName: "phone",
    api: createProtocolClient({ transport: server.transport }),
    journal,
    vault,
    pushDebounceMs: null,
    syncIntervalMs: null,
    onStatus: (status) => {
      statuses.push(status);
    },
    ...options,
  });
  return { server, journal, vault, session, statuses };
}

async function files(vault: InMemoryVault): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of (await vault.list()).sort()) result[path] = decoder.decode(await vault.read(path));
  return result;
}

async function statusBecomes(statuses: SessionStatus[], state: SessionStatus["state"]): Promise<SessionStatus | undefined> {
  await vi.waitFor(() => {
    expect(statuses.at(-1)?.state).toBe(state);
  });
  return statuses.at(-1);
}

describe("SyncSession", () => {
  it("waits for the vault to be ready, then pulls remote files and pushes local ones", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "remote", path: "remote.md", content: "from the laptop" });
    let ready: () => void = () => undefined;
    const { session, vault, statuses } = setup({ ready: () => new Promise<void>((resolve) => (ready = resolve)) }, server);
    await vault.write("local.md", encoder.encode("from the phone"));

    const started = session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.liveFiles()).toEqual(new Map([["remote.md", "from the laptop"]]));
    ready();
    await started;

    expect(await files(vault)).toEqual({ "local.md": "from the phone", "remote.md": "from the laptop" });
    expect(server.liveFiles()).toEqual(
      new Map([
        ["local.md", "from the phone"],
        ["remote.md", "from the laptop"],
      ]),
    );
    expect(await statusBecomes(statuses, "idle")).toEqual({ state: "idle", pending: 0, conflicts: 0 });
    await session.stop();
  });

  it("shows offline while the server is unreachable, keeps the local change pending, and pushes it once the server is back", async () => {
    const server = new InMemoryServer();
    let down = true;
    server.interceptor = () => {
      if (down) throw new ConnectError("connection refused", Code.Unavailable);
    };
    const { session, vault, statuses } = setup({}, server);
    await vault.write("a.md", encoder.encode("offline edit"));

    await session.start();

    const offline = await statusBecomes(statuses, "offline");
    expect(offline?.pending).toBe(1);
    down = false;
    await session.syncNow();
    expect(await statusBecomes(statuses, "idle")).toEqual({ state: "idle", pending: 0, conflicts: 0 });
    expect(server.liveFiles()).toEqual(new Map([["a.md", "offline edit"]]));
    await session.stop();
  });

  it("calls neither the server nor the vault once stopped, and a new session over the same journal resumes", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "remote", path: "remote.md", content: "one" });
    const first = setup({}, server);
    await first.session.start();
    await first.session.stop();
    const calls: string[] = [];
    server.interceptor = (method) => {
      calls.push(method);
    };

    await first.session.syncNow();
    expect(calls).toEqual([]);

    const second = setup({}, server, first.journal, first.vault);
    await second.session.start();
    // Resumed from the journal's cursor: nothing is downloaded again.
    expect(calls).not.toContain("DownloadBlob");
    expect(await files(second.vault)).toEqual({ "remote.md": "one" });
    await second.session.stop();
  });

  it("lists a conflict copy with the note it was taken from, and counts it in the status", async () => {
    const server = new InMemoryServer();
    const { session, vault, statuses } = setup({}, server);
    await vault.write("a.md", encoder.encode("one\n"));
    await session.start();
    server.commit({ documentId: server.liveDocuments().get("a.md") ?? "", path: "a.md", content: "remote\n" });
    await vault.write("a.md", encoder.encode("local\n"));

    await session.syncNow();

    const { conflicts } = await session.listProblems();
    expect(conflicts).toEqual([{ copy: expect.stringMatching(/^a \(Conflicted copy phone \d{12}\)\.md$/u) as string, original: "a.md", createdAt: expect.any(Number) as number }]);
    expect((await statusBecomes(statuses, "idle"))?.conflicts).toBe(1);
    await vault.delete(conflicts[0]?.copy ?? "");
    expect((await session.listProblems()).conflicts).toEqual([]);
    await session.stop();
  });

  it("lists a local file whose name the server refuses, with the reason, and says so in the status", async () => {
    const { session, vault, statuses } = setup();
    await vault.write("a?b.md", encoder.encode("text"));
    await vault.write("ok.md", encoder.encode("text"));

    await session.start();

    const { refused } = await session.listProblems();
    expect(refused.map(({ path }) => path)).toEqual(["a?b.md"]);
    expect((await statusBecomes(statuses, "error"))?.message).toMatch(/Cannot sync "a\?b\.md"/);
    await session.stop();
  });

  it("restores an old version of a note, which becomes the newest version here", async () => {
    const { session, vault, server } = setup();
    await vault.write("a.md", encoder.encode("first"));
    await session.start();
    await vault.write("a.md", encoder.encode("second"));
    await session.syncNow();
    const history = session.history();
    if (history === undefined) throw new Error("no history while the session runs");

    const documentId = await history.documentAt("a.md");
    if (documentId === undefined) throw new Error("a.md is not synced");
    const page = await history.history(documentId);
    const first = page.entries.find((entry) => entry.size === 5n);
    if (first === undefined) throw new Error("no first version");
    expect(decoder.decode(await history.readRevision(first))).toBe("first");
    await history.restore(first);

    await vi.waitFor(async () => {
      expect(await files(vault)).toEqual({ "a.md": "first" });
    });
    expect(server.liveFiles()).toEqual(new Map([["a.md", "first"]]));
    await session.stop();
  });

  it("pulls another device's commit when the realtime channel reports it", async () => {
    const server = new InMemoryServer();
    const realtime = new InMemoryRealtimeServer({ headSeq: () => server.currentHeadSeq });
    const { session, vault } = setup(
      { realtime: { connect: realtime.connect, accessToken: () => Promise.resolve("token"), timers: idleTimers, random: () => 0.5, log: () => undefined } },
      server,
    );
    await session.start();
    await vi.waitFor(() => {
      expect([...(realtime.open[0]?.subscriptions ?? [])]).toEqual([server.vaultId]);
    });

    const revision = server.commit({ documentId: "from-a", path: "from-a.md", content: "written on the laptop" });
    realtime.notify(server.vaultId, revision.seq);

    await vi.waitFor(async () => {
      expect(await files(vault)).toEqual({ "from-a.md": "written on the laptop" });
    });
    await session.stop();
  });
});
