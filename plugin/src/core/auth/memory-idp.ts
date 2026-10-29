import type { HttpClient, HttpRequest, HttpResponse } from "./oidc";

export interface InMemoryIdentityProviderOptions {
  issuer?: string;
  clientId?: string;
  /** Access-token lifetime in seconds. */
  accessTokenLifetime?: number;
  /** Whether every refresh issues a new refresh token and revokes the old one. */
  rotateRefreshTokens?: boolean;
  /** Device-code lifetime in seconds. */
  deviceCodeLifetime?: number;
  /** Polling interval in seconds the device authorization asks for; omitted from the response if undefined. */
  interval?: number;
  now?: () => number;
}

interface DeviceGrant {
  userCode: string;
  expiresAt: number;
  state: "pending" | "approved" | "denied" | "redeemed";
}

/**
 * An in-memory OAuth 2.0 / OIDC provider behind an HttpClient, for unit tests
 * of the device flow and token refresh: no network. Access tokens are
 * unsigned JWT-shaped strings whose payload carries `exp` (the client never
 * verifies them; the server does). Refresh tokens can be revoked, and the
 * token endpoint can be made to fail.
 */
export class InMemoryIdentityProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly requests: HttpRequest[] = [];
  /** Refresh-grant requests served, successful or not. */
  refreshes = 0;
  /** The next token-endpoint requests fail this way, one per entry. */
  readonly tokenFailures: ("network" | "server-error" | "slow_down")[] = [];
  /** Resolves pending refresh requests one at a time when set; see holdRefreshes. */
  private held: (() => void)[] | undefined;
  private readonly accessTokenLifetime: number;
  private readonly rotate: boolean;
  private readonly deviceCodeLifetime: number;
  private readonly interval: number | undefined;
  private readonly now: () => number;
  private readonly devices = new Map<string, DeviceGrant>();
  private readonly refreshTokens = new Set<string>();
  private counter = 0;

  constructor(options: InMemoryIdentityProviderOptions = {}) {
    this.issuer = options.issuer ?? "https://idp.example/application/o/vault-sync/";
    this.clientId = options.clientId ?? "vault-sync";
    this.accessTokenLifetime = options.accessTokenLifetime ?? 300;
    this.rotate = options.rotateRefreshTokens ?? false;
    this.deviceCodeLifetime = options.deviceCodeLifetime ?? 600;
    this.interval = options.interval;
    this.now = options.now ?? Date.now;
  }

  readonly http: HttpClient = async (request) => {
    this.requests.push(request);
    const url = new URL(request.url);
    const base = this.issuer.replace(/\/+$/, "");
    if (request.method === "GET" && request.url === `${base}/.well-known/openid-configuration`) {
      return json(200, {
        issuer: this.issuer,
        device_authorization_endpoint: `${new URL(this.issuer).origin}/device`,
        token_endpoint: `${new URL(this.issuer).origin}/token`,
      });
    }
    if (request.method !== "POST") return json(404, {});
    const form = new URLSearchParams(request.body ?? "");
    if (url.pathname === "/device") return this.authorizeDevice(form);
    if (url.pathname === "/token") return this.token(form);
    return json(404, {});
  };

  /** The user approves the device authorization showing `userCode`. */
  approve(userCode: string): void {
    this.grantFor(userCode).state = "approved";
  }

  /** The user denies the device authorization showing `userCode`. */
  deny(userCode: string): void {
    this.grantFor(userCode).state = "denied";
  }

  /** Revokes every refresh token (an administrator ended the user's sessions). */
  revokeAll(): void {
    this.refreshTokens.clear();
  }

  /** Whether `token` is a currently valid refresh token. */
  isValidRefreshToken(token: string): boolean {
    return this.refreshTokens.has(token);
  }

  /** Issues tokens directly, as a completed sign-in would. */
  issue(): { accessToken: string; refreshToken: string } {
    return { accessToken: this.accessToken(), refreshToken: this.refreshToken() };
  }

  /** From now on, refresh requests wait until release() is called. */
  holdRefreshes(): void {
    this.held ??= [];
  }

  /** Lets every held refresh request proceed, and stops holding them. */
  release(): void {
    const held = this.held ?? [];
    this.held = undefined;
    for (const resume of held) resume();
  }

  private grantFor(userCode: string): DeviceGrant {
    for (const grant of this.devices.values()) if (grant.userCode === userCode) return grant;
    throw new Error(`no device authorization shows user code ${userCode}`);
  }

  private authorizeDevice(form: URLSearchParams): HttpResponse {
    if (form.get("client_id") !== this.clientId) return json(401, { error: "invalid_client" });
    const deviceCode = `device-code-${String(++this.counter)}`;
    const userCode = `USER-${String(this.counter).padStart(4, "0")}`;
    this.devices.set(deviceCode, { userCode, expiresAt: this.now() + this.deviceCodeLifetime * 1000, state: "pending" });
    return json(200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${new URL(this.issuer).origin}/device`,
      verification_uri_complete: `${new URL(this.issuer).origin}/device?code=${userCode}`,
      expires_in: this.deviceCodeLifetime,
      ...(this.interval === undefined ? {} : { interval: this.interval }),
    });
  }

  private async token(form: URLSearchParams): Promise<HttpResponse> {
    if (form.get("grant_type") === "refresh_token") this.refreshes++;
    const failure = this.tokenFailures.shift();
    if (failure === "network") throw new Error("connection reset");
    if (failure === "server-error") return { status: 502, text: "<html>bad gateway</html>" };
    if (failure === "slow_down") return json(400, { error: "slow_down" });
    if (form.get("client_id") !== this.clientId) return json(401, { error: "invalid_client" });
    switch (form.get("grant_type")) {
      case "urn:ietf:params:oauth:grant-type:device_code":
        return this.redeemDevice(form.get("device_code") ?? "");
      case "refresh_token":
        if (this.held !== undefined) await new Promise<void>((resolve) => this.held?.push(resolve));
        return this.redeemRefresh(form.get("refresh_token") ?? "");
      default:
        return json(400, { error: "unsupported_grant_type" });
    }
  }

  private redeemDevice(deviceCode: string): HttpResponse {
    const grant = this.devices.get(deviceCode);
    if (grant === undefined) return json(400, { error: "invalid_grant" });
    if (this.now() >= grant.expiresAt) return json(400, { error: "expired_token" });
    switch (grant.state) {
      case "pending":
        return json(400, { error: "authorization_pending" });
      case "denied":
        return json(400, { error: "access_denied", error_description: "the user denied the request" });
      case "redeemed":
        return json(400, { error: "invalid_grant" });
      case "approved":
        grant.state = "redeemed";
        return json(200, this.tokenResponse(this.refreshToken()));
    }
  }

  private redeemRefresh(refreshToken: string): HttpResponse {
    if (!this.refreshTokens.has(refreshToken)) return json(400, { error: "invalid_grant", error_description: "Token is not valid" });
    let next = refreshToken;
    if (this.rotate) {
      this.refreshTokens.delete(refreshToken);
      next = this.refreshToken();
    }
    return json(200, this.tokenResponse(next));
  }

  private tokenResponse(refreshToken: string): Record<string, unknown> {
    return { access_token: this.accessToken(), token_type: "Bearer", expires_in: this.accessTokenLifetime, refresh_token: refreshToken };
  }

  private accessToken(): string {
    const payload = { iss: this.issuer, aud: this.clientId, exp: Math.floor(this.now() / 1000) + this.accessTokenLifetime, jti: String(++this.counter) };
    return `${base64Url(JSON.stringify({ alg: "none" }))}.${base64Url(JSON.stringify(payload))}.signature`;
  }

  private refreshToken(): string {
    const token = `refresh-token-${String(++this.counter)}`;
    this.refreshTokens.add(token);
    return token;
  }
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "Content-Type": "application/json" }, text: JSON.stringify(body) };
}

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
