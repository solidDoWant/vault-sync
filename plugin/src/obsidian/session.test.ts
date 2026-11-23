import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProtocolClient } from "../core/protocol/client";
import type { RealtimeTimers } from "../core/realtime/client";
import { InMemoryRealtimeServer } from "../core/realtime/memory";
import { LogVerificationError } from "../core/keys/verified-log";
import type { VaultKeyring } from "../core/sync/codec";
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
    userName: "Alice",
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

  it("stops syncing an encrypted vault whose key data doesn't verify, keeps its files, and says why", async () => {
    const server = new InMemoryServer({ encrypted: true });
    server.currentEpoch = 1;
    const refused = new LogVerificationError(server.vaultId, "the membership log is shorter than this device has verified");
    let refreshes = 0;
    const keys: VaultKeyring = {
      refresh: () => {
        refreshes++;
        return Promise.reject(refused);
      },
      epochKey: () => undefined,
      conversionSeq: () => 0n,
    };
    const { session, vault, statuses } = setup({ keys }, server);
    await vault.write("a.md", encoder.encode("kept"));

    await session.start();

    const stopped = await statusBecomes(statuses, "verification-failed");
    expect(stopped?.message).toBe(refused.message);
    await session.syncNow();
    expect(refreshes).toBe(1);
    expect(await files(vault)).toEqual({ "a.md": "kept" });
    expect(server.liveFiles()).toEqual(new Map());
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
    expect(conflicts).toEqual([{ copy: expect.stringMatching(/^a \(Conflicted copy Alice phone \d{12}\)\.md$/u) as string, original: "a.md", createdAt: expect.any(Number) as number }]);
    expect((await statusBecomes(statuses, "idle"))?.conflicts).toBe(1);
    await vault.delete(conflicts[0]?.copy ?? "");
    expect((await session.listProblems()).conflicts).toEqual([]);
    await session.stop();
  });

  it("lists a local file moved aside for a remote note at its path, with that note as the one kept in place", async () => {
    const server = new InMemoryServer();
    server.commit({ documentId: "remote", path: "a.md", content: "remote\n" });
    const { session, vault } = setup({}, server);
    await vault.write("a.md", encoder.encode("local\n"));

    await session.start();

    const { conflicts } = await session.listProblems();
    expect(conflicts).toEqual([{ copy: expect.stringMatching(/^a \(Conflicted copy Alice phone \d{12}\)\.md$/u) as string, original: "a.md", createdAt: expect.any(Number) as number }]);
    expect(await files(vault)).toEqual({ "a.md": "remote\n", [conflicts[0]?.copy ?? ""]: "local\n" });
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

  it("pushes a local change waiting for its debounce when the app goes to the background", async () => {
    const { session, vault, server } = setup({ pushDebounceMs: 3_600_000 });
    await session.start();
    await vault.write("a.md", encoder.encode("typed just before switching apps"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.liveFiles()).toEqual(new Map());

    session.background();

    await vi.waitFor(() => {
      expect(server.liveFiles()).toEqual(new Map([["a.md", "typed just before switching apps"]]));
    });
    await session.stop();
  });

  it("reconnects the realtime channel that dropped in the background and pulls at once when the app comes back", async () => {
    const server = new InMemoryServer();
    const realtime = new InMemoryRealtimeServer({ headSeq: () => server.currentHeadSeq });
    const { session, vault } = setup(
      { realtime: { connect: realtime.connect, accessToken: () => Promise.resolve("token"), timers: idleTimers, random: () => 0.5, log: () => undefined } },
      server,
    );
    await session.start();
    await vi.waitFor(() => {
      expect(realtime.open).toHaveLength(1);
    });
    // Frozen: the connection drops, and the reconnect and fallback timers never fire.
    realtime.closeAll(1006);
    server.commit({ documentId: "from-a", path: "from-a.md", content: "written on the laptop" });

    session.foreground();

    await vi.waitFor(async () => {
      expect(await files(vault)).toEqual({ "from-a.md": "written on the laptop" });
      expect(realtime.open).toHaveLength(1);
    });
    await session.stop();
  });
});

describe("SyncSession while offline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the session's pending promises run without moving the fake clock. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 20; round++) await vi.advanceTimersByTimeAsync(0);
  }

  function unreachable(): { server: InMemoryServer; reachable: () => void } {
    const server = new InMemoryServer();
    let down = true;
    server.interceptor = () => {
      if (down) throw new ConnectError("connection refused", Code.Unavailable);
    };
    return {
      server,
      reachable: () => {
        down = false;
      },
    };
  }

  it("says when the next attempt is, and shows reconnecting while each retry runs", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { server } = unreachable();
    const { session, statuses } = setup({ syncIntervalMs: 60_000 }, server);

    await session.start();
    await settle();

    // The first attempt is a plain sync; it fails, and the engine's first retry waits 0.5 to 1 second.
    expect(statuses.map((status) => status.state)).toEqual(["syncing", "offline"]);
    const first = statuses.at(-1)?.nextAttemptAt ?? 0;
    expect(first).toBeGreaterThanOrEqual(1_000_500);
    expect(first).toBeLessThanOrEqual(1_001_000);

    statuses.length = 0;
    await vi.advanceTimersByTimeAsync(first - Date.now());
    await settle();

    expect(statuses.map((status) => status.state)).toEqual(["reconnecting", "offline"]);
    // The second retry waits 1 to 2 seconds after the failed one.
    const second = statuses.at(-1)?.nextAttemptAt ?? 0;
    expect(second).toBeGreaterThanOrEqual(first + 1_000);
    expect(second).toBeLessThanOrEqual(first + 2_000);
    await session.stop();
  });

  it("names the fallback timer as the next attempt when it comes before the retry", async () => {
    vi.useFakeTimers({ now: 0 });
    const { server } = unreachable();
    const { session, statuses } = setup({ syncIntervalMs: 300 }, server);

    await session.start();
    await settle();

    expect(statuses.at(-1)).toMatchObject({ state: "offline", nextAttemptAt: 300 });
    await session.stop();
  });

  it("moves the next attempt up when a local change while offline schedules a sync sooner", async () => {
    vi.useFakeTimers({ now: 0 });
    const { server } = unreachable();
    const { session, vault, statuses } = setup({ pushDebounceMs: 100 }, server);
    await session.start();
    await settle();
    expect(statuses.at(-1)?.nextAttemptAt ?? 0).toBeGreaterThanOrEqual(500);

    await vi.advanceTimersByTimeAsync(10);
    await vault.write("a.md", encoder.encode("offline edit"));
    await settle();

    expect(statuses.at(-1)).toMatchObject({ state: "offline", nextAttemptAt: 110 });
    await session.stop();
  });

  it("shows reconnecting for a manual sync while offline, and idle once the server answers", async () => {
    vi.useFakeTimers({ now: 0 });
    const { server, reachable } = unreachable();
    const { session, statuses } = setup({}, server);
    await session.start();
    await settle();
    expect(statuses.at(-1)?.state).toBe("offline");

    statuses.length = 0;
    reachable();
    await session.syncNow();
    await settle();

    expect(statuses.map((status) => status.state)).toEqual(["reconnecting", "idle"]);
    expect(statuses.at(-1)).toEqual({ state: "idle", pending: 0, conflicts: 0 });
    await session.stop();
  });

  it("shows syncing, not reconnecting, for a sync after an error that is not offline", async () => {
    vi.useFakeTimers({ now: 0 });
    const server = new InMemoryServer();
    let failing = true;
    server.interceptor = () => {
      if (failing) throw new ConnectError("no", Code.Internal);
    };
    const { session, statuses } = setup({}, server);
    await session.start();
    await settle();
    expect(statuses.at(-1)?.state).toBe("error");
    expect(statuses.at(-1)?.nextAttemptAt).toBeUndefined();

    statuses.length = 0;
    failing = false;
    await session.syncNow();
    await settle();
    expect(statuses.map((status) => status.state)).toEqual(["syncing", "idle"]);
    await session.stop();
  });
});
