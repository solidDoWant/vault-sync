import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlobService } from "../../gen/vaultsync/v1/blob_pb";
import { createHttpTransport, createProtocolClient, withRequestTimeout } from "./client";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A fetch that never answers and ignores its signal, as a black-holed connection over requestUrl does. It records the signals it was given. */
function blackHole() {
  const signals: AbortSignal[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>(() => undefined);
  };
  return { fetch, signals };
}

/** Settles `promise` into an observable state, so a test can check it is still pending. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; error?: unknown; value?: T } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

/** A blob service that answers each call only after the given delay (or never). */
function slowBlobs(delayMs: number | "never") {
  const wait = () => (delayMs === "never" ? new Promise<never>(() => undefined) : sleep(delayMs));
  return createClient(
    BlobService,
    withRequestTimeout(
      createRouterTransport(({ service }) => {
        service(BlobService, {
          putBlobChunk: async (request) => {
            await wait();
            return { receivedSize: request.offset + BigInt(request.data.byteLength) };
          },
          downloadBlob: async () => {
            await wait();
            return { data: new Uint8Array(0), size: 0n };
          },
          commitBlob: async () => {
            await wait();
            return { size: 1n };
          },
        });
      }),
    ),
  );
}

const KiB = 1024;

describe("a request the server never answers", () => {
  it("fails as UNAVAILABLE after 30 s, not before, and aborts the request", async () => {
    const hole = blackHole();
    const client = createProtocolClient({ transport: createHttpTransport("https://sync.example", { fetch: hole.fetch }) });

    const call = track(client.serverInfo.getServerInfo({}));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(call.settled).toBe(false);
    expect(hole.signals.map((signal) => signal.aborted)).toEqual([false]);

    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBe(true);
    expect(call.error).toBeInstanceOf(ConnectError);
    expect((call.error as ConnectError).code).toBe(Code.Unavailable);
    expect(hole.signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it("bounds authenticated calls the same way", async () => {
    const hole = blackHole();
    const client = createProtocolClient({ transport: createHttpTransport("https://sync.example", { fetch: hole.fetch }), token: () => "token" });

    const call = track(client.vaults.listVaults({}));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((call.error as ConnectError).code).toBe(Code.Unavailable);
  });

  it("keeps a timeout the caller set itself", async () => {
    const hole = blackHole();
    const client = createProtocolClient({ transport: createHttpTransport("https://sync.example", { fetch: hole.fetch }) });

    const call = track(client.serverInfo.getServerInfo({}, { timeoutMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(call.settled).toBe(false);
    expect(hole.signals.map((signal) => signal.aborted)).toEqual([false]);
  });

  it("still aborts at once when the caller cancels", async () => {
    const hole = blackHole();
    const client = createProtocolClient({ transport: createHttpTransport("https://sync.example", { fetch: hole.fetch }) });
    const controller = new AbortController();

    track(client.serverInfo.getServerInfo({}, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(hole.signals.map((signal) => signal.aborted)).toEqual([true]);
  });
});

describe("blob transfers", () => {
  // A chunk is given 30 s plus a second per 8 KiB (64 kbit/s): 768 KiB, the default chunk size, gets 30 s + 96 s.
  it("lets a 768 KiB chunk that takes 125.999 s succeed", async () => {
    const blobs = slowBlobs(125_999);
    const call = track(blobs.putBlobChunk({ vaultId: "v", blobId: new Uint8Array(32), offset: 0n, data: new Uint8Array(768 * KiB) }));
    await vi.advanceTimersByTimeAsync(125_999);
    expect(call.error).toBeUndefined();
    expect(call.value?.receivedSize).toBe(BigInt(768 * KiB));
  });

  it("fails a 768 KiB chunk unanswered for 126 s, not before", async () => {
    const blobs = slowBlobs("never");
    const call = track(blobs.putBlobChunk({ vaultId: "v", blobId: new Uint8Array(32), offset: 0n, data: new Uint8Array(768 * KiB) }));
    await vi.advanceTimersByTimeAsync(125_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((call.error as ConnectError).code).toBe(Code.Unavailable);
  });

  it("gives a ranged download time for the bytes it asks for", async () => {
    const blobs = slowBlobs("never");
    // 64 KiB: 30 s + 8 s.
    const call = track(blobs.downloadBlob({ vaultId: "v", blobId: new Uint8Array(32), offset: 0n, length: 64 * KiB }));
    await vi.advanceTimersByTimeAsync(37_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((call.error as ConnectError).code).toBe(Code.Unavailable);
  });

  it("gives a download of the server's maximum range time for 1 MiB", async () => {
    const blobs = slowBlobs("never");
    // Length 0 asks for the server's maximum: 30 s + 128 s.
    const call = track(blobs.downloadBlob({ vaultId: "v", blobId: new Uint8Array(32), offset: 0n, length: 0 }));
    await vi.advanceTimersByTimeAsync(157_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((call.error as ConnectError).code).toBe(Code.Unavailable);
  });

  it("gives CommitBlob, which composes the whole blob on the server, 10 minutes", async () => {
    const blobs = slowBlobs("never");
    const call = track(blobs.commitBlob({ vaultId: "v", blobId: new Uint8Array(32) }));
    await vi.advanceTimersByTimeAsync(599_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((call.error as ConnectError).code).toBe(Code.Unavailable);
  });
});
