import type { DescMethod } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { BlobService } from "../../gen/vaultsync/v1/blob_pb";
import { DeviceService } from "../../gen/vaultsync/v1/device_pb";
import { ServerInfoService } from "../../gen/vaultsync/v1/server_info_pb";
import { SyncService } from "../../gen/vaultsync/v1/sync_pb";
import { UserKeyService } from "../../gen/vaultsync/v1/user_key_pb";
import { VaultService } from "../../gen/vaultsync/v1/vault_pb";
import { IdentityProviderError, SignInRequiredError } from "../auth/oidc";

/**
 * Supplies the current OIDC access token, or undefined when signed out. It is
 * called on every request so a refreshed token takes effect immediately.
 */
export type TokenSource = () => string | undefined | Promise<string | undefined>;

/**
 * Supplies access tokens that can be refreshed (TokenManager). Every RPC asks
 * for one; a token the server refuses is reported back so the next call gets
 * a fresh one.
 */
export interface Authenticator {
  /** A valid access token; rejects when the device must sign in again (SignInRequiredError) or the identity provider is unreachable. */
  accessToken(): Promise<string>;
  /** Reports that the server refused `token` as unauthenticated. */
  invalidate(token: string): void;
}

export interface ProtocolClientOptions {
  /**
   * How requests reach the server. Production uses createHttpTransport; tests
   * use an in-process router transport; the simulation wraps either with a
   * fault injector.
   */
  transport: Transport;
  /** A fixed or externally refreshed token. Ignored when `auth` is set. */
  token?: TokenSource;
  /** Refreshable tokens: an RPC refused as unauthenticated is retried once with a fresh token (withAuthentication). */
  auth?: Authenticator;
}

/** Typed clients for every vaultsync.v1 service (SPEC.md §4.1, proto/). */
export interface ProtocolClient {
  serverInfo: Client<typeof ServerInfoService>;
  devices: Client<typeof DeviceService>;
  vaults: Client<typeof VaultService>;
  sync: Client<typeof SyncService>;
  blobs: Client<typeof BlobService>;
  /** The caller's end-to-end encryption key pair (SPEC.md §9.3). */
  userKeys: Client<typeof UserKeyService>;
}

export function createProtocolClient(options: ProtocolClientOptions): ProtocolClient {
  const transport =
    options.auth !== undefined
      ? withAuthentication(options.transport, options.auth)
      : options.token === undefined
        ? options.transport
        : withBearerToken(options.transport, options.token);
  return {
    serverInfo: createClient(ServerInfoService, transport),
    devices: createClient(DeviceService, transport),
    vaults: createClient(VaultService, transport),
    sync: createClient(SyncService, transport),
    blobs: createClient(BlobService, transport),
    userKeys: createClient(UserKeyService, transport),
  };
}

/**
 * The production transport: the Connect protocol over fetch with binary
 * protobuf. `fetch` can be overridden for platforms whose global fetch is
 * unsuitable.
 */
export function createHttpTransport(baseUrl: string, options: { fetch?: typeof globalThis.fetch } = {}): Transport {
  return createConnectTransport({
    baseUrl,
    useBinaryFormat: true,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/**
 * Wraps `transport` so each request carries `Authorization: Bearer <token>`
 * when `token` yields one. Other caller-supplied headers are preserved.
 */
export function withBearerToken(transport: Transport, token: TokenSource): Transport {
  const authorize = async (header: HeadersInit | undefined): Promise<Headers> => {
    const headers = new Headers(header);
    const value = await token();
    if (value !== undefined && value !== "") headers.set("Authorization", `Bearer ${value}`);
    return headers;
  };
  return {
    unary: async (method, signal, timeoutMs, header, input, contextValues) =>
      transport.unary(method, signal, timeoutMs, await authorize(header), input, contextValues),
    stream: async (method, signal, timeoutMs, header, input, contextValues) =>
      transport.stream(method, signal, timeoutMs, await authorize(header), input, contextValues),
  };
}

/** Procedures the server serves without authentication (SPEC.md §9.1); they never wait for a token. */
const publicProcedures: ReadonlySet<DescMethod> = new Set([ServerInfoService.method.getServerInfo]);

/**
 * Wraps `transport` so every authenticated RPC carries an access token from
 * `auth`. A unary RPC the server refuses with UNAUTHENTICATED (the token
 * expired early, or was revoked at the provider) invalidates that token and is
 * sent once more, unchanged, with a fresh one: a retried CommitRevision keeps
 * its revision_id, so one whose first attempt was applied is answered with the
 * committed revision instead of being duplicated (SPEC.md §6.2). When no
 * token can be had, the call fails without reaching the server: with
 * UNAUTHENTICATED when the device must sign in again, UNAVAILABLE when the
 * identity provider is unreachable.
 */
export function withAuthentication(transport: Transport, auth: Authenticator): Transport {
  const authorize = async (header: HeadersInit | undefined): Promise<{ headers: Headers; token: string }> => {
    let token: string;
    try {
      token = await auth.accessToken();
    } catch (error) {
      throw tokenError(error);
    }
    const headers = new Headers(header);
    headers.set("Authorization", `Bearer ${token}`);
    return { headers, token };
  };
  return {
    unary: async (method, signal, timeoutMs, header, input, contextValues) => {
      if (publicProcedures.has(method)) return transport.unary(method, signal, timeoutMs, header, input, contextValues);
      const first = await authorize(header);
      try {
        return await transport.unary(method, signal, timeoutMs, first.headers, input, contextValues);
      } catch (error) {
        if (!(error instanceof ConnectError) || error.code !== Code.Unauthenticated) throw error;
        auth.invalidate(first.token);
      }
      const second = await authorize(header);
      return transport.unary(method, signal, timeoutMs, second.headers, input, contextValues);
    },
    stream: async (method, signal, timeoutMs, header, input, contextValues) => {
      if (publicProcedures.has(method)) return transport.stream(method, signal, timeoutMs, header, input, contextValues);
      return transport.stream(method, signal, timeoutMs, (await authorize(header)).headers, input, contextValues);
    },
  };
}

function tokenError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof SignInRequiredError) return new ConnectError(error.message, Code.Unauthenticated, undefined, undefined, error);
  // Only an unreachable or failing provider is UNAVAILABLE (offline); an invalid answer is an error (#413).
  if (error instanceof IdentityProviderError) return new ConnectError(error.message, error.unreachable ? Code.Unavailable : Code.Unknown, undefined, undefined, error);
  return ConnectError.from(error, Code.Unknown);
}
