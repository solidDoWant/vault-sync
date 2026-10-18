import { createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { BlobService } from "../../gen/vaultsync/v1/blob_pb";
import { DeviceService } from "../../gen/vaultsync/v1/device_pb";
import { ServerInfoService } from "../../gen/vaultsync/v1/server_info_pb";
import { SyncService } from "../../gen/vaultsync/v1/sync_pb";
import { VaultService } from "../../gen/vaultsync/v1/vault_pb";

/**
 * Supplies the current OIDC access token, or undefined when signed out. It is
 * called on every request so a refreshed token takes effect immediately.
 */
export type TokenSource = () => string | undefined | Promise<string | undefined>;

export interface ProtocolClientOptions {
  /**
   * How requests reach the server. Production uses createHttpTransport; tests
   * use an in-process router transport; the simulation wraps either with a
   * fault injector.
   */
  transport: Transport;
  token?: TokenSource;
}

/** Typed clients for every vaultsync.v1 service (SPEC.md §4.1, proto/). */
export interface ProtocolClient {
  serverInfo: Client<typeof ServerInfoService>;
  devices: Client<typeof DeviceService>;
  vaults: Client<typeof VaultService>;
  sync: Client<typeof SyncService>;
  blobs: Client<typeof BlobService>;
}

export function createProtocolClient(options: ProtocolClientOptions): ProtocolClient {
  const transport = options.token === undefined ? options.transport : withBearerToken(options.transport, options.token);
  return {
    serverInfo: createClient(ServerInfoService, transport),
    devices: createClient(DeviceService, transport),
    vaults: createClient(VaultService, transport),
    sync: createClient(SyncService, transport),
    blobs: createClient(BlobService, transport),
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
