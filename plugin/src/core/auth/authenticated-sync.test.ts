import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import type { CommitRevisionRequest } from "../../gen/vaultsync/v1/sync_pb";
import { createProtocolClient } from "../protocol/client";
import { SyncEngine } from "../sync/engine";
import { MemorySyncJournal } from "../sync/journal";
import { InMemoryServer } from "../sync/memory-server";
import { InMemoryVault } from "../vault/memory";
import { InMemoryIdentityProvider } from "./memory-idp";
import { jwtExpiry, refreshAccessToken, SignInRequiredError, type OidcEndpoints } from "./oidc";
import { TokenManager } from "./tokens";

// The sync engine over an authenticated protocol client (SPEC.md §9.1): the
// in-memory server behind an authenticator that, like the real one, refuses
// a request whose bearer token is missing, unknown or past its exp.

const endpoints: OidcEndpoints = {
  issuer: "https://idp.example/application/o/vault-sync/",
  deviceAuthorizationEndpoint: "https://idp.example/device",
  tokenEndpoint: "https://idp.example/token",
};

const encoder = new TextEncoder();

function setup() {
  const time = { now: 1_000_000_000 };
  const now = () => time.now;
  const idp = new InMemoryIdentityProvider({ now, accessTokenLifetime: 300 });
  const server = new InMemoryServer();
  /** Access tokens the server refuses although they have not expired (revoked at the provider, say). */
  const refusedTokens = new Set<string>();
  const unauthenticated: string[] = [];
  const authenticating: Transport = {
    unary: (method, signal, timeoutMs, header, input, contextValues) => {
      const token = new Headers(header).get("authorization")?.replace(/^Bearer /, "") ?? "";
      const exp = jwtExpiry(token);
      if (exp === undefined || now() >= exp || refusedTokens.has(token)) {
        unauthenticated.push(method.name);
        return Promise.reject(new ConnectError("invalid token", Code.Unauthenticated));
      }
      return server.transport.unary(method, signal, timeoutMs, header, input, contextValues);
    },
    stream: () => Promise.reject(new Error("not used")),
  };
  const issued = idp.issue();
  const manager = new TokenManager({
    refreshToken: issued.refreshToken,
    refresh: (refreshToken) => refreshAccessToken(idp.http, endpoints, idp.clientId, refreshToken, { now }),
    persist: () => Promise.resolve(),
    now,
  });
  const vault = new InMemoryVault();
  const journal = new MemorySyncJournal();
  const engine = new SyncEngine({
    vaultId: server.vaultId,
    deviceId: "device-1",
    api: createProtocolClient({ transport: authenticating, auth: manager }),
    vault,
    journal,
    now,
  });
  const commits: CommitRevisionRequest[] = [];
  server.interceptor = (method, request) => {
    if (method === "CommitRevision") commits.push(request as CommitRevisionRequest);
  };
  return { time, idp, server, refusedTokens, unauthenticated, manager, vault, journal, engine, commits };
}

describe("sync over refreshable tokens", () => {
  it("refreshes a token before it expires, so routine expiry fails no request", async () => {
    const { time, idp, engine, vault, server, unauthenticated } = setup();
    await vault.write("a.md", encoder.encode("one"));
    await engine.sync();

    // Past the first token's exp: without a refresh ahead of time the next
    // request would be refused.
    time.now += 300_000;
    await vault.write("a.md", encoder.encode("two"));
    await engine.sync();

    expect(unauthenticated).toEqual([]);
    expect(server.liveFiles()).toEqual(new Map([["a.md", "two"]]));
    expect(idp.refreshes).toBe(2);
  });

  it("refreshes and retries an RPC the server refuses as unauthenticated", async () => {
    const { manager, refusedTokens, engine, vault, server, unauthenticated, idp } = setup();
    refusedTokens.add(await manager.accessToken());
    await vault.write("a.md", encoder.encode("one"));

    await engine.sync();

    expect(unauthenticated).toEqual(["ListChanges"]);
    expect(server.liveFiles()).toEqual(new Map([["a.md", "one"]]));
    expect(idp.refreshes).toBe(2);
  });

  it("retries a commit that was applied but answered UNAUTHENTICATED with the same revision id, without a duplicate", async () => {
    const { server, engine, vault, journal, commits } = setup();
    let lost = false;
    server.responseInterceptor = (method) => {
      if (method === "CommitRevision" && !lost) {
        lost = true;
        throw new ConnectError("token expired", Code.Unauthenticated);
      }
    };
    await vault.write("a.md", encoder.encode("one"));

    await engine.sync();

    expect(commits).toHaveLength(2);
    expect(commits[1]?.revisionId).toBe(commits[0]?.revisionId);
    expect(server.revisionCount).toBe(1);
    expect((await journal.load()).pending).toEqual([]);
  });

  it("keeps local changes journaled while sign-in is required and pushes them after the next sign-in", async () => {
    const { idp, manager, engine, vault, journal, server } = setup();
    await vault.write("a.md", encoder.encode("one"));
    await engine.sync();
    idp.revokeAll();
    // The cached access token stays usable until it expires; the refresh after that fails.
    manager.invalidate(await manager.accessToken());

    await vault.write("a.md", encoder.encode("offline edit"));
    await vault.write("b.md", encoder.encode("new note"));
    const failed = engine.sync();

    await expect(failed).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(failed).rejects.toHaveProperty("cause", expect.any(SignInRequiredError));
    expect(manager.state).toBe("sign-in-required");
    expect(server.liveFiles()).toEqual(new Map([["a.md", "one"]]));
    // Nothing on disk was touched.
    expect(new TextDecoder().decode(await vault.read("a.md"))).toBe("offline edit");

    const tokens = idp.issue();
    await manager.signIn({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, obtainedAt: 1_000_000_000 });
    await engine.sync();

    expect(server.liveFiles()).toEqual(
      new Map([
        ["a.md", "offline edit"],
        ["b.md", "new note"],
      ]),
    );
    expect((await journal.load()).pending).toEqual([]);
  });
});
