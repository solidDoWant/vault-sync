import { createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { ServerInfoService } from "../gen/vaultsync/v1/server_info_pb";
import { createProtocolClient } from "../core/protocol/client";
import type { PluginData } from "./data";
import { discoverIdentityProvider } from "./discovery";

/** An in-process server answering GetServerInfo with `info`; it counts the calls and the Authorization headers it saw. */
function serverAdvertising(info: { protocolVersion?: number; oidcIssuerUrl?: string; oidcClientId?: string }) {
  const authorizations: (string | null)[] = [];
  const transport = createRouterTransport(({ service }) => {
    service(ServerInfoService, {
      getServerInfo: (_request, context) => {
        authorizations.push(context.requestHeader.get("authorization"));
        return { version: "test", protocolVersion: 1, ...info };
      },
    });
  });
  return { client: createProtocolClient({ transport }), authorizations };
}

const onlyServerUrl: PluginData = { serverUrl: "https://sync.example", oidcIssuer: "", oidcClientId: "", deviceName: "" };
const issuer = "https://auth.example/application/o/vault-sync/";

describe("discoverIdentityProvider", () => {
  it("fills in the issuer and client id from GetServerInfo when only the server URL is entered", async () => {
    const server = serverAdvertising({ oidcIssuerUrl: issuer, oidcClientId: "obsidian-plugin" });

    expect(await discoverIdentityProvider(server.client, onlyServerUrl)).toEqual({ issuer, clientId: "obsidian-plugin" });
    // Signed out: GetServerInfo is called without a token.
    expect(server.authorizations).toEqual([null]);
  });

  it("uses the client id entered in the settings over the advertised one", async () => {
    const server = serverAdvertising({ oidcIssuerUrl: issuer, oidcClientId: "advertised" });

    expect(await discoverIdentityProvider(server.client, { ...onlyServerUrl, oidcClientId: " my-client " })).toEqual({ issuer, clientId: "my-client" });
  });

  it("accepts an entered issuer that matches the advertised one", async () => {
    const server = serverAdvertising({ oidcIssuerUrl: issuer, oidcClientId: "obsidian-plugin" });

    expect(await discoverIdentityProvider(server.client, { ...onlyServerUrl, oidcIssuer: ` ${issuer} ` })).toEqual({ issuer, clientId: "obsidian-plugin" });
  });

  it("refuses an entered issuer the server does not trust, which could never sign in", async () => {
    const server = serverAdvertising({ oidcIssuerUrl: issuer, oidcClientId: "obsidian-plugin" });

    // Even a trailing slash matters: the issuer must match exactly.
    await expect(discoverIdentityProvider(server.client, { ...onlyServerUrl, oidcIssuer: issuer.slice(0, -1) })).rejects.toThrow(/does not trust/);
  });

  it("uses the entered issuer and client id with a server that advertises none", async () => {
    const server = serverAdvertising({});

    expect(await discoverIdentityProvider(server.client, { ...onlyServerUrl, oidcIssuer: issuer, oidcClientId: "obsidian-plugin" })).toEqual({ issuer, clientId: "obsidian-plugin" });
  });

  it("asks for the issuer when neither the server nor the settings name one", async () => {
    const server = serverAdvertising({ oidcClientId: "obsidian-plugin" });

    await expect(discoverIdentityProvider(server.client, onlyServerUrl)).rejects.toThrow(/enter the OIDC issuer URL/);
  });

  it("asks for the client id when neither the server nor the settings name one", async () => {
    const server = serverAdvertising({ oidcIssuerUrl: issuer });

    await expect(discoverIdentityProvider(server.client, onlyServerUrl)).rejects.toThrow(/enter the OIDC client ID/);
  });

  it("refuses an advertised issuer that is not https", async () => {
    const server = serverAdvertising({ oidcIssuerUrl: "http://auth.example/", oidcClientId: "obsidian-plugin" });

    await expect(discoverIdentityProvider(server.client, onlyServerUrl)).rejects.toThrow(/must use https/);
  });

  it("accepts an advertised plain-http issuer on loopback, for development", async () => {
    const server = serverAdvertising({ oidcIssuerUrl: "http://127.0.0.1:9000/", oidcClientId: "obsidian-plugin" });

    expect(await discoverIdentityProvider(server.client, onlyServerUrl)).toEqual({ issuer: "http://127.0.0.1:9000/", clientId: "obsidian-plugin" });
  });

  it("refuses an advertised client id that is not 1 to 255 printable ASCII characters", async () => {
    expect(await discoverIdentityProvider(serverAdvertising({ oidcIssuerUrl: issuer, oidcClientId: "c".repeat(255) }).client, onlyServerUrl)).toEqual({ issuer, clientId: "c".repeat(255) });
    await expect(discoverIdentityProvider(serverAdvertising({ oidcIssuerUrl: issuer, oidcClientId: "c".repeat(256) }).client, onlyServerUrl)).rejects.toThrow(/client ID must be/);
    await expect(discoverIdentityProvider(serverAdvertising({ oidcIssuerUrl: issuer, oidcClientId: "vault\nsync" }).client, onlyServerUrl)).rejects.toThrow(/client ID must be/);
  });

  it("refuses a server that speaks an older protocol before using anything it advertises", async () => {
    const server = serverAdvertising({ protocolVersion: 0, oidcIssuerUrl: issuer, oidcClientId: "obsidian-plugin" });

    await expect(discoverIdentityProvider(server.client, onlyServerUrl)).rejects.toThrow(/protocol v0/);
  });
});
