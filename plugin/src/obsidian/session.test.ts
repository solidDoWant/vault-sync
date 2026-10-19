import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryServer } from "../core/engine/memory-server";
import { files } from "../core/engine/testing";
import type { Journal } from "../core/journal/journal";
import { InMemoryJournal } from "../core/journal/memory";
import { createProtocolClient } from "../core/protocol/client";
import { InMemoryVault } from "../core/vault/memory";
import { SyncSession, type SessionStatus, type SyncSessionOptions } from "./session";

const bytes = (value: string) => new TextEncoder().encode(value);

afterEach(() => {
  vi.useRealTimers();
});

/** A transport whose calls can be held: they then wait until released (or forever). */
function holdable(inner: Transport) {
  const held: (() => void)[] = [];
  let holding = false;
  const transport: Transport = {
    unary: async (...args) => {
      if (holding) await new Promise<void>((resolve) => held.push(resolve));
      return inner.unary(...args);
    },
    stream: (...args) => inner.stream(...args),
  };
  return {
    transport,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const resume of held.splice(0)) resume();
    },
    get heldCalls() {
      return held.length;
    },
  };
}

/** Counts the journal calls made through it. */
function countingJournal(inner: Journal): {
  journal: Journal;
  calls: () => number;
} {
  let calls = 0;
  const journal = new Proxy(inner, {
    get: (target, property, receiver) => {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls++;
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { journal, calls: () => calls };
}

interface Setup {
  server: InMemoryServer;
  vault: InMemoryVault;
  journal: Journal;
  transport?: Transport;
  statuses?: SessionStatus[];
  options?: Partial<SyncSessionOptions>;
}

function session({ server, vault, journal, transport, statuses, options }: Setup): SyncSession {
  return new SyncSession({
    vaultId: server.vaultId,
    deviceId: "device-1",
    deviceName: "laptop",
    api: createProtocolClient({ transport: transport ?? server.transport }),
    journal,
    vault,
    pushDebounceMs: null,
    syncIntervalMs: null,
    onStatus: (status) => statuses?.push(status),
    ...options,
  });
}

describe("SyncSession", () => {
  describe("on start", () => {
    it("pulls remote changes and pushes local ones, without waiting for an edit", async () => {
      const server = new InMemoryServer();
      server.commit({
        documentId: "remote",
        path: "remote.md",
        content: "from the server",
      });
      const vault = new InMemoryVault();
      await vault.write("local.md", bytes("written before sync started"));

      const summary = await session({
        server,
        vault,
        journal: new InMemoryJournal(),
      }).start();

      expect(summary).toMatchObject({ applied: 1 });
      expect(server.liveFiles()).toEqual(
        new Map([
          ["remote.md", "from the server"],
          ["local.md", "written before sync started"],
        ]),
      );
    });

    it("commits an operation an earlier session left pending", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const journal = new InMemoryJournal();
      server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("lost", Code.Unavailable);
      };
      const first = session({ server, vault, journal });
      await first.start();
      await vault.write("a.md", bytes("edit"));
      await first.syncNow();
      expect(await journal.listPending()).toHaveLength(1);
      await first.stop();

      server.interceptor = undefined;
      await session({ server, vault, journal }).start();

      expect(server.liveFiles()).toEqual(new Map([["a.md", "edit"]]));
      expect(await journal.listPending()).toEqual([]);
    });

    it("waits for ready before it touches the vault or the server", async () => {
      const server = new InMemoryServer();
      const calls: string[] = [];
      server.interceptor = (method) => calls.push(method);
      let ready: () => void = () => undefined;
      const started = session({
        server,
        vault: new InMemoryVault(),
        journal: new InMemoryJournal(),
        options: { ready: () => new Promise((resolve) => (ready = resolve)) },
      }).start();

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual([]);
      ready();
      await started;
      expect(calls).toContain("ListChanges");
    });
  });

  describe("while running", () => {
    it("pushes a local edit once the push debounce it was given has passed", async () => {
      vi.useFakeTimers();
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      await session({
        server,
        vault,
        journal: new InMemoryJournal(),
        options: { pushDebounceMs: 1500 },
      }).start();

      await vault.write("a.md", bytes("typed"));
      await vi.advanceTimersByTimeAsync(1499);
      expect(server.liveFiles()).toEqual(new Map());
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(server.liveFiles()).toEqual(new Map([["a.md", "typed"]]));
      });
    });

    it("on the sync timer pulls remote changes and retries a pending operation, with no local edit", async () => {
      vi.useFakeTimers();
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const journal = new InMemoryJournal();
      await vault.write("a.md", bytes("local"));
      server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("lost", Code.Unavailable);
      };
      await session({
        server,
        vault,
        journal,
        options: { syncIntervalMs: 30_000 },
      }).start();
      expect(await journal.listPending()).toHaveLength(1);

      server.interceptor = undefined;
      server.commit({
        documentId: "remote",
        path: "remote.md",
        content: "remote",
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(await files(vault)).toEqual(new Map([["a.md", "local"]]));
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(async () => {
        expect(await journal.listPending()).toEqual([]);
      });

      expect(server.liveFiles()).toEqual(
        new Map([
          ["a.md", "local"],
          ["remote.md", "remote"],
        ]),
      );
      expect(await files(vault)).toEqual(server.liveFiles());
    });

    it("keeps an edit made while the server is unreachable, reports offline, and pushes it on the sync timer once the server is back", async () => {
      vi.useFakeTimers();
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const statuses: SessionStatus[] = [];
      await session({
        server,
        vault,
        journal: new InMemoryJournal(),
        statuses,
        options: { pushDebounceMs: 1000, syncIntervalMs: 30_000 },
      }).start();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "idle" });
      });

      // Every call fails as a request that never reached the server does (airplane mode).
      server.interceptor = () => {
        throw new ConnectError("network error: net::ERR_INTERNET_DISCONNECTED", Code.Unavailable);
      };
      await vault.write("a.md", bytes("written offline"));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "offline" });
      });
      expect(await files(vault)).toEqual(new Map([["a.md", "written offline"]]));
      expect(server.liveFiles()).toEqual(new Map());

      server.interceptor = undefined;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => {
        expect(server.liveFiles()).toEqual(new Map([["a.md", "written offline"]]));
      });
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({ state: "idle", pending: 0, conflicts: 0 });
      });
      expect(await files(vault)).toEqual(new Map([["a.md", "written offline"]]));
    });

    it("pushes an edit made while the server was unreachable from the next session when the app was closed before it synced", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "a", path: "a.md", content: "synced" });
      const vault = new InMemoryVault();
      const journal = new InMemoryJournal();
      const statuses: SessionStatus[] = [];
      const first = session({ server, vault, journal, statuses });
      await first.start();
      expect(await files(vault)).toEqual(new Map([["a.md", "synced"]]));

      server.interceptor = () => {
        throw new ConnectError("network error: net::ERR_INTERNET_DISCONNECTED", Code.Unavailable);
      };
      await vault.write("a.md", bytes("edited offline"));
      await vault.write("b.md", bytes("created offline"));
      await first.syncNow();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "offline" });
      });
      await first.stop();
      expect(server.liveFiles()).toEqual(new Map([["a.md", "synced"]]));

      server.interceptor = undefined;
      await session({ server, vault, journal }).start();

      const expected = new Map([
        ["a.md", "edited offline"],
        ["b.md", "created offline"],
      ]);
      expect(server.liveFiles()).toEqual(expected);
      expect(await files(vault)).toEqual(expected);
    });
  });

  describe("when stopped", () => {
    it("pushes an edit the stopped session never pushed with the next session", async () => {
      vi.useFakeTimers();
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const journal = new InMemoryJournal();
      const first = session({
        server,
        vault,
        journal,
        options: { pushDebounceMs: 2000 },
      });
      await first.start();

      await vault.write("a.md", bytes("typed just before the stop"));
      await first.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(server.liveFiles()).toEqual(new Map());

      await session({
        server,
        vault,
        journal,
        options: { pushDebounceMs: 2000 },
      }).start();
      expect(server.liveFiles()).toEqual(new Map([["a.md", "typed just before the stop"]]));
    });

    it("waits for a local step in progress, and the stopped engine takes no further local step", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "a", path: "a.md", content: "first" });
      server.commit({ documentId: "b", path: "b.md", content: "second" });
      const vault = new InMemoryVault();
      const inner = new InMemoryJournal();
      // Holds the first document write, the step between applying a.md's disk change and moving the cursor.
      let release: () => void = () => undefined;
      let held = false;
      const steps: string[] = [];
      const journal = new Proxy(inner, {
        get: (target, property, receiver) => {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            steps.push(String(property));
            if (property === "putDocument" && !held) {
              held = true;
              await new Promise<void>((resolve) => (release = resolve));
            }
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const running = session({ server, vault, journal });
      void running.start();
      await vi.waitFor(() => {
        expect(held).toBe(true);
      });

      let stopped = false;
      const stopping = running.stop().then(() => (stopped = true));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stopped).toBe(false);
      const stepsAtStop = steps.length;
      release();
      await stopping;

      // The held write finished; nothing after it ran: no cursor move, no b.md.
      expect(steps).toHaveLength(stepsAtStop);
      expect(await inner.getCursor()).toBe(0n);
      expect(await files(vault)).toEqual(new Map([["a.md", "first"]]));
    });

    it("waits for an automatic push's local step in progress before it resolves", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const inner = new InMemoryJournal();
      let armed = false;
      let held = false;
      let release: () => void = () => undefined;
      const journal = new Proxy(inner, {
        get: (target, property, receiver) => {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (armed && property === "addPending" && !held) {
              held = true;
              await new Promise<void>((resolve) => (release = resolve));
            }
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const running = session({ server, vault, journal, options: { pushDebounceMs: 10 } });
      await running.start();
      armed = true;
      await vault.write("a.md", bytes("typed"));
      await vi.waitFor(() => {
        expect(held).toBe(true);
      });

      let stopped = false;
      const stopping = running.stop().then(() => (stopped = true));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stopped).toBe(false);
      release();
      await stopping;

      // The operation was recorded (so the next session resumes it), and never sent.
      expect(await inner.listPending()).toHaveLength(1);
      expect(server.liveFiles()).toEqual(new Map());
    });

    it("resolves while a server call hangs, and the stopped engine never touches the vault or journal again", async () => {
      const server = new InMemoryServer();
      server.commit({
        documentId: "remote",
        path: "remote.md",
        content: "remote",
      });
      const vault = new InMemoryVault();
      const counted = countingJournal(new InMemoryJournal());
      const network = holdable(server.transport);
      network.hold();
      const running = session({
        server,
        vault,
        journal: counted.journal,
        transport: network.transport,
      });
      const started = running.start();
      await vi.waitFor(() => {
        expect(network.heldCalls).toBe(1);
      });

      await running.stop();
      expect(await started).toBeUndefined();
      const callsAtStop = counted.calls();
      network.release();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(counted.calls()).toBe(callsAtStop);
      expect(await files(vault)).toEqual(new Map());
    });

    it("lets a new session over the same journal pick up where the stopped one left off", async () => {
      const server = new InMemoryServer();
      server.commit({
        documentId: "remote",
        path: "remote.md",
        content: "remote",
      });
      const vault = new InMemoryVault();
      const journal = new InMemoryJournal();
      const network = holdable(server.transport);
      network.hold();
      const stopped = session({
        server,
        vault,
        journal,
        transport: network.transport,
      });
      void stopped.start();
      await vi.waitFor(() => {
        expect(network.heldCalls).toBe(1);
      });
      await stopped.stop();

      const summary = await session({ server, vault, journal }).start();
      network.release();

      expect(summary).toMatchObject({ applied: 1 });
      expect(await files(vault)).toEqual(server.liveFiles());
    });

    it("stops before ready without ever starting", async () => {
      const server = new InMemoryServer();
      const calls: string[] = [];
      server.interceptor = (method) => calls.push(method);
      const pending = session({
        server,
        vault: new InMemoryVault(),
        journal: new InMemoryJournal(),
        options: { ready: () => new Promise(() => undefined) },
      });
      const started = pending.start();

      await pending.stop();
      expect(await started).toBeUndefined();
      expect(calls).toEqual([]);
    });
  });

  describe("status", () => {
    it("reports syncing while a sync runs and idle afterwards", async () => {
      const server = new InMemoryServer();
      const statuses: SessionStatus[] = [];
      await session({
        server,
        vault: new InMemoryVault(),
        journal: new InMemoryJournal(),
        statuses,
      }).start();

      expect(statuses[0]).toMatchObject({ state: "syncing" });
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({
          state: "idle",
          pending: 0,
          conflicts: 0,
        });
      });
    });

    it("reports offline, with the pending count, when the server cannot be reached", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      await vault.write("a.md", bytes("local"));
      server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("network error: net::ERR_INTERNET_DISCONNECTED", Code.Unavailable);
      };
      const statuses: SessionStatus[] = [];
      await session({
        server,
        vault,
        journal: new InMemoryJournal(),
        statuses,
      }).start();

      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "offline", pending: 1 });
      });
    });

    it("reports an error with the server's message", async () => {
      const server = new InMemoryServer();
      server.interceptor = (method) => {
        if (method === "ListChanges") throw new ConnectError("not a member of this vault", Code.PermissionDenied);
      };
      const statuses: SessionStatus[] = [];
      await session({
        server,
        vault: new InMemoryVault(),
        journal: new InMemoryJournal(),
        statuses,
      }).start();

      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({
          state: "error",
          message: "not a member of this vault",
        });
      });
    });

    it("counts a conflict copy until the user deletes it", async () => {
      const server = new InMemoryServer();
      server.commit({
        documentId: "remote",
        path: "a.md",
        content: "remote version\n",
      });
      const vault = new InMemoryVault();
      await vault.write("a.md", bytes("local version\n"));
      const statuses: SessionStatus[] = [];
      const running = session({
        server,
        vault,
        journal: new InMemoryJournal(),
        statuses,
      });
      await running.start();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({
          state: "idle",
          pending: 0,
          conflicts: 1,
        });
      });

      const copy = (await vault.list()).find((path) => path !== "a.md") ?? "";
      expect(copy).toMatch(/conflict/);
      await vault.delete(copy);
      await running.syncNow();

      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({
          state: "idle",
          pending: 0,
          conflicts: 0,
        });
      });
    });

    it("reports nothing once stopped", async () => {
      vi.useFakeTimers();
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const statuses: SessionStatus[] = [];
      const running = session({
        server,
        vault,
        journal: new InMemoryJournal(),
        statuses,
        options: { pushDebounceMs: 100, syncIntervalMs: 1000 },
      });
      await running.start();
      await vi.advanceTimersByTimeAsync(0);
      await running.stop();
      const count = statuses.length;

      await vault.write("a.md", bytes("after the stop"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(statuses).toHaveLength(count);
      expect(server.liveFiles()).toEqual(new Map());
    });
  });
});
