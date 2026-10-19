import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createProtocolClient } from "../plugin/src/core/protocol/client";
import { SyncService } from "../plugin/src/gen/vaultsync/v1/sync_pb";
import { errorCode, settle, SimNetwork } from "./network";

// These tests exercise the fault injector itself, so the far side is a
// trivial in-process handler that records what reached it. The simulation
// proper always runs against the real server.

type Settled = { state: "pending" } | { state: "ok"; seq: bigint } | { state: "failed"; code: Code };

function setup(commitRetryBackoff?: number) {
  const received: string[] = [];
  /** Revision ids the server refuses, with the code it refuses them with. */
  const refuse = new Map<string, Code>();
  const violations: { invariant: string; detail: string }[] = [];
  const server = createRouterTransport(({ service }) => {
    service(SyncService, {
      commitRevision: (request) => {
        const code = refuse.get(request.revisionId);
        if (code !== undefined) throw new ConnectError("refused", code);
        received.push(request.revisionId);
        return { revision: { id: request.revisionId, seq: BigInt(received.length) } };
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
  const commit = (client: number, revisionId: string): { current: Settled } => {
    const result: { current: Settled } = { current: { state: "pending" } };
    const api = clients[client];
    if (api === undefined) throw new Error("no such client");
    api.sync.commitRevision({ revisionId }).then(
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
