import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createProtocolClient } from "../plugin/src/core/protocol/client";
import { SyncService } from "../plugin/src/gen/vaultsync/v1/sync_pb";
import { errorCode, retryAfterHeadMovedMarker, settle, SimNetwork, StallError, stallTurns } from "./network";

// These tests exercise the fault injector itself, so the far side is a
// trivial in-process handler that records what reached it. The simulation
// proper always runs against the real server.

type Settled = { state: "pending" } | { state: "ok"; seq: bigint } | { state: "failed"; code: Code };

function setup(commitRetryBackoff?: number) {
  const received: string[] = [];
  /** Revision ids the server refuses, with the code it refuses them with. */
  const refuse = new Map<string, Code>();
  const violations: { invariant: string; detail: string }[] = [];
  const applied = new Map<string, { id: string; documentId: string; seq: bigint }>();
  const server = createRouterTransport(({ service }) => {
    service(SyncService, {
      commitRevision: (request) => {
        const code = refuse.get(request.revisionId);
        if (code !== undefined) throw new ConnectError("refused", code);
        received.push(request.revisionId);
        // Idempotent, as the real server: a retry gets the applied revision back.
        const revision = applied.get(request.revisionId) ?? { id: request.revisionId, documentId: request.documentId, seq: BigInt(applied.size + 1) };
        applied.set(request.revisionId, revision);
        return { revision };
      },
    });
  });
  const network = new SimNetwork({
    describeRequest: (method, input) => `${method}(${(input as { revisionId: string }).revisionId})`,
    describeOutcome: (_method, outcome) => (outcome.ok ? "ok" : Code[ConnectError.from(outcome.error).code]),
    violation: (invariant, detail) => violations.push({ invariant, detail }),
    commitRetryBackoff,
  });
  const clients = [0, 1].map((index) => createProtocolClient({ transport: network.transport(index, server) }));
  /** Sends a commit from `client` and tracks how it settles. */
  const commit = (client: number, revisionId: string, documentId = ""): { current: Settled } => {
    const result: { current: Settled } = { current: { state: "pending" } };
    const api = clients[client];
    if (api === undefined) throw new Error("no such client");
    api.sync.commitRevision({ revisionId, documentId }).then(
      (response) => (result.current = { state: "ok", seq: response.revision?.seq ?? -1n }),
      (error: unknown) => (result.current = { state: "failed", code: errorCode(error) }),
    );
    return result;
  };
  return { network, received, refuse, violations, commit };
}

describe("SimNetwork", () => {
  it("delivers a request only when a step delivers it, and its response only when another step does", async () => {
    const { network, received, commit } = setup();
    const call = commit(0, "a");
    await settle();
    expect(received).toEqual([]);

    expect(await network.deliverRequest()).toContain("c0 CommitRevision(a) -> ok");
    expect(received).toEqual(["a"]);
    await settle();
    expect(call.current).toEqual({ state: "pending" });

    network.deliverResponse();
    await settle();
    expect(call.current).toEqual({ state: "ok", seq: 1n });
    expect(network.hasMessages()).toBe(false);
  });

  it("drops a request before the server sees it", async () => {
    const { network, received, commit } = setup();
    const call = commit(0, "a");
    await settle();

    expect(network.dropRequest(0)).toContain("request lost");
    await settle();
    expect(received).toEqual([]);
    expect(call.current).toEqual({ state: "failed", code: Code.Unavailable });
  });

  it("drops a response after the server applied the request", async () => {
    const { network, received, commit } = setup();
    const call = commit(0, "a");
    await settle();
    await network.deliverRequest();

    expect(network.dropResponse(0)).toContain("response lost");
    await settle();
    expect(received).toEqual(["a"]);
    expect(call.current).toEqual({ state: "failed", code: Code.Unavailable });
  });

  it("holds a delayed request back for the given number of steps", async () => {
    const { network, received, commit } = setup();
    commit(0, "a");
    await settle();

    network.now = 10;
    network.delay(0, 3);
    expect(await network.deliverRequest()).toBeUndefined();
    network.now = 12;
    expect(await network.deliverRequest()).toBeUndefined();
    network.now = 13;
    expect(await network.deliverRequest()).toBeDefined();
    expect(received).toEqual(["a"]);
  });

  it("reorders: delivers a request other than the oldest", async () => {
    const { network, received, commit } = setup();
    commit(0, "first");
    commit(1, "second");
    await settle();

    expect(await network.reorder(0)).toContain("out of order");
    await network.deliverRequest();
    expect(received).toEqual(["second", "first"]);
  });

  it("partitions a client: its in-flight messages are lost and new ones wait until the partition ends", async () => {
    const { network, received, commit } = setup();
    const lost = commit(0, "a");
    const other = commit(1, "b");
    await settle();

    network.partition(0, 5);
    await settle();
    expect(lost.current).toEqual({ state: "failed", code: Code.Unavailable });

    const later = commit(0, "c");
    await settle();
    expect(await network.deliverRequest(0)).toBeUndefined();
    await network.deliverRequest(1);
    network.deliverResponse(1);
    await settle();
    expect(other.current).toEqual({ state: "ok", seq: 1n });

    network.now = 5;
    await network.deliverRequest(0);
    network.deliverResponse(0);
    await settle();
    expect(received).toEqual(["b", "c"]);
    expect(later.current).toEqual({ state: "ok", seq: 2n });
  });

  it("crashes a client: requests it already sent still arrive, but its old incarnation never hears back", async () => {
    const { network, received, commit } = setup();
    const call = commit(0, "a");
    await settle();

    network.crash(0);
    await network.deliverRequest();
    expect(network.deliverResponse()).toContain("crashed incarnation, discarded");
    await settle();
    expect(received).toEqual(["a"]);
    expect(call.current).toEqual({ state: "pending" });
    expect(network.incarnation(0)).toBe(1);
  });

  describe("a commit the server applied, retried with the same revision id (#110)", () => {
    for (const code of [Code.FailedPrecondition, Code.AlreadyExists]) {
      it(`reports a protocol violation when the retry is refused with ${Code[code]}`, async () => {
        const { network, refuse, violations, commit } = setup();
        commit(0, "a");
        await settle();
        await network.deliverRequest();
        network.dropResponse(0);
        await settle();

        // The server now refuses the retry, as one whose idempotency check ran after the head comparison would.
        refuse.set("a", code);
        const retry = commit(0, "a");
        await settle();
        expect(await network.deliverRequest()).toContain(`-> ${Code[code]}`);
        expect(violations.map((violation) => violation.invariant)).toEqual(["protocol"]);
        expect(violations[0]?.detail).toContain("CommitRevision(a)");
        expect(violations[0]?.detail).toContain("already applied");
        network.deliverResponse();
        await settle();
        expect(retry.current).toEqual({ state: "failed", code });
      });
    }

    it("marks the retry's trace entry when another commit moved its document's head since it was applied (#284)", async () => {
      const { network, commit } = setup();
      commit(0, "a", "d1");
      await settle();
      expect(await network.deliverRequest()).not.toContain(retryAfterHeadMovedMarker);
      network.dropResponse(0);
      await settle();

      // A retry while the head is still the applied revision is not marked.
      commit(0, "a", "d1");
      await settle();
      expect(await network.deliverRequest()).not.toContain(retryAfterHeadMovedMarker);
      network.dropResponse(0);
      await settle();

      // Another document's commit does not move d1's head.
      commit(1, "b", "d2");
      await settle();
      await network.deliverRequest();
      network.deliverResponse();
      await settle();
      commit(0, "a", "d1");
      await settle();
      expect(await network.deliverRequest()).not.toContain(retryAfterHeadMovedMarker);
      network.dropResponse(0);
      await settle();

      // A commit of d1 on top of it does.
      commit(1, "c", "d1");
      await settle();
      await network.deliverRequest();
      network.deliverResponse();
      await settle();
      commit(0, "a", "d1");
      await settle();
      expect(await network.deliverRequest()).toContain(`c0 CommitRevision(a) -> ok ${retryAfterHeadMovedMarker}`);
    });

    it("reports nothing when the server never applied the refused revision (its request was lost)", async () => {
      const { network, refuse, violations, commit } = setup();
      refuse.set("a", Code.FailedPrecondition);
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();

      commit(0, "a");
      await settle();
      expect(await network.deliverRequest()).toContain("-> FailedPrecondition");
      expect(violations).toEqual([]);
    });

    it("reports nothing when a retry of an applied commit gets its revision back, or fails for another reason", async () => {
      const { network, refuse, violations, commit } = setup();
      commit(0, "a");
      await settle();
      await network.deliverRequest();
      network.dropResponse(0);
      await settle();

      commit(0, "a");
      await settle();
      expect(await network.deliverRequest()).toContain("-> ok");
      network.deliverResponse();
      await settle();

      refuse.set("a", Code.InvalidArgument);
      commit(0, "a");
      await settle();
      expect(await network.deliverRequest()).toContain("-> InvalidArgument");
      expect(violations).toEqual([]);
    });
  });

  describe("a retry of an applied commit that retention purged since (#845)", () => {
    /** Commits `a` to d1 with its response lost, then `b` on top of it, so d1's head moved past `a`. */
    async function appliedThenSuperseded(setupResult: ReturnType<typeof setup>): Promise<void> {
      const { network, commit } = setupResult;
      commit(0, "a", "d1");
      await settle();
      await network.deliverRequest();
      network.dropResponse(0);
      await settle();
      commit(1, "b", "d1");
      await settle();
      await network.deliverRequest();
      network.deliverResponse();
      await settle();
    }

    it("excuses a FAILED_PRECONDITION for a revision retention purged before the retry was delivered, once the head moved past it", async () => {
      const harness = setup();
      await appliedThenSuperseded(harness);
      harness.network.recordPurged("a");
      harness.refuse.set("a", Code.FailedPrecondition);
      harness.commit(0, "a", "d1");
      await settle();
      expect(await harness.network.deliverRequest()).toContain("-> FailedPrecondition");
      expect(harness.violations).toEqual([]);
    });

    it("excuses it when the purge lands while the retry is still in flight, before it is delivered", async () => {
      const harness = setup();
      await appliedThenSuperseded(harness);
      harness.refuse.set("a", Code.FailedPrecondition);
      harness.commit(0, "a", "d1");
      await settle();
      harness.network.recordPurged("a");
      expect(await harness.network.deliverRequest()).toContain("-> FailedPrecondition");
      expect(harness.violations).toEqual([]);
    });

    it("still flags the refusal of a revision retention never purged", async () => {
      const harness = setup();
      await appliedThenSuperseded(harness);
      harness.network.recordPurged("b");
      harness.refuse.set("a", Code.FailedPrecondition);
      harness.commit(0, "a", "d1");
      await settle();
      await harness.network.deliverRequest();
      expect(harness.violations.map((violation) => violation.invariant)).toEqual(["protocol"]);
    });

    it("still flags the refusal when retention purged the revision only after the retry was delivered", async () => {
      const harness = setup();
      await appliedThenSuperseded(harness);
      harness.refuse.set("a", Code.FailedPrecondition);
      harness.commit(0, "a", "d1");
      await settle();
      await harness.network.deliverRequest();
      harness.network.recordPurged("a");
      expect(harness.violations.map((violation) => violation.invariant)).toEqual(["protocol"]);
    });

    it("still flags a purged revision's retry refused with a code other than FAILED_PRECONDITION", async () => {
      const harness = setup();
      await appliedThenSuperseded(harness);
      harness.network.recordPurged("a");
      harness.refuse.set("a", Code.AlreadyExists);
      harness.commit(0, "a", "d1");
      await settle();
      expect(await harness.network.deliverRequest()).toContain("-> AlreadyExists");
      expect(harness.violations.map((violation) => violation.invariant)).toEqual(["protocol"]);
    });

    it("still flags the refusal while the purged revision is its document's head", async () => {
      const harness = setup();
      harness.commit(0, "a", "d1");
      await settle();
      await harness.network.deliverRequest();
      harness.network.dropResponse(0);
      await settle();
      harness.network.recordPurged("a");
      harness.refuse.set("a", Code.FailedPrecondition);
      harness.commit(0, "a", "d1");
      await settle();
      await harness.network.deliverRequest();
      expect(harness.violations.map((violation) => violation.invariant)).toEqual(["protocol"]);
    });
  });

  describe("commit retry backoff (#110)", () => {
    it("holds a commit retried with a revision id it sent before for the backoff, and a first attempt not at all", async () => {
      const { network, received, commit } = setup(30);
      network.now = 5;
      commit(0, "a");
      await settle();
      expect(await network.deliverRequest()).toContain("CommitRevision(a) -> ok");
      network.dropResponse(0);
      await settle();

      commit(0, "a");
      commit(1, "b");
      await settle();
      // b, a first attempt, overtakes the retry.
      expect(await network.deliverRequest()).toContain("CommitRevision(b)");
      expect(await network.deliverRequest()).toBeUndefined();
      network.now = 34;
      expect(await network.deliverRequest()).toBeUndefined();
      network.now = 35;
      expect(await network.deliverRequest()).toContain("CommitRevision(a)");
      expect(received).toEqual(["a", "b", "a"]);
    });

    it("delivers retries at once without a backoff", async () => {
      const { network, commit } = setup();
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();

      commit(0, "a");
      await settle();
      expect(await network.deliverRequest()).toContain("CommitRevision(a) -> ok");
    });

    it("lets heal end a retry's backoff", async () => {
      const { network, commit } = setup(30);
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();

      commit(0, "a");
      await settle();
      expect(await network.deliverRequest()).toBeUndefined();
      network.heal();
      expect(await network.deliverRequest()).toContain("CommitRevision(a) -> ok");
    });

    it("lets draining deliver a retry enqueued after heal, though the step counter no longer moves (#273)", async () => {
      const { network, received, commit } = setup(30);
      network.now = 3000;
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();
      // Quiescing: heal, then the client resends the revision id with the step counter at its final value.
      network.heal();
      commit(0, "a");
      await settle();
      expect(await network.deliverRequest()).toBeUndefined();

      expect(network.passTime()).toBe("#1 c0 CommitRevision(a) retry backoff elapsed");
      expect(await network.deliverRequest()).toContain("c0 CommitRevision(a) -> ok");
      expect(received).toEqual(["a"]);
    });

    it("lets draining pass the time a retry's backoff waits for, but not a fault's delay (#302)", async () => {
      const { network, received, commit } = setup(30);
      network.now = 1000;
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();
      commit(0, "a");
      commit(1, "b");
      await settle();
      network.delay(1, 5);
      expect(await network.deliverRequest()).toBeUndefined();

      // The step clock stands still while draining; only passing time ends the backoff.
      expect(network.passTime()).toBe("#1 c0 CommitRevision(a) retry backoff elapsed");
      expect(await network.deliverRequest()).toContain("c0 CommitRevision(a) -> ok");
      expect(network.passTime()).toBeUndefined();
      expect(await network.deliverRequest()).toBeUndefined();
      expect(received).toEqual(["a"]);
    });

    it("passes time to whichever comes first, a backoff timer or the end of a retry's backoff", async () => {
      const { network, commit } = setup(30);
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();
      commit(0, "a");
      await settle();
      const fired: string[] = [];
      // Due at steps 2 and 31; the retry can be delivered from step 30.
      network.timers(1).setTimeout(() => fired.push("early"), 2000);
      network.timers(1).setTimeout(() => fired.push("late"), 31_000);

      expect(network.passTime()).toBe("c1 backoff timer fired");
      expect(network.passTime()).toBe("#1 c0 CommitRevision(a) retry backoff elapsed");
      expect(network.passTime()).toBe("c1 backoff timer fired");
      expect(fired).toEqual(["early", "late"]);
      // The clock moved on with them, so a timer set now runs from step 31.
      network.timers(1).setTimeout(() => fired.push("after"), 1000);
      expect(network.fireDueTimers()).toEqual([]);
    });

    it("measures a retry's backoff sent while draining from the clock draining moved on, so it waits behind a timer due before its backoff ends (#310)", async () => {
      const { network, commit } = setup(30);
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();
      const fired: string[] = [];
      // Due at steps 10 and 35.
      network.timers(1).setTimeout(() => fired.push("first"), 10_000);
      network.timers(1).setTimeout(() => fired.push("second"), 35_000);
      // Draining (the step counter stays at 0) moves the clock on to step 10.
      expect(network.passTime()).toBe("c1 backoff timer fired");

      // The retry, sent at clock step 10, waits until step 40: after the timer due at 35.
      commit(0, "a");
      await settle();
      expect(network.passTime()).toBe("c1 backoff timer fired");
      expect(fired).toEqual(["first", "second"]);
      expect(network.passTime()).toBe("#1 c0 CommitRevision(a) retry backoff elapsed");
      expect(network.passTime()).toBeUndefined();
    });

    it("does not pass time for a retry that a fault delayed once its backoff was over", async () => {
      const { network, commit } = setup(30);
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();
      commit(0, "a");
      await settle();
      network.now = 30;
      expect(network.delay(0, 5)).toBe("#1 c0 CommitRevision(a) held for 5 steps");

      expect(network.passTime()).toBeUndefined();
      expect(await network.deliverRequest()).toBeUndefined();
    });

    it("does not pass time for a partitioned client's retry, nor for another client's", async () => {
      const { network, commit } = setup(30);
      commit(0, "a");
      await settle();
      network.dropRequest(0);
      await settle();
      network.partition(0, 10);
      commit(0, "a");
      await settle();

      expect(network.passTime()).toBeUndefined();
      network.now = 10;
      expect(network.passTime(1)).toBeUndefined();
      expect(network.passTime(0)).toBe("#1 c0 CommitRevision(a) retry backoff elapsed");
    });
  });

  describe("waiting for work only the network can finish (#302)", () => {
    it("reports work that stays pending for stallTurns turns with no network activity as a stall", async () => {
      const { network, commit } = setup();
      commit(0, "a");
      await settle();
      const work = new Promise<never>(() => undefined);

      const error = await network.untilSettled(work, () => "e1 stalled").then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(StallError);
      expect((error as Error).message).toBe("e1 stalled; in the network: #0 c0 CommitRevision(a) (request)");
    });

    it("settles as the work does, if it settles on the last turn the bound allows, and reports it one turn later", async () => {
      const { network } = setup();
      const after = async (turns: number) => {
        for (let turn = 0; turn < turns; turn++) await settle();
        return turns;
      };

      expect(await network.untilSettled(after(stallTurns), () => "slow")).toBe(stallTurns);
      await expect(network.untilSettled(after(stallTurns + 1), () => "too slow")).rejects.toThrow("too slow; in the network: nothing");
      await expect(network.untilSettled(Promise.reject(new Error("failed")), () => "never")).rejects.toThrow("failed");
    });

    it("keeps waiting while the network is active", async () => {
      const { network, commit } = setup();
      const busy = async () => {
        for (let turn = 0; turn < stallTurns + 10; turn++) {
          commit(0, `r${String(turn)}`);
          await settle();
        }
        return "done";
      };

      expect(await network.untilSettled(busy(), () => "busy")).toBe("done");
    });

    // Work that something else moves on now and then, more than stallTurns turns in all but never stallTurns quiet turns in a row (#310).
    const pumped = async (action: () => unknown) => {
      for (let round = 0; round < 3; round++) {
        for (let turn = 0; turn < stallTurns / 2; turn++) await settle();
        action();
      }
      return "done";
    };

    it("counts a backoff timer firing as network activity (#310)", async () => {
      const { network } = setup();
      for (let timer = 0; timer < 3; timer++) network.timers(1).setTimeout(() => undefined, 1000);

      expect(await network.untilSettled(pumped(() => network.fireNextTimer()), () => "timers")).toBe("done");
    });

    it("counts a message leaving the network as activity (#310)", async () => {
      const { network, commit } = setup();
      for (const revision of ["a", "b", "c"]) commit(0, revision);
      await settle();
      for (let delivery = 0; delivery < 3; delivery++) await network.deliverRequest();

      // Delivering a response sends nothing: only its removal from the network is activity.
      expect(await network.untilSettled(pumped(() => network.deliverResponse()), () => "responses")).toBe("done");
    });
  });

  describe("a scripted refusal (#167)", () => {
    it("answers a client's oldest request with the given error without it reaching the server, and asks for no backoff", async () => {
      const { network, received, violations, commit } = setup();
      const call = commit(0, "a");
      await settle();

      expect(network.refuse(0, new ConnectError("no", Code.InvalidArgument))).toContain("c0 CommitRevision(a) refused by the server -> InvalidArgument");
      expect(network.deliverResponse()).toContain("reply delivered");
      await settle();

      expect(call.current).toEqual({ state: "failed", code: Code.InvalidArgument });
      expect(received).toEqual([]);
      expect(network.refuse(0, new ConnectError("no", Code.InvalidArgument))).toBeUndefined();
      commit(0, "a");
      await settle();
      expect(violations).toEqual([]);
    });
  });

  describe("RESOURCE_EXHAUSTED from the per-user limit (#146)", () => {
    it("refuses a client's oldest request without it reaching the server", async () => {
      const { network, received, commit } = setup();
      const call = commit(0, "a");
      await settle();

      expect(network.throttle(0)).toContain("c0 CommitRevision(a) refused by the server's per-user limit -> ResourceExhausted");
      expect(network.deliverResponse()).toContain("reply delivered");
      await settle();

      expect(call.current).toEqual({ state: "failed", code: Code.ResourceExhausted });
      expect(received).toEqual([]);
      expect(network.throttle(0)).toBeUndefined();
    });

    it("reports a client that sends again without setting a backoff timer first", async () => {
      const { network, violations, commit } = setup();
      commit(0, "a");
      await settle();
      network.throttle(0);
      network.deliverResponse();
      await settle();

      commit(0, "a");
      await settle();

      expect(violations).toEqual([{ invariant: "backoff", detail: "c0 sent CommitRevision after RESOURCE_EXHAUSTED without backing off first" }]);
    });

    it("reports a client that sends while its backoff timer is pending, and not once it fired", async () => {
      const { network, violations, commit } = setup();
      commit(0, "a");
      await settle();
      network.throttle(0);
      network.deliverResponse();
      await settle();
      let fired = false;
      network.timers(0).setTimeout(() => (fired = true), 2500);

      commit(1, "b");
      await settle();
      expect(violations).toEqual([]);
      commit(0, "a");
      await settle();
      expect(violations).toEqual([{ invariant: "backoff", detail: "c0 sent CommitRevision while backing off after RESOURCE_EXHAUSTED" }]);

      // 2.5 s is three steps.
      network.now = 2;
      expect(network.fireDueTimers()).toEqual([]);
      network.now = 3;
      expect(network.fireDueTimers()).toEqual(["c0 backoff timer fired"]);
      expect(fired).toBe(true);
      commit(0, "a");
      await settle();
      expect(violations).toHaveLength(1);
    });

    it("lets draining move the timers' clock on to the next timer, and forgets cleared ones", () => {
      const { network } = setup();
      const order: string[] = [];
      network.timers(1).setTimeout(() => order.push("late"), 9000);
      network.timers(0).setTimeout(() => order.push("early"), 1);
      const cleared = network.timers(0).setTimeout(() => order.push("cleared"), 500);
      network.timers(0).clearTimeout(cleared);

      expect(network.fireNextTimer(1)).toBe("c1 backoff timer fired");
      // The clock is now at step 9, so the other timer is overdue.
      expect(network.fireDueTimers()).toEqual(["c0 backoff timer fired"]);
      expect(network.fireNextTimer()).toBeUndefined();
      expect(order).toEqual(["late", "early"]);
    });
  });
});
