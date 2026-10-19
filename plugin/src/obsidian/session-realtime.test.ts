import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryServer } from "../core/engine/memory-server";
import { files } from "../core/engine/testing";
import { InMemoryJournal } from "../core/journal/memory";
import { createProtocolClient } from "../core/protocol/client";
import type { RealtimeTimers } from "../core/realtime/client";
import { InMemoryRealtimeServer } from "../core/realtime/memory";
import { InMemoryVault } from "../core/vault/memory";
import { SyncSession, type SyncSessionOptions } from "./session";

// The session over the realtime channel (SPEC.md §6.4): a change another
// device commits arrives on a notification, without the pull timer, and the
// pull timer still syncs while the channel is down.

afterEach(() => {
  vi.useRealTimers();
});

/** Reconnect timers that fire only when the test says so. */
class ManualTimers implements RealtimeTimers {
  readonly pending: (() => void)[] = [];

  setTimeout(callback: () => void): unknown {
    this.pending.push(callback);
    return callback;
  }

  clearTimeout(handle: unknown): void {
    const index = this.pending.indexOf(handle as () => void);
    if (index >= 0) this.pending.splice(index, 1);
  }

  fireAll(): void {
    for (const callback of this.pending.splice(0)) callback();
  }
}

function setup(options: Partial<SyncSessionOptions> & { tokens?: () => Promise<string>; invalidate?: (token: string) => void } = {}) {
  const server = new InMemoryServer();
  const realtime = new InMemoryRealtimeServer();
  const vault = new InMemoryVault();
  const timers = new ManualTimers();
  const { tokens, invalidate, ...sessionOptions } = options;
  const session = new SyncSession({
    vaultId: server.vaultId,
    deviceId: "device-b",
    deviceName: "phone",
    api: createProtocolClient({ transport: server.transport }),
    journal: new InMemoryJournal(),
    vault,
    pushDebounceMs: null,
    syncIntervalMs: null,
    realtime: {
      connect: realtime.connect,
      accessToken: tokens ?? (() => Promise.resolve("token-1")),
      ...(invalidate === undefined ? {} : { invalidate }),
      timers,
      random: () => 0.5,
      log: () => undefined,
    },
    ...sessionOptions,
  });
  return { server, realtime, vault, timers, session };
}

/** Lets queued promises, microtasks and the in-memory server's calls run. */
const flush = async () => {
  for (let round = 0; round < 20; round++) await Promise.resolve();
};

describe("SyncSession with the realtime channel", () => {
  it("pulls another device's commit as soon as it is notified, with no pull timer", async () => {
    const { server, realtime, vault, session } = setup();
    await session.start();
    await vi.waitFor(() => {
      expect([...(realtime.open[0]?.subscriptions ?? [])]).toEqual([server.vaultId]);
    });

    const revision = server.commit({ documentId: "from-a", path: "from-a.md", content: "written on the laptop" });
    await flush();
    // Nothing pulls by itself: the timer is off.
    expect(await vault.stat("from-a.md")).toBeNull();

    realtime.notify(server.vaultId, revision.seq);
    await vi.waitFor(async () => {
      expect(await files(vault)).toEqual(new Map([["from-a.md", "written on the laptop"]]));
    });
    await session.stop();
  });

  it("reconnects with a fresh token after expiry and pulls what was committed while it was disconnected", async () => {
    const invalidated: string[] = [];
    const { server, realtime, vault, timers, session } = setup({
      tokens: () => Promise.resolve(`token-${String(invalidated.length + 1)}`),
      invalidate: (token) => {
        invalidated.push(token);
      },
    });
    await session.start();
    await vi.waitFor(() => {
      expect(realtime.open).toHaveLength(1);
    });
    const [first] = realtime.open;
    if (first !== undefined) realtime.expire(first);
    await flush();
    expect(invalidated).toEqual(["token-1"]);

    // No one is subscribed: this commit's notification reaches nobody.
    server.commit({ documentId: "missed", path: "missed.md", content: "committed during the reconnect" });
    realtime.notify(server.vaultId, 1n);
    timers.fireAll();

    await vi.waitFor(async () => {
      expect(await files(vault)).toEqual(new Map([["missed.md", "committed during the reconnect"]]));
    });
    expect(realtime.open.map((connection) => connection.token)).toEqual(["token-2"]);
    await session.stop();
  });

  it("keeps syncing through the pull timer while the realtime channel is refused", async () => {
    vi.useFakeTimers();
    const { server, realtime, vault, timers, session } = setup({ syncIntervalMs: 30_000 });
    realtime.refuseWith = 503;
    await session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(realtime.open).toEqual([]);
    expect(timers.pending).toHaveLength(1);

    server.commit({ documentId: "from-a", path: "from-a.md", content: "arrives by the timer" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await vault.stat("from-a.md")).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => {
      expect(await files(vault)).toEqual(new Map([["from-a.md", "arrives by the timer"]]));
    });
    await session.stop();
  });

  it("closes the channel when stopped, and does not reconnect", async () => {
    const { realtime, timers, session } = setup();
    await session.start();
    await vi.waitFor(() => {
      expect(realtime.open).toHaveLength(1);
    });

    await session.stop();
    await flush();
    expect(realtime.open).toEqual([]);
    expect(timers.pending).toEqual([]);
  });

  it("opens no channel when stopped before it started", async () => {
    const { realtime, session } = setup();
    const started = session.start();
    await session.stop();
    await started;
    await flush();
    expect(realtime.connections).toEqual([]);
  });
});
