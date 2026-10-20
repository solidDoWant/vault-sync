// The OAuth 2.0 calls the plugin makes to the identity provider (SPEC.md
// §9.1): OpenID discovery, the Device Authorization Grant (RFC 8628) and the
// refresh-token grant. HTTP goes through an injected client so the same code
// runs on Obsidian's requestUrl (desktop and Android alike, no CORS), in unit
// tests and in the simulation.

/** One HTTP request to the identity provider. */
export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** An `application/x-www-form-urlencoded` body for POST. */
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

/**
 * Sends one request and resolves with the response whatever its status; it
 * rejects only when no response arrived (a network failure).
 */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** Where the identity provider takes device-flow and token requests. */
export interface OidcEndpoints {
  issuer: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

/** A pending device authorization: what the user has to see, and how to poll for its result. */
export interface DeviceAuthorization {
  /** Secret: identifies the authorization when polling. Never shown or logged. */
  deviceCode: string;
  /** The code the user enters at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** `verificationUri` with the user code filled in, when the provider offers one. */
  verificationUriComplete?: string;
  /** When the authorization expires, in milliseconds since the epoch. */
  expiresAt: number;
  /** The polling interval the provider asked for, in milliseconds. */
  intervalMs: number;
}

/** Tokens from a successful grant. Both tokens are secrets: never log them. */
export interface TokenSet {
  accessToken: string;
  /** A new refresh token, when the provider issued (or rotated) one. */
  refreshToken?: string;
  /** When the access token was obtained, in milliseconds since the epoch. */
  obtainedAt: number;
  /** When the access token expires (its `exp`, else `expires_in`), in milliseconds since the epoch; undefined if unknown. */
  expiresAt?: number;
}

/** The identity provider answered with an OAuth error (RFC 6749 §5.2, RFC 8628 §3.5). */
export class OAuthError extends Error {
  override readonly name: string = "OAuthError";
  constructor(
    /** The `error` code, e.g. `invalid_grant`, `access_denied`, `expired_token`. */
    readonly code: string,
    description: string | undefined,
  ) {
    super(description === undefined || description === "" ? code : `${code}: ${description}`);
  }
}

/**
 * The refresh token no longer works: it expired, was revoked, or the user's
 * session at the identity provider ended. Only signing in again helps.
 */
export class SignInRequiredError extends Error {
  override readonly name = "SignInRequiredError";
}

/**
 * The identity provider could not be reached or answered with something that
 * is not a valid response. A later attempt may succeed.
 */
export class IdentityProviderError extends Error {
  override readonly name = "IdentityProviderError";
  /**
   * Whether the provider could not be reached or failed on its side (no
   * network, DNS, a refused connection, an HTTP 5xx): the device is offline
   * as far as the user can tell. False for an answer that is not a valid
   * response (a malformed body, a missing field, an unexpected 4xx), which
   * points at a misconfigured provider instead (#413).
   */
  readonly unreachable: boolean;

  constructor(message: string, options: { unreachable?: boolean } = {}) {
    super(message);
    this.unreachable = options.unreachable ?? false;
  }
}

/** The scopes requested at sign-in: `offline_access` asks for a refresh token. */
export const defaultScope = "openid offline_access";

/** Responses larger than this are refused before they are parsed. */
const maxResponseBytes = 64 * 1024;
/** RFC 8628 §3.2: the default polling interval. */
const defaultIntervalMs = 5000;
/** RFC 8628 §3.5: `slow_down` adds 5 seconds to the interval. */
const slowDownMs = 5000;
const deviceCodeGrant = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Throws unless `url` is an absolute https URL, or plain http to a loopback
 * host (for development), so tokens never cross the network in the clear.
 */
export function requireSecureUrl(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return parsed;
  throw new Error(`${what} must use https (plain http is allowed only for localhost)`);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Fetches the issuer's OpenID configuration and returns its device-flow and
 * token endpoints. The document must name `issuer` exactly (OpenID Connect
 * Discovery §4.3), and every endpoint must be secure.
 */
export async function discoverOidc(http: HttpClient, issuer: string): Promise<OidcEndpoints> {
  requireSecureUrl(issuer, "The OIDC issuer");
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const response = await send(http, { url, method: "GET", headers: { Accept: "application/json" } });
  if (response.status !== 200) throw new IdentityProviderError(`OpenID discovery at ${url} failed with HTTP ${String(response.status)}`, { unreachable: response.status >= 500 });
  const document = parseObject(response.text, "the OpenID configuration");
  if (document.issuer !== issuer) throw new Error(`the OpenID configuration names issuer ${JSON.stringify(document.issuer)}, not ${JSON.stringify(issuer)}`);
  const deviceAuthorizationEndpoint = document.device_authorization_endpoint;
  const tokenEndpoint = document.token_endpoint;
  if (typeof deviceAuthorizationEndpoint !== "string" || deviceAuthorizationEndpoint === "") {
    throw new Error("the identity provider does not support the device authorization grant (no device_authorization_endpoint)");
  }
  if (typeof tokenEndpoint !== "string" || tokenEndpoint === "") throw new Error("the OpenID configuration has no token_endpoint");
  requireSecureUrl(deviceAuthorizationEndpoint, "The device authorization endpoint");
  requireSecureUrl(tokenEndpoint, "The token endpoint");
  return { issuer, deviceAuthorizationEndpoint, tokenEndpoint };
}

/** Starts a device authorization (RFC 8628 §3.1). */
export async function startDeviceAuthorization(
  http: HttpClient,
  endpoints: OidcEndpoints,
  clientId: string,
  options: { scope?: string; now?: () => number } = {},
): Promise<DeviceAuthorization> {
  const now = options.now ?? Date.now;
  const response = await postForm(http, endpoints.deviceAuthorizationEndpoint, { client_id: clientId, scope: options.scope ?? defaultScope });
  const body = parseObject(response.text, "the device authorization response");
  if (response.status !== 200) throw oauthError(response.status, body);
  const deviceCode = requireString(body, "device_code");
  const userCode = requireString(body, "user_code");
  const verificationUri = requireString(body, "verification_uri");
  requireSecureUrl(verificationUri, "The verification URL");
  const expiresIn = body.expires_in;
  if (typeof expiresIn !== "number" || !(expiresIn > 0)) throw new IdentityProviderError("the device authorization response has no valid expires_in");
  const authorization: DeviceAuthorization = {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: now() + expiresIn * 1000,
    intervalMs: typeof body.interval === "number" && body.interval > 0 ? body.interval * 1000 : defaultIntervalMs,
  };
  const complete = body.verification_uri_complete;
  if (typeof complete === "string" && complete !== "") {
    requireSecureUrl(complete, "The verification URL");
    authorization.verificationUriComplete = complete;
  }
  return authorization;
}

export interface PollOptions {
  /** Aborting it stops polling; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  now?: () => number;
  /** Waits `ms` milliseconds, or rejects when `signal` aborts. Defaults to a timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Polls the token endpoint until the user approves the authorization (RFC
 * 8628 §3.4, §3.5): it waits the provider's interval between polls, slows down
 * when asked, and rejects with an OAuthError when the user denies it
 * (`access_denied`) or it expires (`expired_token`). Network failures and
 * server errors are retried at the polling interval until the authorization
 * expires.
 */
export async function pollDeviceAuthorization(
  http: HttpClient,
  endpoints: OidcEndpoints,
  clientId: string,
  authorization: DeviceAuthorization,
  options: PollOptions = {},
): Promise<TokenSet> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  let interval = authorization.intervalMs;
  for (;;) {
    await sleep(interval, options.signal);
    options.signal?.throwIfAborted();
    if (now() >= authorization.expiresAt) throw new OAuthError("expired_token", "the sign-in code expired");
    let response: HttpResponse;
    try {
      response = await postForm(http, endpoints.tokenEndpoint, { grant_type: deviceCodeGrant, device_code: authorization.deviceCode, client_id: clientId });
    } catch (error) {
      if (error instanceof IdentityProviderError) continue;
      throw error;
    }
    if (response.status >= 500) continue;
    let body: Record<string, unknown>;
    try {
      body = parseObject(response.text, "the token response");
    } catch (error) {
      if (error instanceof IdentityProviderError) continue;
      throw error;
    }
    if (response.status === 200) return tokenSet(body, now());
    const code = body.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += slowDownMs;
      continue;
    }
    throw oauthError(response.status, body);
  }
}

/**
 * Exchanges a refresh token for a new access token (RFC 6749 §6). Rejects
 * with SignInRequiredError when the refresh token is no longer valid
 * (`invalid_grant`: expired, revoked, or the provider session ended), and
 * with IdentityProviderError when the provider is unreachable or failing.
 */
export async function refreshAccessToken(
  http: HttpClient,
  endpoints: OidcEndpoints,
  clientId: string,
  refreshToken: string,
  options: { now?: () => number } = {},
): Promise<TokenSet> {
  const now = options.now ?? Date.now;
  const response = await postForm(http, endpoints.tokenEndpoint, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  if (response.status >= 500) throw new IdentityProviderError(`the token endpoint failed with HTTP ${String(response.status)}`, { unreachable: true });
  const body = parseObject(response.text, "the token response");
  if (response.status === 200) return tokenSet(body, now());
  const error = oauthError(response.status, body);
  if (error instanceof OAuthError && error.code === "invalid_grant") throw new SignInRequiredError(`the identity provider refused the refresh token (${error.message})`);
  throw error;
}

/** The identity provider and client the plugin signs in with. */
export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  /** Defaults to defaultScope. */
  scope?: string;
}

export interface DeviceSignInOptions extends PollOptions {
  /** Called once the user code is known, to show it and the verification URL to the user. */
  onAuthorization: (authorization: DeviceAuthorization) => void;
}

/**
 * Runs the whole device flow (SPEC.md §9.1): discovery, the device
 * authorization, which `onAuthorization` shows the user, and polling until
 * the user approves it, denies it, it expires, or `signal` aborts.
 */
export async function signInWithDeviceFlow(http: HttpClient, config: OidcClientConfig, options: DeviceSignInOptions): Promise<TokenSet> {
  const endpoints = await discoverOidc(http, config.issuer);
  options.signal?.throwIfAborted();
  const authorization = await startDeviceAuthorization(http, endpoints, config.clientId, {
    ...(config.scope === undefined ? {} : { scope: config.scope }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  options.signal?.throwIfAborted();
  options.onAuthorization(authorization);
  return pollDeviceAuthorization(http, endpoints, config.clientId, authorization, options);
}

/**
 * The refresh-token grant against `config`'s provider, for TokenManager's
 * `refresh`. The provider's endpoints are discovered on first use and kept;
 * a failed discovery is tried again on the next refresh.
 */
export function oidcRefresher(http: HttpClient, config: OidcClientConfig, options: { now?: () => number } = {}): (refreshToken: string) => Promise<TokenSet> {
  let endpoints: Promise<OidcEndpoints> | undefined;
  return async (refreshToken) => {
    endpoints ??= discoverOidc(http, config.issuer).catch((error: unknown) => {
      endpoints = undefined;
      throw error;
    });
    return refreshAccessToken(http, await endpoints, config.clientId, refreshToken, options);
  };
}

function tokenSet(body: Record<string, unknown>, obtainedAt: number): TokenSet {
  const accessToken = requireString(body, "access_token");
  const tokens: TokenSet = { accessToken, obtainedAt };
  if (typeof body.refresh_token === "string" && body.refresh_token !== "") tokens.refreshToken = body.refresh_token;
  const expiresAt = jwtExpiry(accessToken) ?? (typeof body.expires_in === "number" && body.expires_in > 0 ? obtainedAt + body.expires_in * 1000 : undefined);
  if (expiresAt !== undefined) tokens.expiresAt = expiresAt;
  return tokens;
}

/**
 * The `exp` of a JWT access token, in milliseconds, without verifying it (the
 * server verifies it; the client only needs to know when to refresh). It is
 * what the server checks, so it is preferred over `expires_in`.
 */
export function jwtExpiry(token: string): number | undefined {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

/**
 * The `sub` of a JWT access token, without verifying it: who the server will
 * take the caller to be, used only to tell local records of different
 * accounts apart (never to authorize anything).
 */
export function jwtSubject(token: string): string | undefined {
  const sub = jwtClaims(token)?.sub;
  return typeof sub === "string" && sub !== "" ? sub : undefined;
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) => char.charCodeAt(0)));
    const claims: unknown = JSON.parse(json);
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function postForm(http: HttpClient, url: string, form: Record<string, string>): Promise<HttpResponse> {
  return send(http, {
    url,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
}

async function send(http: HttpClient, request: HttpRequest): Promise<HttpResponse> {
  let response: HttpResponse;
  try {
    response = await http(request);
  } catch (error) {
    throw new IdentityProviderError(`could not reach the identity provider at ${new URL(request.url).origin}: ${error instanceof Error ? error.message : String(error)}`, {
      unreachable: true,
    });
  }
  if (utf8Length(response.text) > maxResponseBytes) throw new IdentityProviderError(`the identity provider's response is larger than ${String(maxResponseBytes)} bytes`);
  return response;
}

/** The length of `text` in UTF-8 bytes. Every UTF-16 code unit takes at least one byte, so a text with more code units than the bound is refused without encoding it. */
function utf8Length(text: string): number {
  if (text.length > maxResponseBytes) return text.length;
  return new TextEncoder().encode(text).length;
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IdentityProviderError(`${what} is not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new IdentityProviderError(`${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw new IdentityProviderError(`the identity provider's response has no ${field}`);
  return value;
}

function oauthError(status: number, body: Record<string, unknown>): Error {
  if (typeof body.error !== "string" || body.error === "") {
    return new IdentityProviderError(`the identity provider answered HTTP ${String(status)} without an OAuth error`, { unreachable: status >= 500 });
  }
  return new OAuthError(body.error, typeof body.error_description === "string" ? body.error_description : undefined);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
