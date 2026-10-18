import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { ServerInfoService } from "../../gen/vaultsync/v1/server_info_pb";
import { VaultService } from "../../gen/vaultsync/v1/vault_pb";
import { createProtocolClient } from "./client";

/**
 * An in-process server (no network): ConnectRPC's router transport runs the
 * handlers directly. It records the Authorization header each RPC received
 * and, like the real server will, rejects ListVaults without a bearer token.
 */
function fakeServer() {
  const received: (string | null)[] = [];
  const transport = createRouterTransport(({ service }) => {
    service(ServerInfoService, {
      getServerInfo: (_request, context) => {
        received.push(context.requestHeader.get("authorization"));
        return { version: "1.2.3-test", protocolVersion: 1 };
      },
    });
    service(VaultService, {
      listVaults: (_request, context) => {
        const authorization = context.requestHeader.get("authorization");
        received.push(authorization);
        if (authorization?.startsWith("Bearer ") !== true) {
          throw new ConnectError("missing bearer token", Code.Unauthenticated);
        }
        return { vaults: [{ id: "vault-1", name: authorization.slice("Bearer ".length) }] };
      },
    });
  });
  return { transport, received };
}

describe("createProtocolClient", () => {
  it("calls GetServerInfo through the injected transport", async () => {
    const server = fakeServer();
    const client = createProtocolClient({ transport: server.transport });

    const info = await client.serverInfo.getServerInfo({});

    expect(info.version).toBe("1.2.3-test");
    expect(info.protocolVersion).toBe(1);
  });

  it("sends the supplied token as a bearer token on authenticated RPCs", async () => {
    const server = fakeServer();
    const client = createProtocolClient({ transport: server.transport, token: () => "token-abc" });

    const response = await client.vaults.listVaults({});

    expect(server.received).toEqual(["Bearer token-abc"]);
    expect(response.vaults.map((vault) => vault.name)).toEqual(["token-abc"]);
  });

  it("asks the token source on every call so refreshed tokens are used", async () => {
    const server = fakeServer();
    const tokens = ["first", "second"];
    const client = createProtocolClient({
      transport: server.transport,
      token: () => Promise.resolve(tokens.shift()),
    });

    await client.vaults.listVaults({});
    await client.vaults.listVaults({});

    expect(server.received).toEqual(["Bearer first", "Bearer second"]);
  });

  it("sends no Authorization header without a token, and the server's rejection surfaces", async () => {
    const server = fakeServer();
    const client = createProtocolClient({ transport: server.transport, token: () => undefined });

    await client.serverInfo.getServerInfo({});
    const rejection = client.vaults.listVaults({});

    await expect(rejection).rejects.toSatisfy((error) => ConnectError.from(error).code === Code.Unauthenticated);
    expect(server.received).toEqual([null, null]);
  });

  it("preserves headers supplied by the caller", async () => {
    const received: (string | null)[] = [];
    const transport = createRouterTransport(({ service }) => {
      service(VaultService, {
        listVaults: (_request, context) => {
          received.push(context.requestHeader.get("x-request-id"), context.requestHeader.get("authorization"));
          return {};
        },
      });
    });
    const client = createProtocolClient({ transport, token: () => "t" });

    await client.vaults.listVaults({}, { headers: { "x-request-id": "r1" } });

    expect(received).toEqual(["r1", "Bearer t"]);
  });

  it("routes every call through the injected transport so it can be wrapped (fault injection)", async () => {
    const server = fakeServer();
    const calls: string[] = [];
    let failNext = true;
    const faulty: Transport = {
      unary: (method, ...rest) => {
        calls.push(method.name);
        if (failNext) {
          failNext = false;
          return Promise.reject(new ConnectError("injected drop", Code.Unavailable));
        }
        return server.transport.unary(method, ...rest);
      },
      stream: (method, ...rest) => server.transport.stream(method, ...rest),
    };
    const client = createProtocolClient({ transport: faulty, token: () => "t" });

    await expect(client.vaults.listVaults({})).rejects.toThrow("injected drop");
    await client.vaults.listVaults({});

    expect(calls).toEqual(["ListVaults", "ListVaults"]);
    expect(server.received).toEqual(["Bearer t"]);
  });
});
