import { Code, ConnectError } from "@connectrpc/connect";
import { requestUrl } from "obsidian";

import type { HttpClient } from "../core/auth/oidc";

// HTTP through Obsidian's requestUrl rather than the renderer's fetch. It is
// not subject to CORS, so identity providers that send no CORS headers for
// Obsidian's origins (`app://obsidian.md`, `capacitor://localhost`) work, and
// it behaves the same on desktop and Android.

/** The identity provider's HTTP client (core/auth/oidc.ts). */
export const requestUrlHttpClient: HttpClient = async (request) => {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    throw: false,
  });
  return { status: response.status, text: response.text };
};

/**
 * A fetch for the ConnectRPC transport (createHttpTransport's `fetch`) on
 * requestUrl. Unary calls only need a whole request and a whole response,
 * which is all requestUrl offers. requestUrl cannot be cancelled, so an
 * aborted call (a Connect timeout or a cancelled request) rejects at once
 * with the abort reason, and the HTTP exchange's eventual response is
 * dropped.
 */
export const requestUrlFetch: typeof globalThis.fetch = async (input, init) => {
  const signal = init?.signal ?? undefined;
  const request = new Request(input, init);
  signal?.throwIfAborted();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  signal?.throwIfAborted();
  // With `throw: false` every HTTP status resolves, so a rejection means the
  // server was never reached (offline, DNS, refused, TLS): UNAVAILABLE, which
  // the status bar shows as offline.
  const sent = Promise.resolve(
    requestUrl({
      url: request.url,
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      throw: false,
    }),
  ).catch((error: unknown) => {
    throw new ConnectError(`network error: ${error instanceof Error ? error.message : String(error)}`, Code.Unavailable, undefined, undefined, error);
  });
  const response = await (signal === undefined ? sent : untilAborted(sent, signal));
  return new Response(response.status === 204 ? null : response.arrayBuffer, { status: response.status, headers: response.headers });
};

/** Settles like `promise`, or rejects with `signal`'s reason as soon as it aborts, whichever comes first. */
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
