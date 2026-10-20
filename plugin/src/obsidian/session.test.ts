import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryServer } from "../core/engine/memory-server";
import { files } from "../core/engine/testing";
import type { Journal } from "../core/journal/journal";
import { InMemoryJournal } from "../core/journal/memory";
import { createProtocolClient } from "../core/protocol/client";
import { InMemoryVault } from "../core/vault/memory";
import { SyncSession, type SessionStatus, type SyncSessionOptions } from "./session";
import { UnsavedEditsError } from "./unsaved-edits";

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
      // The push failed before it recorded the edit; it is pending all the same (#417).
      expect(statuses.at(-1)).toMatchObject({ pending: 1 });
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

    it("counts every edit and create made while the server is unreachable as pending until the server acknowledges them (#417)", async () => {
      vi.useFakeTimers();
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const statuses: SessionStatus[] = [];
      const running = session({ server, vault, journal: new InMemoryJournal(), statuses, options: { pushDebounceMs: 1000, syncIntervalMs: 30_000 } });
      await vault.write("synced.md", bytes("v1"));
      await running.start();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({ state: "idle", pending: 0, conflicts: 0 });
      });

      server.interceptor = () => {
        throw new ConnectError("network error: net::ERR_INTERNET_DISCONNECTED", Code.Unavailable);
      };
      await vault.write("synced.md", bytes("v2, edited offline"));
      await vault.write("new.md", bytes("created offline"));
      await vault.write("new.md", bytes("created offline, then edited"));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "offline" });
      });
      expect(statuses.at(-1)).toMatchObject({ pending: 2 });
      // The timer's push fails too: still two.
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "offline", pending: 2 });
      });

      server.interceptor = undefined;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({ state: "idle", pending: 0, conflicts: 0 });
      });
      expect(server.liveFiles()).toEqual(
        new Map([
          ["synced.md", "v2, edited offline"],
          ["new.md", "created offline, then edited"],
        ]),
      );
      await running.stop();
    });

    it("counts an edit once, before and after a failed push records it as a pending operation (#417)", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const statuses: SessionStatus[] = [];
      const journal = new InMemoryJournal();
      const running = session({ server, vault, journal, statuses });
      await running.start();
      server.interceptor = () => {
        throw new ConnectError("network error: net::ERR_INTERNET_DISCONNECTED", Code.Unavailable);
      };
      await vault.write("a.md", bytes("offline"));
      expect(await journal.listPending()).toEqual([]);
      await running.syncNow();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "offline", pending: 1 });
      });
      // The pull gets through and the edit is recorded, but its commit fails: still one.
      server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("network error: net::ERR_INTERNET_DISCONNECTED", Code.Unavailable);
      };
      await running.syncNow();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "offline", pending: 1 });
      });
      expect((await journal.listPending()).map((operation) => operation.path)).toEqual(["a.md"]);
      await running.stop();
    });

    it("counts an edit made while a push runs as pending when the next push cannot reach the server (#527)", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const statuses: SessionStatus[] = [];
      const journal = new InMemoryJournal();
      // Resolves once the session has seen the next local change.
      let seen: (() => void) | undefined;
      const nextLocalChange = () =>
        new Promise<void>((resolve) => {
          seen = resolve;
        });
      // While typing, the user saves b.md again during every commit of the push,
      // so the push always ends with an edit it has not committed.
      let typing = false;
      let edits = 0;
      const transport: Transport = {
        unary: async (...args) => {
          if (typing && args[0].name === "CommitRevision") {
            const classified = nextLocalChange();
            await vault.write("b.md", bytes(`edit ${String(++edits)}`));
            await classified;
          }
          return server.transport.unary(...args);
        },
        stream: (...args) => server.transport.stream(...args),
      };
      const running = session({
        server,
        vault,
        journal,
        transport,
        statuses,
        options: {
          onLocalChange: () => {
            seen?.();
          },
        },
      });
      await running.start();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({ state: "idle", pending: 0, conflicts: 0 });
      });

      await vault.write("a.md", bytes("pushed"));
      typing = true;
      expect(await running.syncNow()).toBeDefined();
      typing = false;
      expect(server.liveFiles().get("a.md")).toBe("pushed");
      const latest = `edit ${String(edits)}`;
      expect(await files(vault)).toEqual(new Map([["a.md", "pushed"], ["b.md", latest]]));
      expect(server.liveFiles().get("b.md")).not.toBe(latest);

      server.interceptor = () => {
        throw new ConnectError("network error: net::ERR_INTERNET_DISCONNECTED", Code.Unavailable);
      };
      await running.syncNow();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "offline", pending: 1 });
      });

      server.interceptor = undefined;
      await running.syncNow();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({ state: "idle", pending: 0, conflicts: 0 });
      });
      expect(server.liveFiles().get("b.md")).toBe(latest);
      await running.stop();
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

    it("refuses the stopped engine's next vault call", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "a", path: "a.md", content: "remote" });
      const inner = new InMemoryVault();
      // Holds the pull's look at a.md: the engine's next step is the vault
      // write of a.md, with no journal or server call in between.
      let release: () => void = () => undefined;
      let held = false;
      const vaultCalls: string[] = [];
      const vault = new Proxy(inner, {
        get: (target, property, receiver) => {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function" || property === "watch") return value;
          return async (...args: unknown[]) => {
            vaultCalls.push(`${String(property)} ${String(args[0])}`);
            if (property === "read" && args[0] === "a.md" && !held) {
              held = true;
              await new Promise<void>((resolve) => (release = resolve));
            }
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const running = session({ server, vault, journal: new InMemoryJournal() });
      void running.start();
      await vi.waitFor(() => {
        expect(held).toBe(true);
      });

      const stopping = running.stop();
      const callsAtStop = vaultCalls.length;
      release();
      await stopping;

      expect(vaultCalls.slice(callsAtStop)).toEqual([]);
      expect(await files(inner)).toEqual(new Map());
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

    describe("by onunload, which does not wait for the stop (#413)", () => {
      /** `target` with the first call of `method` (for `path`, if given) held until release(). */
      function holding<T extends object>(target: T, method: string, path?: string) {
        const state: { held: boolean; release: () => void } = { held: false, release: () => undefined };
        const proxy = new Proxy(target, {
          get: (object, property, receiver) => {
            const value: unknown = Reflect.get(object, property, receiver);
            if (typeof value !== "function" || property === "watch") return value;
            return async (...args: unknown[]) => {
              if (property === method && (path === undefined || args[0] === path) && !state.held) {
                state.held = true;
                await new Promise<void>((resolve) => (state.release = resolve));
              }
              return (value as (...values: unknown[]) => unknown).apply(object, args);
            };
          },
        });
        return { proxy, state };
      }

      it("ends like an interrupted step when a vault write lands after the next session started, never undoing a newer remote edit", async () => {
        const server = new InMemoryServer();
        server.commit({ documentId: "a", path: "a.md", content: "first" });
        server.commit({ documentId: "b", path: "b.md", content: "second" });
        const vault = new InMemoryVault();
        const journal = new InMemoryJournal();
        const unloading = holding(vault, "write", "a.md");
        const unloaded = session({ server, vault: unloading.proxy, journal });
        void unloaded.start();
        await vi.waitFor(() => {
          expect(unloading.state.held).toBe(true);
        });

        // onunload: the stop is not awaited, and the next load starts over the same vault and journal.
        const stopping = unloaded.stop();
        const next = session({ server, vault, journal });
        await next.start();
        expect(await files(vault)).toEqual(server.liveFiles());
        server.commit({ documentId: "a", path: "a.md", content: "edited on another device" });
        await next.syncNow();
        expect(await files(vault)).toEqual(server.liveFiles());

        // The old session's write finally lands.
        unloading.state.release();
        await stopping;
        await next.syncNow();

        expect(server.liveFiles()).toEqual(
          new Map([
            ["a.md", "edited on another device"],
            ["b.md", "second"],
          ]),
        );
        expect(await files(vault)).toEqual(server.liveFiles());
        expect(await journal.listPending()).toEqual([]);
        // The three remote revisions, and no commit of the old content over the newer one.
        expect(server.revisionCount).toBe(3);
        expect(await journal.getCursor()).toBe(3n);
      });

      it("ends like an interrupted step when a journal transaction lands after the next session started", async () => {
        const server = new InMemoryServer();
        server.commit({ documentId: "a", path: "a.md", content: "first" });
        server.commit({ documentId: "b", path: "b.md", content: "second" });
        const vault = new InMemoryVault();
        await vault.write("local.md", bytes("typed before the reload"));
        const journal = new InMemoryJournal();
        // The step between applying a.md's disk change and recording it.
        const unloading = holding(journal, "putDocument");
        const unloaded = session({ server, vault, journal: unloading.proxy });
        void unloaded.start();
        await vi.waitFor(() => {
          expect(unloading.state.held).toBe(true);
        });

        // The next session runs its startup sync before the old transaction
        // lands: a stricter order than IndexedDB's, which finishes a running
        // transaction before a later one on the same stores starts.
        const stopping = unloaded.stop();
        const next = session({ server, vault, journal });
        await next.start();
        unloading.state.release();
        await stopping;
        await next.syncNow();

        expect(server.liveFiles()).toEqual(
          new Map([
            ["a.md", "first"],
            ["b.md", "second"],
            ["local.md", "typed before the reload"],
          ]),
        );
        expect(await files(vault)).toEqual(server.liveFiles());
        expect(await journal.listPending()).toEqual([]);
        // The two remote revisions and local.md's one: nothing committed twice or for nothing.
        expect(server.revisionCount).toBe(3);
        expect(await journal.getCursor()).toBe(3n);
        // Nothing left to do: another sync commits nothing.
        expect(await next.syncNow()).toMatchObject({ committed: 0, pending: 0 });
      });
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

    it("names a local file the server refuses, with the reason, until the user renames it (#100)", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      await vault.write("notes/line\nbreak.md", bytes("mine\n"));
      const statuses: SessionStatus[] = [];
      const running = session({ server, vault, journal: new InMemoryJournal(), statuses });
      await running.start();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "error", pending: 1 });
      });
      expect(statuses.at(-1)?.message).toBe(
        'Cannot sync "notes/line\\u000Abreak.md": The path contains a control character, such as a line break or a tab, which the server does not accept. Rename or move it to sync it.',
      );

      // A later push (the timer's, say) still reports it.
      await running.syncNow();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "error", pending: 1, message: expect.stringContaining("notes/line\\u000Abreak.md") as unknown });
      });

      await vault.rename("notes/line\nbreak.md", "notes/line break.md");
      await running.syncNow();
      await vi.waitFor(() => {
        expect(statuses.at(-1)).toEqual({ state: "idle", pending: 0, conflicts: 0 });
      });
      expect(server.liveFiles()).toEqual(new Map([["notes/line break.md", "mine\n"]]));
    });

    it("counts the local files the server refuses and names one of them", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      await vault.write("a\tb.md", bytes("one\n"));
      await vault.write("c\td.md", bytes("two\n"));
      const statuses: SessionStatus[] = [];
      await session({ server, vault, journal: new InMemoryJournal(), statuses }).start();

      await vi.waitFor(() => {
        expect(statuses.at(-1)).toMatchObject({ state: "error", pending: 2 });
      });
      expect(statuses.at(-1)?.message).toMatch(/^Cannot sync 2 local files, among them "(a\\u0009b|c\\u0009d)\.md": The path contains a control character.* The Sync conflicts view lists them all\.$/);
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

  describe("conflict view", () => {
    it("lists a conflict with both versions until the user deletes the copy", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "remote", path: "a.md", content: "remote version\n" });
      const vault = new InMemoryVault();
      await vault.write("a.md", bytes("local version\n"));
      const running = session({ server, vault, journal: new InMemoryJournal() });
      await running.start();

      const [entry, ...rest] = await running.conflicts();
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ record: { reason: "concurrent-create", path: "a.md" }, original: "a.md" });
      const copy = entry?.copy ?? "";
      expect(copy).toMatch(/^a \(conflict laptop .+\)\.md$/);
      expect(new TextDecoder().decode(await vault.read(copy))).toBe("local version\n");

      await vault.delete(copy);
      expect(await running.conflicts()).toEqual([]);
    });

    it("lists documents the platform cannot hold with their remote path and reason", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "ok", path: "ok.md", content: "fine\n" });
      server.commit({ documentId: "reserved", path: "notes/CON.md", content: "a reserved name\n" });
      server.commit({ documentId: "colon", path: "a?.md", content: "a forbidden character\n" });
      const vault = new InMemoryVault();
      const running = session({ server, vault, journal: new InMemoryJournal(), options: { pathRules: { platform: "windows" } } });
      expect(await running.unmaterializable()).toEqual([]);
      await running.start();

      const listed = (await running.unmaterializable()).map(({ path, reason }) => ({ path, reason })).sort((left, right) => (left.path < right.path ? -1 : 1));
      expect(listed).toEqual([
        { path: "a?.md", reason: "forbidden-character" },
        { path: "notes/CON.md", reason: "reserved-name" },
      ]);
      expect(await vault.list()).toEqual(["ok.md"]);
    });

    it("tracks names Android's shared storage refuses as unmaterializable (#418)", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "ok", path: "CON.md", content: "fine on Android\n" });
      server.commit({ documentId: "colon", path: "ab:c.md", content: "a colon\n" });
      server.commit({ documentId: "quote", path: 'say "hi"/note.md', content: "a quote\n" });
      const vault = new InMemoryVault();
      const running = session({ server, vault, journal: new InMemoryJournal(), options: { pathRules: { platform: "posix", sharedStorage: true } } });
      await running.start();

      const listed = (await running.unmaterializable()).map(({ path, reason }) => ({ path, reason })).sort((left, right) => (left.path < right.path ? -1 : 1));
      expect(listed).toEqual([
        { path: "ab:c.md", reason: "forbidden-character" },
        { path: 'say "hi"/note.md', reason: "forbidden-character" },
      ]);
      expect(await vault.list()).toEqual(["CON.md"]);
    });

    it("lists documents larger than its download cap with their remote path and size, until stopped (#316)", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "ok", path: "ok.md", content: "fine\n" });
      server.commit({ documentId: "big", path: "big.bin", content: "x".repeat(11) });
      const vault = new InMemoryVault();
      const running = session({ server, vault, journal: new InMemoryJournal(), options: { maxDownloadBytes: 10 } });
      expect(await running.tooLarge()).toEqual([]);
      await running.start();

      expect((await running.tooLarge()).map(({ path, size }) => ({ path, size }))).toEqual([{ path: "big.bin", size: 11n }]);
      expect(await vault.list()).toEqual(["ok.md"]);

      await running.stop();
      expect(await running.tooLarge()).toEqual([]);
    });

    it("lists the local files the server refuses with their path and reason until the user removes them (#100)", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      await vault.write("ok.md", bytes("fine\n"));
      await vault.write("notes/.../a.md", bytes("dots\n"));
      const running = session({ server, vault, journal: new InMemoryJournal() });
      expect(await running.rejected()).toEqual([]);
      await running.start();

      expect((await running.rejected()).map(({ operation, reason }) => ({ path: operation.path, reason }))).toEqual([{ path: "notes/.../a.md", reason: "not-vault-relative" }]);
      expect(server.liveFiles()).toEqual(new Map([["ok.md", "fine\n"]]));

      await vault.delete("notes/.../a.md");
      await running.syncNow();
      expect(await running.rejected()).toEqual([]);

      await running.stop();
      expect(await running.rejected()).toEqual([]);
    });

    it("lists remote revisions deferred for their path with their remote path and reason, until stopped (#417)", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "ok", path: "ok.md", content: "fine\n" });
      server.commit({ documentId: "invalid", path: "/etc/passwd", content: "outside the vault\n" });
      server.commit({ documentId: "folder", path: "notes", content: "a file named like a folder\n" });
      server.commit({ documentId: "inside", path: "notes/c.md", content: "in the way\n" });
      const vault = new InMemoryVault();
      const running = session({ server, vault, journal: new InMemoryJournal() });
      expect(await running.deferred()).toEqual([]);
      await running.start();

      const listed = (await running.deferred()).map(({ path, reason }) => ({ path, reason })).sort((left, right) => (left.path < right.path ? -1 : 1));
      expect(listed).toEqual([
        { path: "/etc/passwd", reason: "invalid-path" },
        { path: "notes/c.md", reason: "path-conflict" },
      ]);

      await running.stop();
      expect(await running.deferred()).toEqual([]);
    });

    it("names the file whose open view refused a pull's write until a pull gets past it (#417)", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "a", path: "board.canvas", content: "{}" });
      const inner = new InMemoryVault();
      let viewOpen = false;
      const vault = Object.assign(Object.create(inner) as InMemoryVault, {
        write: (path: string, data: Uint8Array, precondition?: Parameters<InMemoryVault["write"]>[2]) =>
          viewOpen && path === "board.canvas" ? Promise.reject(new UnsavedEditsError(path)) : inner.write(path, data, precondition),
      });
      const running = session({ server, vault, journal: new InMemoryJournal() });
      await running.start();
      expect(running.heldByOpenView()).toBeUndefined();

      viewOpen = true;
      server.commit({ documentId: "a", path: "board.canvas", content: '{"nodes":[]}' });
      await running.syncNow();
      expect(running.heldByOpenView()).toBe("board.canvas");

      viewOpen = false;
      await running.syncNow();
      expect(running.heldByOpenView()).toBeUndefined();
      expect(await files(inner)).toEqual(new Map([["board.canvas", '{"nodes":[]}']]));

      viewOpen = true;
      server.commit({ documentId: "a", path: "board.canvas", content: '{"nodes":[1]}' });
      await running.syncNow();
      await running.stop();
      expect(running.heldByOpenView()).toBeUndefined();
    });

    it("lists nothing once stopped", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "remote", path: "a.md", content: "remote version\n" });
      server.commit({ documentId: "reserved", path: "CON.md", content: "a reserved name\n" });
      const vault = new InMemoryVault();
      await vault.write("a.md", bytes("local version\n"));
      const running = session({ server, vault, journal: new InMemoryJournal(), options: { pathRules: { platform: "windows" } } });
      await running.start();
      expect(await running.conflicts()).toHaveLength(1);
      expect(await running.unmaterializable()).toHaveLength(1);

      await running.stop();

      expect(await running.conflicts()).toEqual([]);
      expect(await running.unmaterializable()).toEqual([]);
    });
  });

  describe("history", () => {
    it("is there only while the session runs", async () => {
      const server = new InMemoryServer();
      const running = session({ server, vault: new InMemoryVault(), journal: new InMemoryJournal() });
      expect(running.history()).toBeUndefined();
      await running.start();
      expect(running.history()).toBeDefined();
      await running.stop();
      expect(running.history()).toBeUndefined();
    });

    it("does not offer deleted files at paths the vault does not sync now, such as config files while config sync is off (#417)", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "note", path: "note.md", content: "a note\n" });
      server.commit({ documentId: "snippet", path: ".obsidian/snippets/a.css", content: "body {}\n" });
      let configSync = true;
      const vault = Object.assign(Object.create(new InMemoryVault()) as InMemoryVault, { isSynced: (path: string) => configSync || !path.startsWith(".obsidian/") });
      const running = session({ server, vault, journal: new InMemoryJournal() });
      await running.start();
      server.commit({ documentId: "note", path: "note.md", deleted: true });
      server.commit({ documentId: "snippet", path: ".obsidian/snippets/a.css", deleted: true });
      await running.syncNow();
      const history = running.history();
      if (history === undefined) throw new Error("no history");
      expect((await history.deletedDocuments()).map((state) => state.path).sort()).toEqual([".obsidian/snippets/a.css", "note.md"]);

      configSync = false;

      expect((await history.deletedDocuments()).map((state) => state.path)).toEqual(["note.md"]);
      await running.stop();
    });

    it("finds a file's document, lists its history and restores a revision on disk", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const running = session({ server, vault, journal: new InMemoryJournal() });
      await running.start();
      await vault.write("plan.md", bytes("first"));
      await running.syncNow();
      await vault.write("plan.md", bytes("second"));
      await running.syncNow();
      const history = running.history();
      if (history === undefined) throw new Error("no history");

      const documentId = await history.documentAt("plan.md");
      if (documentId === undefined) throw new Error("no document at plan.md");
      const { entries } = await history.history(documentId);
      const first = entries[1];
      if (first === undefined) throw new Error("no first revision");
      expect(new TextDecoder().decode(await history.readRevision(first))).toBe("first");
      await history.restore(first);

      expect(await files(vault)).toEqual(new Map([["plan.md", "first"]]));
      expect(await history.documentAt("elsewhere.md")).toBeUndefined();
      await running.stop();
    });

    it("restores a deleted file at another path when another file took its own (#420)", async () => {
      const server = new InMemoryServer();
      const vault = new InMemoryVault();
      const running = session({ server, vault, journal: new InMemoryJournal() });
      await running.start();
      await vault.write("plan.md", bytes("old plan"));
      await running.syncNow();
      const history = running.history();
      if (history === undefined) throw new Error("no history");
      const documentId = await history.documentAt("plan.md");
      if (documentId === undefined) throw new Error("no document at plan.md");
      await vault.delete("plan.md");
      await running.syncNow();
      server.commit({ documentId: "new-plan", path: "plan.md", content: "new plan" });
      await running.syncNow();
      const [tombstone] = (await history.history(documentId)).entries;
      if (tombstone === undefined) throw new Error("no tombstone");

      await expect(history.restore(tombstone)).rejects.toMatchObject({ reason: "path-taken" });
      await history.restore(tombstone, undefined, "plan (restored).md");

      expect(await files(vault)).toEqual(
        new Map([
          ["plan.md", "new plan"],
          ["plan (restored).md", "old plan"],
        ]),
      );
      expect(await history.documentAt("plan (restored).md")).toBe(documentId);
      await running.stop();
    });
  });
});
