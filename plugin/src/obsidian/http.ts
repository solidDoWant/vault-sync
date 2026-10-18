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
 * which is all requestUrl offers; it cannot be aborted, so an aborted call's
 * response is dropped when it arrives.
 */
export const requestUrlFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  init?.signal?.throwIfAborted();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    throw: false,
  });
  init?.signal?.throwIfAborted();
  return new Response(response.status === 204 ? null : response.arrayBuffer, { status: response.status, headers: response.headers });
};
