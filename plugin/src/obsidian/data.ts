import { requireSecureUrl, type OidcClientConfig } from "../core/auth/oidc";

/**
 * What the plugin keeps in its plugin data (`data.json` in the plugin's
 * folder under `.obsidian/plugins/`, which vault-sync never syncs; SPEC.md §8).
 */
export interface PluginData {
  /** The sync server's base URL. */
  serverUrl: string;
  /** The OIDC issuer the server trusts (its `VAULT_SYNC_OIDC_ISSUER_URL`). */
  oidcIssuer: string;
  /** The OAuth client the plugin signs in as; its access tokens must carry the server's audience. */
  oidcClientId: string;
  /** Secret: the device's refresh token (SPEC.md §9.1). Absent when signed out. Never logged or shown. */
  refreshToken?: string;
}

export const defaultPluginData: Readonly<PluginData> = { serverUrl: "", oidcIssuer: "", oidcClientId: "" };

/** Reads stored plugin data, keeping each field that has the right type and defaulting the rest. */
export function parsePluginData(raw: unknown): PluginData {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = (field: keyof PluginData): string | undefined => {
    const value = stored[field];
    return typeof value === "string" ? value : undefined;
  };
  const data: PluginData = {
    serverUrl: text("serverUrl") ?? defaultPluginData.serverUrl,
    oidcIssuer: text("oidcIssuer") ?? defaultPluginData.oidcIssuer,
    oidcClientId: text("oidcClientId") ?? defaultPluginData.oidcClientId,
  };
  const refreshToken = text("refreshToken");
  if (refreshToken !== undefined && refreshToken !== "") data.refreshToken = refreshToken;
  return data;
}

/**
 * Wraps `task` so its runs never overlap: each call starts it after the
 * previous run settled (even if that run failed) and resolves or rejects
 * with its own run. Plugin data saves go through it, so two saves cannot
 * finish out of order and leave older data, such as a refresh token from
 * before a sign-out, on disk.
 */
export function serialized(task: () => Promise<void>): () => Promise<void> {
  let last: Promise<void> = Promise.resolve();
  return () => {
    const run = last.then(task);
    last = run.catch(() => undefined);
    return run;
  };
}

/** The server URL with surrounding whitespace and trailing slashes removed, as the transport wants it. */
export function serverBaseUrl(data: PluginData): string {
  return data.serverUrl.trim().replace(/\/+$/, "");
}

export function oidcConfig(data: PluginData): OidcClientConfig {
  return { issuer: data.oidcIssuer.trim(), clientId: data.oidcClientId.trim() };
}

/**
 * Why signing in with `data` cannot work, or undefined if it can. URLs must
 * use https, except plain http to localhost for development, so tokens never
 * cross the network in the clear.
 */
export function signInProblem(data: PluginData): string | undefined {
  try {
    if (serverBaseUrl(data) === "") return "Enter the server URL.";
    requireSecureUrl(serverBaseUrl(data), "The server URL");
    const config = oidcConfig(data);
    if (config.issuer === "") return "Enter the OIDC issuer URL.";
    requireSecureUrl(config.issuer, "The OIDC issuer URL");
    if (config.clientId === "") return "Enter the OIDC client ID.";
  } catch (error) {
    return error instanceof Error ? `${error.message}.` : String(error);
  }
  return undefined;
}
