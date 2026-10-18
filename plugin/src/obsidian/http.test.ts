import { Code } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpTransport, createProtocolClient } from "../core/protocol/client";

// requestUrl is Obsidian's; here each call waits until the test answers it.
interface PendingRequest {
  url: string;
  method: string;
  resolve: (response: { status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer }) => void;
  reject: (error: Error) => void;
}
const pending: PendingRequest[] = [];

vi.mock("obsidian", () => ({
  requestUrl: (request: { url: string; method: string }) =>
    new Promise((resolve, reject) => {
      pending.push({ url: request.url, method: request.method, resolve, reject });
    }),
}));

const { requestUrlFetch } = await import("./http");

function answer(request: PendingRequest | undefined, status: number, body: string): void {
  const bytes = new TextEncoder().encode(body);
  request?.resolve({ status, headers: { "content-type": "application/proto" }, text: body, arrayBuffer: bytes.buffer });
}

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  pending.length = 0;
});

describe("requestUrlFetch", () => {
  it("returns the response's status, headers and body", async () => {
    const response = requestUrlFetch("https://sync.example/rpc", { method: "POST", body: new Uint8Array([1, 2]) });
    await settle();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ url: "https://sync.example/rpc", method: "POST" });

    answer(pending[0], 200, "payload");

    const result = await response;
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/proto");
    expect(await result.text()).toBe("payload");
  });

  it("frees the caller as soon as the call is aborted, without waiting for the response", async () => {
    const controller = new AbortController();
    const response = requestUrlFetch("https://sync.example/rpc", { method: "POST", body: "x", signal: controller.signal });
    await settle();
    expect(pending).toHaveLength(1);

    const reason = new Error("deadline exceeded");
    controller.abort(reason);

    // The request is still in flight: nothing has answered it.
    await expect(response).rejects.toBe(reason);
  });

  it("drops a response that arrives after the call was aborted", async () => {
    const controller = new AbortController();
    const response = requestUrlFetch("https://sync.example/rpc", { method: "POST", body: "x", signal: controller.signal });
    const outcome = response.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await settle();
    const reason = new Error("cancelled");
    controller.abort(reason);
    answer(pending[0], 200, "late");

    expect(await outcome).toBe(reason);
  });

  it("refuses an already aborted call without sending it", async () => {
    const reason = new Error("cancelled");

    await expect(requestUrlFetch("https://sync.example/rpc", { method: "POST", body: "x", signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await settle();
    expect(pending).toHaveLength(0);
  });

  it("reports a failed request as a rejection", async () => {
    const response = requestUrlFetch("https://sync.example/rpc", { method: "POST", body: "x" });
    await settle();
    pending[0]?.reject(new Error("net::ERR_CONNECTION_REFUSED"));

    await expect(response).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
  });

  it("reports a request that never reached the server as UNAVAILABLE, through a Connect client too", async () => {
    const response = requestUrlFetch("https://sync.example/rpc", { method: "POST", body: "x" });
    await settle();
    pending[0]?.reject(new Error("net::ERR_INTERNET_DISCONNECTED"));
    await expect(response).rejects.toMatchObject({ code: Code.Unavailable });

    const client = createProtocolClient({ transport: createHttpTransport("https://sync.example", { fetch: requestUrlFetch }) });
    const call = client.serverInfo.getServerInfo({});
    await settle();
    pending[1]?.reject(new Error("net::ERR_NAME_NOT_RESOLVED"));
    await expect(call).rejects.toMatchObject({ code: Code.Unavailable });
  });
});
