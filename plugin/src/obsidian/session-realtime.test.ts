import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryServer } from "../core/engine/memory-server";
import { files } from "../core/engine/testing";
import { InMemoryJournal } from "../core/journal/memory";
import { createProtocolClient } from "../core/protocol/client";
import type { RealtimeTimers } from "../core/realtime/client";
import { InMemoryRealtimeServer } from "../core/realtime/memory";
import { InMemoryVault } from "../core/vault/memory";
import { SyncSession, type SessionStatus, type SyncSessionOptions } from "./session";

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
  // Like the real hub, subscribed reports the vault's head.
  const realtime = new InMemoryRealtimeServer({ headSeq: () => server.currentHeadSeq });
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

/**
 * Lets every queued microtask run: the in-memory server, journal, vault and
 * realtime hub use no timers, so everything they started has settled by the
 * next macrotask.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

  describe("given its own commit's notification", () => {
    /** A started, subscribed, idle session, and what it does from the returned point on. */
    async function idleSession() {
      const statuses: SessionStatus["state"][] = [];
      const devices = setup({
        onStatus: (status) => {
          statuses.push(status.state);
        },
      });
      const { server, realtime, session } = devices;
      await session.start();
      await vi.waitFor(() => {
        expect([...(realtime.open[0]?.subscriptions ?? [])]).toEqual([server.vaultId]);
        expect(statuses.at(-1)).toBe("idle");
      });
      const calls: string[] = [];
      server.interceptor = (method) => {
        calls.push(method);
      };
      return { ...devices, statuses, calls };
    }

    it("does not pull, and the status stays idle", async () => {
      const { server, realtime, vault, session, statuses, calls } = await idleSession();
      await vault.write("mine.md", new TextEncoder().encode("written here"));
      await session.syncNow();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toBe("idle");
      });
      expect(server.currentHeadSeq).toBe(1n);
      calls.length = 0;
      statuses.length = 0;

      realtime.notify(server.vaultId, server.currentHeadSeq);
      await flush();
      const afterOwn = [...statuses];
      // A later commit by another device: its notification is handled only
      // after the first one's (they never overlap), so once its file is here
      // the first notification has been fully handled.
      const theirs = server.commit({ documentId: "theirs", path: "theirs.md", content: "from the laptop" });
      realtime.notify(server.vaultId, theirs.seq);
      await vi.waitFor(async () => {
        expect((await files(vault)).get("theirs.md")).toBe("from the laptop");
        expect(statuses.at(-1)).toBe("idle");
      });

      // Only the second notification pulled; the first reported no status at all (never "syncing").
      expect(calls.filter((method) => method === "ListChanges")).toEqual(["ListChanges"]);
      expect(afterOwn).toEqual([]);
      await session.stop();
    });

    it("does not pull after the push when the notification arrives before the commit's response is handled", async () => {
      const { server, realtime, vault, session, statuses, calls } = await idleSession();
      server.responseInterceptor = (method, _request, response) => {
        if (method !== "CommitRevision") return;
        const seq = (response as { revision?: { seq: bigint } }).revision?.seq ?? 0n;
        realtime.notify(server.vaultId, seq);
      };
      await vault.write("mine.md", new TextEncoder().encode("written here"));

      await session.syncNow();
      await flush();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toBe("idle");
      });

      // The push's own pull, then its commit; nothing after the commit.
      expect(calls.filter((method) => method === "ListChanges" || method === "CommitRevision")).toEqual(["ListChanges", "CommitRevision"]);
      await session.stop();
    });

    it("still pulls another device's commit that landed just before its own", async () => {
      const { server, realtime, vault, session } = await idleSession();
      let moved = false;
      server.interceptor = (method) => {
        if (method === "CommitRevision" && !moved) {
          moved = true;
          server.commit({ documentId: "theirs", path: "theirs.md", content: "committed in between" });
        }
      };
      await vault.write("mine.md", new TextEncoder().encode("written here"));
      await session.syncNow();
      expect(await vault.stat("theirs.md")).toBeNull();

      // The server coalesces the two notifications into the newest seq: the device's own.
      realtime.notify(server.vaultId, server.currentHeadSeq);
      await vi.waitFor(async () => {
        expect(await files(vault)).toEqual(
          new Map([
            ["mine.md", "written here"],
            ["theirs.md", "committed in between"],
          ]),
        );
      });
      await session.stop();
    });
  });

  describe("given a subscribe that completes only after the startup sync", () => {
    /** A session whose startup pull and push are done (idle) while its subscribe is held back, and what it does from the returned point on. */
    async function startedBeforeSubscribed(before: (vault: InMemoryVault) => Promise<void> = () => Promise.resolve()) {
      const statuses: SessionStatus["state"][] = [];
      const devices = setup({
        onStatus: (status) => {
          statuses.push(status.state);
        },
      });
      const { server, realtime, vault, session } = devices;
      realtime.holdSubscribes = true;
      await before(vault);
      await session.start();
      await vi.waitFor(() => {
        expect(realtime.heldSubscribes).toBe(1);
        expect(statuses.at(-1)).toBe("idle");
      });
      await settle();
      const calls: string[] = [];
      server.interceptor = (method) => {
        calls.push(method);
      };
      statuses.length = 0;
      return { ...devices, statuses, calls };
    }

    it("does not pull when the subscribed head is the cursor, and the status stays idle", async () => {
      const { server, realtime, session, statuses, calls } = await startedBeforeSubscribed((vault) => vault.write("mine.md", new TextEncoder().encode("written before the start")));
      // The startup push committed the file: the head is the device's own commit.
      expect(server.currentHeadSeq).toBe(1n);
      expect(server.liveFiles()).toEqual(new Map([["mine.md", "written before the start"]]));

      realtime.releaseSubscribes();
      await settle();

      expect([...(realtime.open[0]?.subscriptions ?? [])]).toEqual([server.vaultId]);
      expect(realtime.open[0]?.sent.map((frame) => frame.frame.case)).toEqual(["subscribed"]);
      expect(calls).toEqual([]);
      expect(statuses).toEqual([]);
      await session.stop();
    });

    it("pulls when the subscribed head is above the cursor", async () => {
      const { server, realtime, vault, session, calls } = await startedBeforeSubscribed();
      // Committed by another device after the startup pull, before the subscription: no notification.
      server.commit({ documentId: "theirs", path: "theirs.md", content: "committed before the subscription" });

      realtime.releaseSubscribes();
      await vi.waitFor(async () => {
        expect(await files(vault)).toEqual(new Map([["theirs.md", "committed before the subscription"]]));
      });
      expect(calls).toContain("ListChanges");
      await session.stop();
    });
  });

  describe.each([
    { state: "offline", error: () => new ConnectError("network error: net::ERR_INTERNET_DISCONNECTED", Code.Unavailable) },
    { state: "error", error: () => new ConnectError("server exploded", Code.Internal) },
  ])("given an earlier $state status", ({ state, error }) => {
    it("keeps it when a notification needs no pull", async () => {
      const statuses: SessionStatus["state"][] = [];
      const { server, realtime, vault, session } = setup({
        onStatus: (status) => {
          statuses.push(status.state);
        },
      });
      await session.start();
      await vi.waitFor(() => {
        expect([...(realtime.open[0]?.subscriptions ?? [])]).toEqual([server.vaultId]);
        expect(statuses.at(-1)).toBe("idle");
      });
      await vault.write("mine.md", new TextEncoder().encode("written here"));
      await session.syncNow();
      expect(server.currentHeadSeq).toBe(1n);
      server.interceptor = (method) => {
        if (method === "ListChanges") throw error();
      };
      await session.syncNow();
      await settle();
      expect(statuses.at(-1)).toBe(state);
      statuses.length = 0;

      // At the cursor: nothing to pull, and nothing learned about the server.
      realtime.notify(server.vaultId, server.currentHeadSeq);
      await settle();

      expect(statuses).toEqual([]);
      await session.stop();
    });
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
