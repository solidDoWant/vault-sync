import { describe, expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device, settle } from "./testing";

// The app going to the background (flush) and coming back (resume): on
// Android the WebView freezes soon after the first and runs no timer until
// the second.

const retryMs = 300_000;

function setup(): { server: InMemoryServer; a: Device; b: Device; runs: { a: number; b: number } } {
  const server = new InMemoryServer();
  const runs = { a: 0, b: 0 };
  const options = { random: () => 1, backoff: { initialMs: retryMs, maxMs: retryMs } };
  const devices: { a?: Device; b?: Device } = {};
  // Counts the syncs started: the status turns to "syncing" once per sync, however many calls join it.
  const counter = (name: "a" | "b") => {
    let syncing = false;
    return () => {
      const now = devices[name]?.engine.status === "syncing";
      if (now && !syncing) runs[name]++;
      syncing = now;
    };
  };
  devices.a = new Device(server, "device-a", { ...options, onChange: counter("a") });
  devices.b = new Device(server, "device-b", { ...options, onChange: counter("b") });
  return { server, a: devices.a, b: devices.b, runs };
}

/** Counts the server calls. */
function countCalls(server: InMemoryServer): { calls: number } {
  const counts = { calls: 0 };
  server.interceptor = () => {
    counts.calls++;
  };
  return counts;
}

describe("flush, when the app goes to the background", () => {
  it("pushes a local change at once instead of after the debounce", async () => {
    const { server, a } = setup();
    await a.engine.start();
    await a.write("a.md", "typed just before switching apps");
    await settle();
    expect(a.timers.delays()).toContain(2_000);
    a.engine.flush();
    await settle();
    await a.engine.settled();
    expect(server.liveFiles()).toEqual(new Map([["a.md", "typed just before switching apps"]]));
    expect(a.timers.delays()).not.toContain(2_000);
    a.engine.stop();
  });

  it("calls the server not at all when nothing is pending", async () => {
    const { server, a } = setup();
    await a.write("a.md", "synced");
    await a.engine.start();
    const counts = countCalls(server);
    a.engine.flush();
    await settle();
    await a.engine.settled();
    expect(counts.calls).toBe(0);
    a.engine.stop();
  });

  it("joins a running sync instead of starting a second one", async () => {
    const { server, a, runs } = setup();
    await a.engine.start();
    await a.write("a.md", "one");
    await settle();
    await a.write("b.md", "two");
    await settle();
    expect(a.timers.delays()).toContain(2_000);
    const before = runs.a;
    const running = a.engine.sync();
    a.engine.flush();
    await running;
    await a.engine.settled();
    expect(runs.a - before).toBe(1);
    expect(server.liveFiles()).toEqual(
      new Map([
        ["a.md", "one"],
        ["b.md", "two"],
      ]),
    );
    a.engine.stop();
  });
});

describe("resume, when the app comes back to the foreground", () => {
  it("syncs at once, dropping a retry timer set before the freeze", async () => {
    const { server, a, b } = setup();
    await b.engine.start();
    server.interceptor = () => {
      throw new Error("offline");
    };
    await b.engine.sync().catch(() => undefined);
    expect(b.engine.status).toBe("error");
    expect(b.timers.delays()).toContain(retryMs);
    server.interceptor = undefined;
    await a.write("a.md", "written while b was in the background");
    await a.sync();
    b.engine.resume();
    await settle();
    await b.engine.settled();
    expect(await b.files()).toEqual({ "a.md": "written while b was in the background" });
    expect(b.engine.status).toBe("idle");
    expect(b.timers.delays()).not.toContain(retryMs);
    b.engine.stop();
  });

  it("syncs at once and starts the interval over, instead of waiting for the interval set before the freeze", async () => {
    const { a, b } = setup();
    await b.engine.start();
    expect(b.timers.delays()).toEqual([60_000]);
    await a.write("a.md", "written while b was in the background");
    await a.sync();
    b.engine.resume();
    await settle();
    await b.engine.settled();
    expect(await b.files()).toEqual({ "a.md": "written while b was in the background" });
    // One interval timer, set at the resume: the old one is gone.
    expect(b.timers.delays()).toEqual([60_000]);
    b.engine.stop();
  });

  it("joins a running sync instead of starting a second one", async () => {
    const { a, b, runs } = setup();
    await b.engine.start();
    await a.write("a.md", "one");
    await a.sync();
    const before = runs.b;
    const running = b.engine.sync();
    b.engine.resume();
    await running;
    await b.engine.settled();
    expect(runs.b - before).toBe(1);
    expect(await b.files()).toEqual({ "a.md": "one" });
    b.engine.stop();
  });

  it("does nothing on a stopped engine", async () => {
    const { server, b } = setup();
    await b.engine.start();
    b.engine.stop();
    const counts = countCalls(server);
    b.engine.resume();
    b.engine.flush();
    await settle();
    expect(counts.calls).toBe(0);
    expect(b.timers.delays()).toEqual([]);
  });
});
