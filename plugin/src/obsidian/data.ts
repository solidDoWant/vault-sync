import { requireSecureUrl, type OidcClientConfig } from "../core/auth/oidc";
import { configCategories, defaultConfigSyncSettings, type ConfigCategory, type ConfigSyncSettings } from "../core/config/policy";

/**
 * What the plugin keeps in its plugin data (`data.json` in the plugin's
 * folder under `.obsidian/plugins/`, which vault-sync never syncs; SPEC.md §8).
 */
export interface PluginData {
  /** The sync server's base URL. */
  serverUrl: string;
  /** Optional: the OIDC issuer the server trusts (its `VAULT_SYNC_OIDC_ISSUER_URL`). Empty uses the one GetServerInfo advertises. */
  oidcIssuer: string;
  /** Optional: the OAuth client the plugin signs in as; its access tokens must carry the server's audience. Empty uses the one GetServerInfo advertises. */
  oidcClientId: string;
  /** Secret: the device's refresh token (SPEC.md §9.1). Absent when signed out. Never logged or shown. */
  refreshToken?: string;
  /** The identity provider the refresh token belongs to, as resolved at sign-in, so refreshing never depends on reaching the server. Kept while signed in. */
  identityProvider?: IdentityProvider;
  /** This device's name, registered with the server and used in conflict-copy names; empty means the platform's name. */
  deviceName: string;
  /** This install's registered device. Registered once per account, then reused. */
  device?: RegisteredDevice;
  /**
   * A device registration that was started but whose result is not stored
   * in `device` yet. Saved before RegisterDevice is called, so a retry after
   * a crash or a lost response sends the same registration id and the server
   * returns the device it already registered (#428).
   */
  pendingDevice?: PendingDevice;
  /** The server vault this local vault syncs with. */
  vault?: ConnectedVault;
  /**
   * This device's config folder sync settings for this vault (SPEC.md §8).
   * Absent means the defaults: off. Kept only here, never synced or set by
   * the server.
   */
  configSync?: ConfigSyncSettings;
}

/** An OIDC issuer and the client signed in as. */
export interface IdentityProvider {
  issuer: string;
  clientId: string;
}

/** A device registered with RegisterDevice, and the account it belongs to: the server refuses commits with another user's device. */
export interface RegisteredDevice {
  id: string;
  /** The server it is registered with (serverBaseUrl). */
  serverUrl: string;
  /** The OIDC issuer and subject of the account that registered it. */
  issuer: string;
  subject: string;
}

/** A RegisterDevice call that may have succeeded without its result being stored. */
export interface PendingDevice {
  /** The client-chosen registration id (a canonical lowercase UUID). */
  registrationId: string;
  /** The name it registers, kept so a retry sends the same one. */
  name: string;
  /** The account it registers for, as in RegisteredDevice. */
  serverUrl: string;
  issuer: string;
  subject: string;
}

/** The server vault this local vault is connected to. */
export interface ConnectedVault {
  id: string;
  name: string;
  /** The server it lives on (serverBaseUrl): a vault id means nothing on another server. */
  serverUrl: string;
}

export const defaultPluginData: Readonly<PluginData> = {
  serverUrl: "",
  oidcIssuer: "",
  oidcClientId: "",
  deviceName: "",
};

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
    deviceName: text("deviceName") ?? defaultPluginData.deviceName,
  };
  const refreshToken = text("refreshToken");
  if (refreshToken !== undefined && refreshToken !== "") data.refreshToken = refreshToken;
  const identityProvider = record(stored.identityProvider, ["issuer", "clientId"]);
  if (identityProvider !== undefined) data.identityProvider = identityProvider;
  const device = record(stored.device, ["id", "serverUrl", "issuer", "subject"]);
  if (device !== undefined) data.device = device;
  const pendingDevice = record(stored.pendingDevice, ["registrationId", "name", "serverUrl", "issuer", "subject"]);
  if (pendingDevice !== undefined) data.pendingDevice = pendingDevice;
  const vault = record(stored.vault, ["id", "name", "serverUrl"]);
  if (vault !== undefined) data.vault = vault;
  const configSync = parseConfigSync(stored.configSync);
  if (configSync !== undefined) data.configSync = configSync;
  return data;
}

/** This device's config sync settings: the stored ones, or the defaults (off). */
export function configSyncSettings(data: PluginData): ConfigSyncSettings {
  return data.configSync ?? structuredClone(defaultConfigSyncSettings);
}

/** Stored config sync settings; anything but `true` turns a switch off, and a missing category takes its default. */
function parseConfigSync(raw: unknown): ConfigSyncSettings | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const stored = raw as Record<string, unknown>;
  const categories = typeof stored.categories === "object" && stored.categories !== null ? (stored.categories as Record<string, unknown>) : {};
  const parsed = {} as Record<ConfigCategory, boolean>;
  for (const category of configCategories) {
    const value = categories[category];
    parsed[category] = typeof value === "boolean" ? value : defaultConfigSyncSettings.categories[category];
  }
  return { enabled: stored.enabled === true, categories: parsed };
}

/** `raw` as a record of the non-empty string `fields`, or undefined if any is missing. */
function record<Field extends string>(raw: unknown, fields: readonly Field[]): Record<Field, string> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const result: Partial<Record<Field, string>> = {};
  for (const field of fields) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value !== "string" || value === "") return undefined;
    result[field] = value;
  }
  return result as Record<Field, string>;
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

/**
 * Records a change of the device's refresh token in `data` and saves it.
 * A token is kept with `identityProvider`, the provider that issued it (a
 * rotated token, given none, keeps the stored one). Dropping the token (a
 * sign-out, or `invalid_grant`) drops the provider too, so the next sign-in
 * asks the server again. If storing a token fails to save, `data` is left
 * as it was, so a failed sign-in leaves no provider (or token) behind;
 * dropping one is never undone, so a later save still removes it.
 */
export async function persistRefreshToken(data: PluginData, refreshToken: string | undefined, identityProvider: IdentityProvider | undefined, save: () => Promise<void>): Promise<void> {
  if (refreshToken === undefined) {
    delete data.refreshToken;
    delete data.identityProvider;
    await save();
    return;
  }
  const before = { refreshToken: data.refreshToken, identityProvider: data.identityProvider };
  data.refreshToken = refreshToken;
  if (identityProvider !== undefined) data.identityProvider = { ...identityProvider };
  const stored = { refreshToken: data.refreshToken, identityProvider: data.identityProvider };
  try {
    await save();
  } catch (error) {
    // Rolled back only if no later change replaced these values meanwhile.
    if (data.refreshToken === stored.refreshToken && data.identityProvider === stored.identityProvider) {
      if (before.refreshToken === undefined) delete data.refreshToken;
      else data.refreshToken = before.refreshToken;
      if (before.identityProvider === undefined) delete data.identityProvider;
      else data.identityProvider = before.identityProvider;
    }
    throw error;
  }
}

/** The server URL with surrounding whitespace and trailing slashes removed, as the transport wants it. */
export function serverBaseUrl(data: PluginData): string {
  return data.serverUrl.trim().replace(/\/+$/, "");
}

/** The issuer and client id entered in the settings, trimmed; either may be empty (use the server's). */
export function oidcSettings(data: PluginData): IdentityProvider {
  return { issuer: data.oidcIssuer.trim(), clientId: data.oidcClientId.trim() };
}

/** The identity provider of the current sign-in: the one resolved at sign-in, else (data from before #194) the settings. */
export function oidcConfig(data: PluginData): OidcClientConfig {
  return data.identityProvider ?? oidcSettings(data);
}

/**
 * Why signing in with `data` cannot work, or undefined if it can. Only the
 * server URL is required: the identity provider comes from the server
 * (discoverIdentityProvider). URLs must use https, except plain http to
 * localhost for development, so tokens never cross the network in the clear.
 */
export function signInProblem(data: PluginData): string | undefined {
  try {
    if (serverBaseUrl(data) === "") return "Enter the server URL.";
    requireSecureUrl(serverBaseUrl(data), "The server URL");
    const { issuer } = oidcSettings(data);
    if (issuer !== "") requireSecureUrl(issuer, "The OIDC issuer URL");
  } catch (error) {
    return error instanceof Error ? `${error.message}.` : String(error);
  }
  return undefined;
}
