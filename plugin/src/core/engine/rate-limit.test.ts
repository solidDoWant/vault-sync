import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import type { Timers } from "../backoff";
import { EngineDisposedError, type PushSummary } from "./engine";
import { harness, type Harness, type HarnessOptions } from "./testing";

// The engine's backoff after the server's per-user limit refuses a call with
// RESOURCE_EXHAUSTED (#146, SPEC.md §12). The timers and the jitter are
// injected, so nothing here waits on the clock.

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

const tooBusy = () => new ConnectError("too many concurrent requests from this user; retry once earlier requests complete", Code.ResourceExhausted);

/** Timers that fire only when the test says so, recording each delay asked for. */
class ManualTimers implements Timers {
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

/** Lets every queued promise run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Setup {
  h: Harness;
  timers: ManualTimers;
  /** Every call the server received, by method. */
  calls: string[];
  /** Methods the server refuses with RESOURCE_EXHAUSTED, as many times as listed. */
  refuse: string[];
}

function setup(options: HarnessOptions = {}): Setup {
  const timers = new ManualTimers();
  const h = harness({ timers, random: () => 0.25, ...options });
  const calls: string[] = [];
  const refuse: string[] = [];
  h.server.interceptor = (method) => {
    calls.push(method);
    const index = refuse.indexOf(method);
    if (index >= 0) {
      refuse.splice(index, 1);
      throw tooBusy();
    }
  };
  return { h, timers, calls, refuse };
}

describe("SyncEngine backoff after RESOURCE_EXHAUSTED", () => {
  it("waits out a jittered delay before its next push calls the server, then commits the pending change with its revision id", async () => {
    const { h, timers, calls, refuse } = setup();
    await h.vault.write("a.md", bytes("written while the server is busy"));
    refuse.push("CommitRevision");

    await expect(h.engine.push()).rejects.toMatchObject({ code: Code.ResourceExhausted });
    const [pending] = await h.journal.listPending();
    expect(pending).toMatchObject({ path: "a.md" });
    // Half of the 1 s ceiling, plus a quarter (the random part) of the other half.
    expect(timers.delays).toEqual([625]);

    calls.length = 0;
    const retry = h.engine.push();
    await flush();
    await flush();
    expect(calls).toEqual([]);

    timers.fire();
    expect(await retry).toMatchObject({ committed: 1, pending: 0 });
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", "written while the server is busy"]]));
    expect(h.acknowledged.map((revision) => revision.revisionId)).toEqual([pending?.revisionId]);
    expect(await h.journal.listPending()).toEqual([]);
  });

  it("backs off the same way when a pull or a blob upload is refused", async () => {
    for (const method of ["ListChanges", "BeginBlob"]) {
      const { h, timers, calls, refuse } = setup();
      await h.vault.write("a.md", bytes("a1"));
      refuse.push(method);

      await expect(method === "ListChanges" ? h.engine.pull() : h.engine.push()).rejects.toMatchObject({ code: Code.ResourceExhausted });
      expect(timers.delays).toEqual([625]);
      calls.length = 0;
      const retry = h.engine.push();
      await flush();
      expect(calls).toEqual([]);

      timers.fire();
      await retry;
      expect(h.server.liveFiles()).toEqual(new Map([["a.md", "a1"]]));
    }
  });

  it("doubles the delay with each consecutive refusal up to the bound, and starts over after a success", async () => {
    const { h, timers, refuse } = setup({ random: () => 1, rateLimitBackoff: { initialMs: 1000, maxMs: 40_000 } });
    for (let refusal = 0; refusal < 8; refusal++) {
      refuse.push("ListChanges");
      const pull = h.engine.pull();
      if (refusal > 0) timers.fire();
      await expect(pull).rejects.toMatchObject({ code: Code.ResourceExhausted });
    }
    // The ceiling reaches 32 s at the 6th refusal; the 7th would be 64 s and is held at 40 s.
    expect(timers.delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 40_000, 40_000]);

    const pull = h.engine.pull();
    timers.fire();
    await pull;
    refuse.push("ListChanges");
    await expect(h.engine.pull()).rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect(timers.delays.at(-1)).toBe(1000);
  });

  it("never waits less than half the ceiling, nor more than the bound", async () => {
    const { h, timers, refuse } = setup({ random: () => 0, rateLimitBackoff: { initialMs: 1000, maxMs: 4000 } });
    for (let refusal = 0; refusal < 4; refusal++) {
      refuse.push("ListChanges");
      const pull = h.engine.pull();
      if (refusal > 0) timers.fire();
      await expect(pull).rejects.toMatchObject({ code: Code.ResourceExhausted });
    }
    expect(timers.delays).toEqual([500, 1000, 2000, 2000]);
  });

  it("pushes on its own once the delay is over when it pushes automatically", async () => {
    const pushed: PushSummary[] = [];
    // A long debounce, so only the backoff's end can start the push here.
    const { h, timers, refuse } = setup({ pushDebounceMs: 3_600_000, onPushComplete: (summary) => pushed.push(summary) });
    await h.vault.write("a.md", bytes("a1"));
    refuse.push("CommitRevision");
    await expect(h.engine.push()).rejects.toMatchObject({ code: Code.ResourceExhausted });

    timers.fire();
    await flush();
    await h.engine.settled();

    expect(pushed).toMatchObject([{ committed: 1, pending: 0 }]);
    expect(h.server.liveFiles()).toEqual(new Map([["a.md", "a1"]]));
    h.engine.dispose();
  });

  it("does not back off after other failures", async () => {
    const { h, timers, calls } = setup();
    let fail = true;
    const intercept = h.server.interceptor;
    h.server.interceptor = (method, request) => {
      intercept?.(method, request);
      if (fail) throw new ConnectError("connection lost", Code.Unavailable);
    };
    await expect(h.engine.pull()).rejects.toMatchObject({ code: Code.Unavailable });
    fail = false;
    calls.length = 0;

    await h.engine.pull();

    expect(timers.delays).toEqual([]);
    expect(calls).toEqual(["ListChanges"]);
  });

  it("rejects a push waiting out the delay once the engine is disposed, without calling the server", async () => {
    const { h, timers, calls, refuse } = setup();
    refuse.push("ListChanges");
    await expect(h.engine.pull()).rejects.toMatchObject({ code: Code.ResourceExhausted });
    calls.length = 0;
    const push = h.engine.push();
    await flush();

    h.engine.dispose();

    await expect(push).rejects.toBeInstanceOf(EngineDisposedError);
    await h.engine.settled();
    expect(calls).toEqual([]);
    expect(timers.pending.size).toBe(0);
  });
});
