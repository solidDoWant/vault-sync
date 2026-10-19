import { requireSecureUrl, type OidcClientConfig } from "../core/auth/oidc";
import type { ProtocolClient } from "../core/protocol/client";
import { isProtocolCompatible, PROTOCOL_VERSION } from "../core/version";
import { oidcSettings, type PluginData } from "./data";

/** The longest client id accepted from the server, as the server bounds VAULT_SYNC_OIDC_CLIENT_ID. */
const maxClientIdLength = 255;

/**
 * The identity provider to sign in with (SPEC.md §9.1). Calls the server's
 * unauthenticated GetServerInfo, checks that it speaks a compatible protocol,
 * and takes the issuer and client id it advertises. The settings' issuer and
 * client id are optional overrides: an entered client id wins (the provider
 * may know the plugin under another client than the server advertises), and
 * an entered issuer is used only with a server that advertises none, since a
 * server accepts tokens from its own issuer only. Older servers advertise
 * neither, and then both must be entered.
 */
export async function discoverIdentityProvider(client: ProtocolClient, data: PluginData): Promise<OidcClientConfig> {
  const info = await client.serverInfo.getServerInfo({});
  if (!isProtocolCompatible(info.protocolVersion)) {
    throw new Error(`the server speaks protocol v${String(info.protocolVersion)}, but this plugin needs v${String(PROTOCOL_VERSION)} or later; update the server`);
  }
  const entered = oidcSettings(data);
  const advertisedIssuer = info.oidcIssuerUrl;
  if (advertisedIssuer !== "" && entered.issuer !== "" && entered.issuer !== advertisedIssuer) {
    throw new Error(`the server does not trust the OIDC issuer URL in the settings (${entered.issuer}), only ${advertisedIssuer}; clear the setting to use the server's`);
  }
  const issuer = advertisedIssuer !== "" ? advertisedIssuer : entered.issuer;
  if (issuer === "") throw new Error("the server does not say which identity provider to sign in with; enter the OIDC issuer URL in the settings");
  requireSecureUrl(issuer, "The OIDC issuer URL");
  const clientId = entered.clientId !== "" ? entered.clientId : info.oidcClientId;
  if (clientId === "") throw new Error("the server does not say which OAuth client to sign in as; enter the OIDC client ID in the settings");
  if (clientId.length > maxClientIdLength || !/^[\x20-\x7e]+$/.test(clientId)) {
    throw new Error(`the OIDC client ID must be 1 to ${String(maxClientIdLength)} printable ASCII characters`);
  }
  return { issuer, clientId };
}
