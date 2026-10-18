/// <reference types="node" />
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createHttpTransport, createProtocolClient, type TokenSource } from "../../src/core/protocol/client";

// Runs the protocol client against a real vault-sync-server. The `integration`-
// tagged Go test cmd/vault-sync-server/client_integration_test.go (run by
// `make test-integration`) starts the server against PostgreSQL and a fake
// OIDC issuer, mints the tokens, and runs this suite with
// vitest.integration.config.ts, passing everything through these variables.
// Without them (e.g. a manual vitest run) the suite is skipped.
const serverUrl = process.env.VAULT_SYNC_IT_SERVER_URL ?? "";
const validToken = process.env.VAULT_SYNC_IT_TOKEN ?? "";
// Well-formed, with valid claims, but signed by a key the issuer never published.
const foreignToken = process.env.VAULT_SYNC_IT_FOREIGN_TOKEN ?? "";

const configured = serverUrl !== "" && validToken !== "" && foreignToken !== "";

function client(token?: TokenSource) {
  return createProtocolClient({ transport: createHttpTransport(serverUrl), ...(token === undefined ? {} : { token }) });
}

async function rejectionCode(call: Promise<unknown>): Promise<Code> {
  try {
    await call;
  } catch (error) {
    return ConnectError.from(error).code;
  }
  throw new Error("the call succeeded; expected it to be rejected");
}

describe.skipIf(!configured)("protocol client against a running vault-sync-server", () => {
  it("calls GetServerInfo without a token", async () => {
    const info = await client().serverInfo.getServerInfo({});

    expect(info.protocolVersion).toBeGreaterThan(0);
    expect(info.version).not.toBe("");
  });

  it("calls an authenticated RPC (RegisterDevice) with the supplied token", async () => {
    const response = await client(() => validToken).devices.registerDevice({ name: "integration-test laptop" });

    expect(response.device?.name).toBe("integration-test laptop");
    expect(response.device?.id).not.toBe("");
  });

  it.each([
    ["no token source", undefined],
    ["a token source that yields no token", () => undefined],
  ] satisfies [string, TokenSource | undefined][])("surfaces UNAUTHENTICATED with %s", async (_name, token) => {
    expect(await rejectionCode(client(token).devices.registerDevice({ name: "unauthenticated" }))).toBe(Code.Unauthenticated);
  });

  it.each([
    ["a token that is not a JWT", () => "not-a-jwt"],
    ["a token signed by an unpublished key", () => foreignToken],
  ] satisfies [string, TokenSource][])("surfaces UNAUTHENTICATED with %s", async (_name, token) => {
    expect(await rejectionCode(client(token).devices.registerDevice({ name: "invalid token" }))).toBe(Code.Unauthenticated);
  });
});
