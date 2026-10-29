// The OAuth 2.0 calls the plugin makes to the identity provider (SPEC.md
// §9.1): OpenID discovery, the Device Authorization Grant (RFC 8628) and the
// refresh-token grant, built on oauth4webapi. HTTP goes through an injected
// client (the library's custom fetch hook) so the same code runs on Obsidian's
// requestUrl (desktop and Android alike, no CORS) and in unit tests.

import * as oauth from "oauth4webapi";

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
  /** The response headers; oauth4webapi reads an OAuth error body only when its `Content-Type` is `application/json`. */
  headers?: Record<string, string>;
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

  constructor(message: string, options: { unreachable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
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
 * The oauth4webapi request options that send every request through `http`.
 * requireSecureUrl checks every URL before it is used, so the library's own
 * https-only check, which has no loopback exception, is turned off.
 */
function requestOptions(http: HttpClient) {
  return {
    [oauth.customFetch]: async (url: string, init: oauth.CustomFetchOptions<string, unknown>): Promise<Response> => {
      const response = await send(http, {
        url,
        method: init.method === "POST" ? "POST" : "GET",
        headers: init.headers,
        ...(init.body instanceof URLSearchParams ? { body: init.body.toString() } : {}),
      });
      try {
        return new Response(nullBodyStatuses.has(response.status) ? null : response.text, { status: response.status, ...(response.headers === undefined ? {} : { headers: response.headers }) });
      } catch (error) {
        throw new IdentityProviderError(`the identity provider answered with HTTP status ${String(response.status)}`, { cause: error });
      }
    },
    // Plain http to a loopback host, for development, is the one insecure URL requireSecureUrl lets through.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    [oauth.allowInsecureRequests]: true,
  };
}

/** HTTP statuses a Response may not carry a body with. */
const nullBodyStatuses = new Set([101, 103, 204, 205, 304]);

/** A public client: it authenticates with its client_id alone. */
function publicClient(clientId: string): oauth.Client {
  return { client_id: clientId };
}

function authorizationServer(endpoints: OidcEndpoints): oauth.AuthorizationServer {
  return { issuer: endpoints.issuer, device_authorization_endpoint: endpoints.deviceAuthorizationEndpoint, token_endpoint: endpoints.tokenEndpoint };
}

/**
 * Maps what oauth4webapi throws for a response with HTTP status `status`
 * onto this module's errors: an OAuth error body becomes an OAuthError, a
 * response that is not a valid one an IdentityProviderError.
 */
function translateError(error: unknown, status: number): unknown {
  if (error instanceof oauth.ResponseBodyError) return new OAuthError(error.error, error.error_description);
  if (error instanceof oauth.OperationProcessingError || error instanceof oauth.UnsupportedOperationError || error instanceof oauth.WWWAuthenticateChallengeError) {
    return new IdentityProviderError(`the identity provider's response is not valid: ${error.message}`, { unreachable: status >= 500 });
  }
  return error;
}

async function processResponse<T>(response: Response, process: (response: Response) => Promise<T>): Promise<T> {
  try {
    return await process(response);
  } catch (error) {
    throw translateError(error, response.status);
  }
}

/**
 * Fetches the issuer's OpenID configuration and returns its device-flow and
 * token endpoints. The document must name `issuer` (OpenID Connect Discovery
 * §4.3), and every endpoint must be secure.
 */
export async function discoverOidc(http: HttpClient, issuer: string): Promise<OidcEndpoints> {
  const issuerUrl = requireSecureUrl(issuer, "The OIDC issuer");
  const response = await oauth.discoveryRequest(issuerUrl, { ...requestOptions(http), algorithm: "oidc" });
  if (response.status !== 200) throw new IdentityProviderError(`OpenID discovery for ${issuer} failed with HTTP ${String(response.status)}`, { unreachable: response.status >= 500 });
  let document: oauth.AuthorizationServer;
  try {
    document = await oauth.processDiscoveryResponse(issuerUrl, response);
  } catch (error) {
    if (error instanceof oauth.OperationProcessingError && error.code === oauth.JSON_ATTRIBUTE_COMPARISON) {
      const named = (error.cause as { body?: { issuer?: unknown } } | undefined)?.body?.issuer;
      throw new Error(`the OpenID configuration names issuer ${JSON.stringify(named)}, not ${JSON.stringify(issuer)}`, { cause: error });
    }
    throw translateError(error, response.status);
  }
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
  const server = authorizationServer(endpoints);
  const client = publicClient(clientId);
  const response = await oauth.deviceAuthorizationRequest(server, client, oauth.None(), { scope: options.scope ?? defaultScope }, requestOptions(http));
  const body = await processResponse(response, (received) => oauth.processDeviceAuthorizationResponse(server, client, received));
  requireSecureUrl(body.verification_uri, "The verification URL");
  const authorization: DeviceAuthorization = {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresAt: now() + body.expires_in * 1000,
    intervalMs: body.interval === undefined ? defaultIntervalMs : body.interval * 1000,
  };
  const complete = body.verification_uri_complete;
  if (complete !== undefined) {
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
  const server = authorizationServer(endpoints);
  const client = publicClient(clientId);
  let interval = authorization.intervalMs;
  for (;;) {
    await sleep(interval, options.signal);
    options.signal?.throwIfAborted();
    if (now() >= authorization.expiresAt) throw new OAuthError("expired_token", "the sign-in code expired");
    let response: Response;
    try {
      response = await oauth.deviceCodeGrantRequest(server, client, oauth.None(), authorization.deviceCode, requestOptions(http));
    } catch (error) {
      if (error instanceof IdentityProviderError) continue;
      throw error;
    }
    if (response.status >= 500) continue;
    try {
      return tokenSet(await oauth.processDeviceCodeResponse(server, client, response), now());
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError && error.error === "authorization_pending") continue;
      if (error instanceof oauth.ResponseBodyError && error.error === "slow_down") {
        interval += slowDownMs;
        continue;
      }
      // A body that is not JSON may be a proxy's error page: poll again.
      if (error instanceof oauth.OperationProcessingError && (error.code === oauth.PARSE_ERROR || error.code === oauth.RESPONSE_IS_NOT_CONFORM)) continue;
      throw translateError(error, response.status);
    }
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
  const server = authorizationServer(endpoints);
  const client = publicClient(clientId);
  const response = await oauth.refreshTokenGrantRequest(server, client, oauth.None(), refreshToken, requestOptions(http));
  if (response.status >= 500) throw new IdentityProviderError(`the token endpoint failed with HTTP ${String(response.status)}`, { unreachable: true });
  try {
    return tokenSet(await processResponse(response, (received) => oauth.processRefreshTokenResponse(server, client, received)), now());
  } catch (error) {
    if (error instanceof OAuthError && error.code === "invalid_grant") throw new SignInRequiredError(`the identity provider refused the refresh token (${error.message})`);
    throw error;
  }
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

function tokenSet(body: oauth.TokenEndpointResponse, obtainedAt: number): TokenSet {
  const accessToken = body.access_token;
  const tokens: TokenSet = { accessToken, obtainedAt };
  if (body.refresh_token !== undefined) tokens.refreshToken = body.refresh_token;
  const expiresAt = jwtExpiry(accessToken) ?? (body.expires_in !== undefined && body.expires_in > 0 ? obtainedAt + body.expires_in * 1000 : undefined);
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

/**
 * The display name a JWT access token asserts, without verifying it: its
 * `name` claim, falling back to `preferred_username` (docs/design/sharing.md,
 * Attribution), the claims the server records as the user's name. Undefined
 * if it has neither.
 */
export function jwtDisplayName(token: string): string | undefined {
  const claims = jwtClaims(token);
  for (const claim of [claims?.name, claims?.preferred_username]) {
    if (typeof claim === "string" && claim.trim() !== "") return claim.trim();
  }
  return undefined;
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

/**
 * How long a request to the identity provider may go unanswered before it
 * counts as unreachable (SPEC.md §4, #730): a black-holed connection would
 * otherwise hold a token refresh, and every RPC waiting on it, for as long as
 * the platform's HTTP stack waits.
 */
export const identityProviderTimeoutMs = 30_000;

async function send(http: HttpClient, request: HttpRequest): Promise<HttpResponse> {
  let response: HttpResponse;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`no answer for ${String(identityProviderTimeoutMs / 1000)} s`));
      }, identityProviderTimeoutMs);
    });
    response = await Promise.race([http(request), expired]);
  } catch (error) {
    throw new IdentityProviderError(`could not reach the identity provider at ${new URL(request.url).origin}: ${error instanceof Error ? error.message : String(error)}`, {
      unreachable: true,
    });
  } finally {
    clearTimeout(timer);
  }
  if (utf8Length(response.text) > maxResponseBytes) throw new IdentityProviderError(`the identity provider's response is larger than ${String(maxResponseBytes)} bytes`);
  return response;
}

/** The length of `text` in UTF-8 bytes. Every UTF-16 code unit takes at least one byte, so a text with more code units than the bound is refused without encoding it. */
function utf8Length(text: string): number {
  if (text.length > maxResponseBytes) return text.length;
  return new TextEncoder().encode(text).length;
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
