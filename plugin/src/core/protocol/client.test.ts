import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { ServerInfoService } from "../../gen/vaultsync/v1/server_info_pb";
import { VaultService } from "../../gen/vaultsync/v1/vault_pb";
import { IdentityProviderError, SignInRequiredError } from "../auth/oidc";
import { createProtocolClient, type Authenticator } from "./client";

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

describe("createProtocolClient with refreshable tokens", () => {
  /** An authenticator handing out numbered tokens; invalidate() makes the next call use the next one. */
  function authenticator(options: { fail?: Error } = {}) {
    const state = { current: 1, asked: 0, invalidated: [] as string[] };
    const auth: Authenticator = {
      accessToken: () => {
        state.asked++;
        return options.fail === undefined ? Promise.resolve(`token-${String(state.current)}`) : Promise.reject(options.fail);
      },
      invalidate: (token) => {
        state.invalidated.push(token);
        if (token === `token-${String(state.current)}`) state.current++;
      },
    };
    return { auth, state };
  }

  /** ListVaults accepts only the tokens in `accepted`, and records each Authorization header. */
  function picky(accepted: Set<string>, failure: Code = Code.Unauthenticated) {
    const received: (string | null)[] = [];
    const transport = createRouterTransport(({ service }) => {
      service(ServerInfoService, {
        getServerInfo: (_request, context) => {
          received.push(context.requestHeader.get("authorization"));
          return { protocolVersion: 1 };
        },
      });
      service(VaultService, {
        listVaults: (_request, context) => {
          const authorization = context.requestHeader.get("authorization");
          received.push(authorization);
          if (!accepted.has(authorization?.replace("Bearer ", "") ?? "")) throw new ConnectError("refused", failure);
          return {};
        },
      });
    });
    return { transport, received };
  }

  it("retries an RPC refused as UNAUTHENTICATED once, with a fresh token", async () => {
    const server = picky(new Set(["token-2"]));
    const { auth, state } = authenticator();
    const client = createProtocolClient({ transport: server.transport, auth });

    await client.vaults.listVaults({});

    expect(server.received).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(state.invalidated).toEqual(["token-1"]);
  });

  it("gives up after one retry", async () => {
    const server = picky(new Set());
    const { auth } = authenticator();
    const client = createProtocolClient({ transport: server.transport, auth });

    await expect(client.vaults.listVaults({})).rejects.toSatisfy((error) => ConnectError.from(error).code === Code.Unauthenticated);
    expect(server.received).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("does not retry other failures", async () => {
    const server = picky(new Set(), Code.PermissionDenied);
    const { auth, state } = authenticator();
    const client = createProtocolClient({ transport: server.transport, auth });

    await expect(client.vaults.listVaults({})).rejects.toSatisfy((error) => ConnectError.from(error).code === Code.PermissionDenied);
    expect(server.received).toEqual(["Bearer token-1"]);
    expect(state.invalidated).toEqual([]);
  });

  it("calls GetServerInfo without a token, so it works signed out", async () => {
    const server = picky(new Set());
    const { auth, state } = authenticator({ fail: new SignInRequiredError("not signed in") });
    const client = createProtocolClient({ transport: server.transport, auth });

    await client.serverInfo.getServerInfo({});

    expect(server.received).toEqual([null]);
    expect(state.asked).toBe(0);
  });

  it("fails without reaching the server when sign-in is required or the provider is down", async () => {
    const server = picky(new Set(["token-1"]));
    const signedOut = createProtocolClient({ transport: server.transport, auth: authenticator({ fail: new SignInRequiredError("not signed in") }).auth });
    const providerDown = createProtocolClient({ transport: server.transport, auth: authenticator({ fail: new IdentityProviderError("unreachable", { unreachable: true }) }).auth });
    const providerBroken = createProtocolClient({ transport: server.transport, auth: authenticator({ fail: new IdentityProviderError("the token response is not JSON") }).auth });

    await expect(signedOut.vaults.listVaults({})).rejects.toSatisfy((error) => ConnectError.from(error).code === Code.Unauthenticated);
    await expect(providerDown.vaults.listVaults({})).rejects.toSatisfy((error) => ConnectError.from(error).code === Code.Unavailable);
    // An invalid answer is no outage (#413): not UNAVAILABLE, so it is not shown as offline.
    await expect(providerBroken.vaults.listVaults({})).rejects.toSatisfy((error) => ConnectError.from(error).code === Code.Unknown);
    expect(server.received).toEqual([]);
  });
});
