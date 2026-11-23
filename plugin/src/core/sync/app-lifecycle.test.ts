import { describe, expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device, settle } from "./testing";

// The app going to the background (flush) and coming back (resume): on
// Android the WebView freezes soon after the first and runs no timer until
// the second.

const retryMs = 300_000;

function setup(): { server: InMemoryServer; a: Device; b: Device } {
  const server = new InMemoryServer();
  const options = { random: () => 1, backoff: { initialMs: retryMs, maxMs: retryMs } };
  return { server, a: new Device(server, "device-a", options), b: new Device(server, "device-b", options) };
}

/**
 * Records how many of the device's syncs scan the vault at once. Every cycle
 * lists the vault, and each listing here takes a few milliseconds, so two
 * syncs running side by side overlap in it.
 */
function overlapOf(device: Device): { most: number } {
  const seen = { most: 0 };
  let now = 0;
  const list = device.vault.list.bind(device.vault);
  device.vault.list = async () => {
    now++;
    seen.most = Math.max(seen.most, now);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await list();
    } finally {
      now--;
    }
  };
  return seen;
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
    const { server, a } = setup();
    const overlap = overlapOf(a);
    await a.engine.start();
    await a.write("a.md", "one");
    await settle();
    await a.write("b.md", "two");
    await settle();
    expect(a.timers.delays()).toContain(2_000);
    const running = a.engine.sync();
    a.engine.flush();
    await running;
    await a.engine.settled();
    expect(overlap.most).toBe(1);
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
    const { a, b } = setup();
    const overlap = overlapOf(b);
    await b.engine.start();
    await a.write("a.md", "one");
    await a.sync();
    const running = b.engine.sync();
    b.engine.resume();
    await running;
    await b.engine.settled();
    expect(overlap.most).toBe(1);
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
