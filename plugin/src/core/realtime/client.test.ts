import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, ServerFrameSchema } from "../../gen/vaultsync/v1/realtime_pb";
import { TokenManager } from "../auth/tokens";
import { bearerSubprotocolPrefix, RealtimeClient, realtimeUrl, reconnectDelay, type RealtimeClientOptions, type RealtimeTimers } from "./client";
import { InMemoryRealtimeServer } from "./memory";

const vaultId = "vault-1";

/** Timers that fire only when the test says so, recording each delay asked for. */
class ManualTimers implements RealtimeTimers {
  private next = 0;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  readonly delays: number[] = [];

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.next;
    this.pending.set(id, { callback, ms });
    this.delays.push(ms);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fires the one scheduled timer. */
  fire(): void {
    expect(this.pending.size).toBe(1);
    const [id, timer] = [...this.pending][0] ?? [];
    if (id === undefined || timer === undefined) return;
    this.pending.delete(id);
    timer.callback();
  }
}

/** Lets every queued promise and microtask run (socket events are delivered as microtasks). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Setup {
  server?: InMemoryRealtimeServer;
  options?: Partial<RealtimeClientOptions>;
}

function setup({ server = new InMemoryRealtimeServer(), options = {} }: Setup = {}) {
  const timers = new ManualTimers();
  const logs: string[] = [];
  let pulls = 0;
  const client = new RealtimeClient({
    vaultId,
    connect: server.connect,
    accessToken: () => Promise.resolve("token-1"),
    onChange: () => {
      pulls++;
      return Promise.resolve();
    },
    timers,
    random: () => 0.5,
    log: (message) => logs.push(message),
    ...options,
  });
  return { server, client, timers, logs, pulls: () => pulls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RealtimeClient", () => {
  describe("connecting", () => {
    it("offers vaultsync.v1 and the token as the bearer subprotocol, subscribes to the vault, and pulls once subscribed", async () => {
      const { server, client, pulls } = setup();

      client.start();
      await flush();

      expect(server.connections).toHaveLength(1);
      const [connection] = server.connections;
      expect(connection?.protocols).toEqual(["vaultsync.v1", "vaultsync.bearer.token-1"]);
      expect([...(connection?.subscriptions ?? [])]).toEqual([vaultId]);
      expect(connection?.sent.map((frame) => frame.frame.case)).toEqual(["subscribed"]);
      // Notifications before the subscription are not replayed: the client pulls from its cursor.
      expect(pulls()).toBe(1);
    });

    it("names the endpoint by the server URL alone, so the token can never be in it", () => {
      expect(realtimeUrl("https://sync.example.com")).toBe("wss://sync.example.com/v1/realtime");
      expect(realtimeUrl("http://127.0.0.1:8080/")).toBe("ws://127.0.0.1:8080/v1/realtime");
      expect(realtimeUrl("https://example.com/vault-sync")).toBe("wss://example.com/vault-sync/v1/realtime");
      expect(() => realtimeUrl("ftp://example.com")).toThrow(/http: or https:/);
    });
  });

  describe("notifications", () => {
    it("pulls on vault_changed for its vault and ignores other vaults' notifications", async () => {
      const { server, client, pulls } = setup();
      client.start();
      await flush();
      expect(pulls()).toBe(1);

      server.notify(vaultId, 7n);
      await flush();
      expect(pulls()).toBe(2);

      server.notify("another-vault", 8n);
      const [connection] = server.connections;
      connection?.send(create(ServerFrameSchema, { frame: { case: "vaultChanged", value: { vaultId: "another-vault", seq: 9n } } }));
      await flush();
      expect(pulls()).toBe(2);
    });

    it("runs one pull at a time, and one more after it for every burst of notifications that arrived during it", async () => {
      const server = new InMemoryRealtimeServer();
      const releases: (() => void)[] = [];
      const { client } = setup({
        server,
        options: {
          onChange: () =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
            }),
        },
      });
      client.start();
      await flush();
      expect(releases).toHaveLength(1);

      server.notify(vaultId, 1n);
      server.notify(vaultId, 2n);
      server.notify(vaultId, 3n);
      await flush();
      expect(releases).toHaveLength(1);

      releases[0]?.();
      await flush();
      expect(releases).toHaveLength(2);
      releases[1]?.();
      await flush();
      expect(releases).toHaveLength(2);
    });

    it("tells the caller the highest head announced, by a subscribe or a notification", async () => {
      const server = new InMemoryRealtimeServer({ headSeq: () => 4n });
      const calls: bigint[] = [];
      const releases: (() => void)[] = [];
      const { client } = setup({
        server,
        options: {
          onChange: (seq) => {
            calls.push(seq);
            return new Promise<void>((resolve) => {
              releases.push(resolve);
            });
          },
        },
      });
      client.start();
      await flush();
      // After subscribed: the head the subscription started at.
      expect(calls).toEqual([4n]);

      // Coalesced during the running pull, whatever their order: the highest one.
      server.notify(vaultId, 6n);
      server.notify(vaultId, 9n);
      server.notify(vaultId, 7n);
      await flush();
      releases[0]?.();
      await flush();
      expect(calls).toEqual([4n, 9n]);

      // A subscribe coalesced with notifications: the highest of all of them.
      server.notify(vaultId, 10n);
      server.connections[0]?.send(create(ServerFrameSchema, { frame: { case: "subscribed", value: { vaultId, headSeq: 12n } } }));
      server.notify(vaultId, 11n);
      await flush();
      releases[1]?.();
      await flush();
      expect(calls).toEqual([4n, 9n, 12n]);

      // Nothing carries over from a coalesced batch into the next one.
      releases[2]?.();
      await flush();
      server.notify(vaultId, 3n);
      await flush();
      expect(calls).toEqual([4n, 9n, 12n, 3n]);
    });

    it("keeps pulling on notifications after a pull failed", async () => {
      let pulls = 0;
      const { server, client } = setup({
        options: {
          onChange: () => {
            pulls++;
            return Promise.reject(new Error("offline"));
          },
        },
      });
      client.start();
      await flush();
      server.notify(vaultId, 1n);
      await flush();
      expect(pulls).toBe(2);
    });

    it("ignores frames it does not understand", async () => {
      const { server, client, pulls, logs } = setup();
      client.start();
      await flush();
      const [connection] = server.connections;
      connection?.send(create(ServerFrameSchema, {}));
      await flush();
      expect(pulls()).toBe(1);
      expect(connection?.open).toBe(true);
      expect(logs).toEqual([]);
    });
  });

  describe("token expiry", () => {
    it("gets a fresh token from the token manager, reconnects, re-subscribes and pulls from its cursor", async () => {
      let refreshes = 0;
      const now = 1_000_000;
      const tokens = new TokenManager({
        refreshToken: "refresh",
        refresh: () => {
          refreshes++;
          // Valid for an hour as far as the device's clock knows: only the server's refusal makes it refresh.
          return Promise.resolve({ accessToken: `token-${String(refreshes)}`, refreshToken: "refresh", obtainedAt: now, expiresAt: now + 3_600_000 });
        },
        persist: () => Promise.resolve(),
        now: () => now,
      });
      const { server, client, timers, pulls } = setup({
        options: {
          accessToken: () => tokens.accessToken(),
          invalidate: (token) => {
            tokens.invalidate(token);
          },
        },
      });
      client.start();
      await flush();
      expect(server.connections[0]?.token).toBe("token-1");
      expect(pulls()).toBe(1);

      const [first] = server.connections;
      if (first !== undefined) server.expire(first);
      await flush();
      expect(server.open).toEqual([]);
      timers.fire();
      await flush();

      expect(refreshes).toBe(2);
      expect(server.connections).toHaveLength(2);
      const second = server.connections[1];
      expect(second?.token).toBe("token-2");
      expect(second?.open).toBe(true);
      expect([...(second?.subscriptions ?? [])]).toEqual([vaultId]);
      // A change committed while it was reconnecting reached no notification; the pull finds it.
      expect(pulls()).toBe(2);
    });

    it("does not invalidate the token when the connection closes for another reason", async () => {
      const invalidated: string[] = [];
      const { server, client } = setup({ options: { invalidate: (token) => invalidated.push(token) } });
      client.start();
      await flush();
      server.closeAll(1008);
      server.closeAll(1001);
      await flush();
      expect(invalidated).toEqual([]);
    });
  });

  describe("reconnecting", () => {
    it.each([
      { name: "drain", code: 1001 },
      { name: "network drop", code: 1006 },
      { name: "rate limit", code: 1008 },
    ])("reconnects after a $name ($code) with a jittered delay, and pulls again once re-subscribed", async ({ code }) => {
      const { server, client, timers, pulls } = setup({ options: { random: () => 0.25 } });
      client.start();
      await flush();

      server.closeAll(code);
      await flush();
      // First failure: ceiling 1000 ms, half of it plus a quarter of the other half.
      expect(timers.delays).toEqual([625]);
      expect(server.connections).toHaveLength(1);

      timers.fire();
      await flush();
      expect(server.open).toHaveLength(1);
      expect(server.connections).toHaveLength(2);
      expect(pulls()).toBe(2);
    });

    it.each([429, 503] as const)("backs off exponentially, up to the bound, while upgrades are refused with %i", async (status) => {
      const server = new InMemoryRealtimeServer();
      server.refuseWith = status;
      const { client, timers } = setup({ server, options: { random: () => 1, backoff: { initialMs: 1000, maxMs: 10_000 } } });
      client.start();
      await flush();
      for (let attempt = 0; attempt < 6; attempt++) {
        timers.fire();
        await flush();
      }
      expect(timers.delays).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
      expect(server.connections).toHaveLength(7);
    });

    it("starts the backoff over once a subscription has stayed up for stableAfterMs", async () => {
      const server = new InMemoryRealtimeServer();
      server.refuseWith = 503;
      let now = 0;
      const { client, timers, pulls } = setup({ server, options: { random: () => 1, stableAfterMs: 30_000, now: () => now } });
      client.start();
      await flush();
      timers.fire();
      await flush();
      expect(timers.delays).toEqual([1000, 2000]);

      server.refuseWith = undefined;
      timers.fire();
      await flush();
      expect(pulls()).toBe(1);
      now += 30_000;
      server.closeAll(1001);
      await flush();
      expect(timers.delays).toEqual([1000, 2000, 1000]);
    });

    it("keeps growing the delay, up to the bound, when the server closes every connection right after subscribed (#413)", async () => {
      const server = new InMemoryRealtimeServer();
      let now = 0;
      const { client, timers, pulls } = setup({ server, options: { random: () => 1, backoff: { initialMs: 1000, maxMs: 10_000 }, stableAfterMs: 30_000, now: () => now } });
      client.start();
      for (let connection = 0; connection < 7; connection++) {
        await flush();
        expect(server.open).toHaveLength(1);
        // Up for just under the time that would start the backoff over.
        now += 29_999;
        server.closeAll(1001);
        await flush();
        timers.fire();
      }
      await flush();

      expect(pulls()).toBe(8);
      expect(timers.delays).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    });

    it("retries later when no access token can be had", async () => {
      let calls = 0;
      const { server, client, timers } = setup({
        options: {
          accessToken: () => (++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve("token-1")),
        },
      });
      client.start();
      await flush();
      expect(server.connections).toHaveLength(0);
      expect(timers.pending.size).toBe(1);
      timers.fire();
      await flush();
      expect(server.open).toHaveLength(1);
    });

    it("drops a subscription the server refused and tries again with backoff", async () => {
      const { server, client, timers } = setup();
      client.start();
      await flush();
      server.connections[0]?.send(
        create(ServerFrameSchema, { frame: { case: "error", value: { code: ErrorCode.NOT_FOUND, message: "vault not found", vaultId, fatal: false } } }),
      );
      await flush();
      expect(server.open).toEqual([]);
      expect(timers.pending.size).toBe(1);
    });
  });

  describe("reconnect delay", () => {
    const backoff = { initialMs: 1000, maxMs: 60_000 };

    it("never exceeds the bound, and is never below half the current ceiling", () => {
      // Ceilings 1, 2, 4, 8, 16, 32 s, then 60 s: 64 s would exceed the bound.
      expect(reconnectDelay(6, backoff, 1)).toBe(32_000);
      expect(reconnectDelay(7, backoff, 1)).toBe(60_000);
      expect(reconnectDelay(7, backoff, 0)).toBe(30_000);
      expect(reconnectDelay(1000, backoff, 1)).toBe(60_000);
      expect(reconnectDelay(1, backoff, 0)).toBe(500);
      expect(reconnectDelay(1, backoff, 1)).toBe(1000);
    });
  });

  describe("stopping", () => {
    it("closes the socket and neither reconnects nor pulls afterwards", async () => {
      const { server, client, timers, pulls } = setup();
      client.start();
      await flush();
      const [connection] = server.connections;

      client.stop();
      // Delivered before the close reaches the server: ignored.
      server.notify(vaultId, 1n);
      await flush();
      expect(connection?.closed).toBe(true);
      expect(pulls()).toBe(1);
      expect(timers.pending.size).toBe(0);
    });

    it("cancels a scheduled reconnect", async () => {
      const { server, client, timers } = setup();
      client.start();
      await flush();
      server.closeAll(1001);
      await flush();
      expect(timers.pending.size).toBe(1);
      client.stop();
      expect(timers.pending.size).toBe(0);
    });

    it("opens nothing when stopped while it waits for a token", async () => {
      let resolveToken: (token: string) => void = () => undefined;
      const { server, client } = setup({
        options: {
          accessToken: () =>
            new Promise<string>((resolve) => {
              resolveToken = resolve;
            }),
        },
      });
      client.start();
      client.stop();
      resolveToken("token-1");
      await flush();
      expect(server.connections).toHaveLength(0);
    });
  });

  describe("logging", () => {
    it("never logs the token, through its log or the console", async () => {
      const secret = "secret-access-token-value";
      const consoleOutput: unknown[][] = [];
      for (const method of ["log", "debug", "info", "warn", "error"] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          consoleOutput.push(args);
        });
      }
      const server = new InMemoryRealtimeServer();
      // The default log goes to the console.
      const timers = new ManualTimers();
      const client = new RealtimeClient({
        vaultId,
        connect: server.connect,
        accessToken: () => Promise.resolve(secret),
        invalidate: () => undefined,
        onChange: () => Promise.reject(new Error(`failed with ${bearerSubprotocolPrefix}${secret}`)),
        timers,
        random: () => 0.5,
      });
      client.start();
      await flush();
      const [connection] = server.connections;
      expect(connection?.token).toBe(secret);
      connection?.send(create(ServerFrameSchema, { frame: { case: "error", value: { code: ErrorCode.NOT_FOUND, vaultId, fatal: false } } }));
      await flush();
      timers.fire();
      await flush();
      const second = server.connections[1];
      if (second !== undefined) server.expire(second);
      await flush();
      timers.fire();
      await flush();
      server.refuseWith = 503;
      server.closeAll(1006);
      await flush();
      timers.fire();
      await flush();
      client.stop();

      expect(consoleOutput.length).toBeGreaterThan(0);
      expect(JSON.stringify(consoleOutput)).not.toContain(secret);
    });
  });
});
