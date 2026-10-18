import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createProtocolClient } from "../plugin/src/core/protocol/client";
import { SyncService } from "../plugin/src/gen/vaultsync/v1/sync_pb";
import { errorCode, settle, SimNetwork } from "./network";

// These tests exercise the fault injector itself, so the far side is a
// trivial in-process handler that records what reached it. The simulation
// proper always runs against the real server.

type Settled = { state: "pending" } | { state: "ok"; seq: bigint } | { state: "failed"; code: Code };

function setup() {
  const received: string[] = [];
  const server = createRouterTransport(({ service }) => {
    service(SyncService, {
      commitRevision: (request) => {
        received.push(request.revisionId);
        return { revision: { id: request.revisionId, seq: BigInt(received.length) } };
      },
    });
  });
  const network = new SimNetwork({
    describeRequest: (method, input) => `${method}(${(input as { revisionId: string }).revisionId})`,
    describeOutcome: (_method, outcome) => (outcome.ok ? "ok" : Code[ConnectError.from(outcome.error).code]),
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
  return { network, received, commit };
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
});
