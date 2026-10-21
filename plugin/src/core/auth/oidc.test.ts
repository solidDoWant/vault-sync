import { describe, expect, it, vi } from "vitest";

import { InMemoryIdentityProvider } from "./memory-idp";
import {
  discoverOidc,
  IdentityProviderError,
  jwtExpiry,
  jwtSubject,
  OAuthError,
  oidcRefresher,
  pollDeviceAuthorization,
  refreshAccessToken,
  signInWithDeviceFlow,
  SignInRequiredError,
  startDeviceAuthorization,
  type HttpClient,
} from "./oidc";

/** A fake clock whose sleeps advance it instantly and are recorded. */
function clock(start = 1_000_000) {
  const state: { now: number; sleeps: number[]; onSleep: (count: number) => void } = { now: start, sleeps: [], onSleep: () => undefined };
  return {
    state,
    now: () => state.now,
    sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted();
      state.sleeps.push(ms);
      state.now += ms;
      state.onSleep(state.sleeps.length);
      return Promise.resolve();
    },
  };
}

function staticHttp(status: number, body: unknown): HttpClient {
  return () => Promise.resolve({ status, text: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("discoverOidc", () => {
  it("returns the device authorization and token endpoints of the issuer", async () => {
    const idp = new InMemoryIdentityProvider();

    const endpoints = await discoverOidc(idp.http, idp.issuer);

    expect(endpoints).toEqual({ issuer: idp.issuer, deviceAuthorizationEndpoint: "https://idp.example/device", tokenEndpoint: "https://idp.example/token" });
    expect(idp.requests[0]?.url).toBe("https://idp.example/application/o/vault-sync/.well-known/openid-configuration");
  });

  it("refuses a configuration that names another issuer", async () => {
    const http = staticHttp(200, { issuer: "https://evil.example/", device_authorization_endpoint: "https://evil.example/d", token_endpoint: "https://evil.example/t" });

    await expect(discoverOidc(http, "https://idp.example/")).rejects.toThrow(/names issuer/);
  });

  it("refuses a provider without the device authorization grant", async () => {
    const http = staticHttp(200, { issuer: "https://idp.example/", token_endpoint: "https://idp.example/t" });

    await expect(discoverOidc(http, "https://idp.example/")).rejects.toThrow(/device authorization grant/);
  });

  it("refuses plain http except to a loopback host", async () => {
    const http = staticHttp(200, { issuer: "http://127.0.0.1:9000/", device_authorization_endpoint: "http://127.0.0.1:9000/d", token_endpoint: "http://127.0.0.1:9000/t" });
    await expect(discoverOidc(http, "http://idp.example/")).rejects.toThrow(/must use https/);
    await expect(discoverOidc(http, "http://127.0.0.1:9000/")).resolves.toMatchObject({ tokenEndpoint: "http://127.0.0.1:9000/t" });

    const insecureEndpoint = staticHttp(200, { issuer: "https://idp.example/", device_authorization_endpoint: "https://idp.example/d", token_endpoint: "http://idp.example/t" });
    await expect(discoverOidc(insecureEndpoint, "https://idp.example/")).rejects.toThrow(/token endpoint must use https/);
  });

  it("reports an unreachable provider as an identity provider error", async () => {
    const http: HttpClient = () => Promise.reject(new Error("ECONNREFUSED"));

    await expect(discoverOidc(http, "https://idp.example/")).rejects.toBeInstanceOf(IdentityProviderError);
  });

  it("refuses an oversized response before parsing it", async () => {
    const http = staticHttp(200, `{"issuer":"https://idp.example/","padding":"${"x".repeat(64 * 1024)}"}`);

    await expect(discoverOidc(http, "https://idp.example/")).rejects.toThrow(/larger than/);
  });

  it("bounds the response in UTF-8 bytes, not characters", async () => {
    const configuration = (padding: string) =>
      staticHttp(200, `{"issuer":"https://idp.example/","device_authorization_endpoint":"https://idp.example/d","token_endpoint":"https://idp.example/t","padding":"${padding}"}`);
    const overhead = new TextEncoder().encode(
      `{"issuer":"https://idp.example/","device_authorization_endpoint":"https://idp.example/d","token_endpoint":"https://idp.example/t","padding":""}`,
    ).length;
    const room = 64 * 1024 - overhead;
    // "é" is one UTF-16 code unit but two UTF-8 bytes.
    const exactlyFull = "x".repeat(room % 2) + "é".repeat(Math.floor(room / 2));
    expect(new TextEncoder().encode(exactlyFull).length).toBe(room);

    // Exactly 64 KiB is accepted, one byte more is not.
    await expect(discoverOidc(configuration(exactlyFull), "https://idp.example/")).resolves.toMatchObject({ tokenEndpoint: "https://idp.example/t" });
    await expect(discoverOidc(configuration(`${exactlyFull}x`), "https://idp.example/")).rejects.toThrow(/larger than 65536 bytes/);
    // Far fewer characters than 64 Ki, but more bytes: a character count would let this through.
    await expect(discoverOidc(configuration(`${exactlyFull}é`), "https://idp.example/")).rejects.toThrow(/larger than 65536 bytes/);
  });
});

describe("device authorization", () => {
  it("returns the user code and verification URL to show the user", async () => {
    const time = clock();
    const idp = new InMemoryIdentityProvider({ now: time.now, deviceCodeLifetime: 600, interval: 7 });
    const endpoints = await discoverOidc(idp.http, idp.issuer);

    const authorization = await startDeviceAuthorization(idp.http, endpoints, idp.clientId, { now: time.now });

    expect(authorization).toMatchObject({
      userCode: "USER-0001",
      verificationUri: "https://idp.example/device",
      verificationUriComplete: "https://idp.example/device?code=USER-0001",
      expiresAt: time.state.now + 600_000,
      intervalMs: 7000,
    });
    const form = new URLSearchParams(idp.requests.at(-1)?.body);
    expect(form.get("client_id")).toBe("vault-sync");
    expect(form.get("scope")).toBe("openid offline_access");
  });

  it("defaults the polling interval to five seconds", async () => {
    const idp = new InMemoryIdentityProvider();
    const endpoints = await discoverOidc(idp.http, idp.issuer);

    expect((await startDeviceAuthorization(idp.http, endpoints, idp.clientId)).intervalMs).toBe(5000);
  });

  it("surfaces the provider's error for an unknown client", async () => {
    const idp = new InMemoryIdentityProvider();
    const endpoints = await discoverOidc(idp.http, idp.issuer);

    await expect(startDeviceAuthorization(idp.http, endpoints, "someone-else")).rejects.toMatchObject({ code: "invalid_client" });
  });

  it("polls at the interval until the user approves, then returns the tokens", async () => {
    const time = clock();
    const idp = new InMemoryIdentityProvider({ now: time.now, interval: 5 });
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const authorization = await startDeviceAuthorization(idp.http, endpoints, idp.clientId, { now: time.now });
    time.state.onSleep = (count) => {
      if (count === 3) idp.approve(authorization.userCode);
    };

    const tokens = await pollDeviceAuthorization(idp.http, endpoints, idp.clientId, authorization, { now: time.now, sleep: time.sleep });

    expect(time.state.sleeps).toEqual([5000, 5000, 5000]);
    expect(tokens.refreshToken).toMatch(/^refresh-token-/);
    expect(idp.isValidRefreshToken(tokens.refreshToken ?? "")).toBe(true);
    expect(tokens.obtainedAt).toBe(time.state.now);
    expect(tokens.expiresAt).toBe(Math.floor(time.state.now / 1000) * 1000 + 300_000);
    const polls = idp.requests.filter((request) => request.url.endsWith("/token")).map((request) => new URLSearchParams(request.body));
    expect(polls).toHaveLength(3);
    expect(polls.every((form) => form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code" && form.get("device_code") === authorization.deviceCode)).toBe(true);
  });

  it("adds five seconds to the interval each time the provider asks it to slow down", async () => {
    const time = clock();
    const idp = new InMemoryIdentityProvider({ now: time.now, interval: 5 });
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const authorization = await startDeviceAuthorization(idp.http, endpoints, idp.clientId, { now: time.now });
    idp.tokenFailures.push("slow_down", "slow_down");
    time.state.onSleep = (count) => {
      if (count === 3) idp.approve(authorization.userCode);
    };

    await pollDeviceAuthorization(idp.http, endpoints, idp.clientId, authorization, { now: time.now, sleep: time.sleep });

    expect(time.state.sleeps).toEqual([5000, 10_000, 15_000]);
  });

  it("keeps polling through network failures and server errors", async () => {
    const time = clock();
    const idp = new InMemoryIdentityProvider({ now: time.now });
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const authorization = await startDeviceAuthorization(idp.http, endpoints, idp.clientId, { now: time.now });
    idp.tokenFailures.push("network", "server-error");
    idp.approve(authorization.userCode);

    const tokens = await pollDeviceAuthorization(idp.http, endpoints, idp.clientId, authorization, { now: time.now, sleep: time.sleep });

    expect(tokens.accessToken).not.toBe("");
    expect(time.state.sleeps).toHaveLength(3);
  });

  it("fails with access_denied when the user denies the request", async () => {
    const time = clock();
    const idp = new InMemoryIdentityProvider({ now: time.now });
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const authorization = await startDeviceAuthorization(idp.http, endpoints, idp.clientId, { now: time.now });
    idp.deny(authorization.userCode);

    const polling = pollDeviceAuthorization(idp.http, endpoints, idp.clientId, authorization, { now: time.now, sleep: time.sleep });

    await expect(polling).rejects.toBeInstanceOf(OAuthError);
    await expect(polling).rejects.toMatchObject({ code: "access_denied" });
  });

  it("fails with expired_token once the code expires, without polling past it", async () => {
    const time = clock();
    const idp = new InMemoryIdentityProvider({ now: time.now, deviceCodeLifetime: 12, interval: 5 });
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const authorization = await startDeviceAuthorization(idp.http, endpoints, idp.clientId, { now: time.now });

    await expect(pollDeviceAuthorization(idp.http, endpoints, idp.clientId, authorization, { now: time.now, sleep: time.sleep })).rejects.toMatchObject({
      code: "expired_token",
    });
    // Polls at 5 s and 10 s; at 15 s the code has expired, so the third poll is never sent.
    expect(idp.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
  });

  it("stops polling when cancelled", async () => {
    const time = clock();
    const idp = new InMemoryIdentityProvider({ now: time.now });
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const authorization = await startDeviceAuthorization(idp.http, endpoints, idp.clientId, { now: time.now });
    const controller = new AbortController();
    time.state.onSleep = (count) => {
      if (count === 2) controller.abort(new Error("cancelled by the user"));
    };

    await expect(
      pollDeviceAuthorization(idp.http, endpoints, idp.clientId, authorization, { now: time.now, sleep: time.sleep, signal: controller.signal }),
    ).rejects.toThrow("cancelled by the user");
    expect(idp.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
  });

  it("waits on a real timer by default and stops it on cancel", async () => {
    const idp = new InMemoryIdentityProvider({ interval: 3600 });
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const authorization = await startDeviceAuthorization(idp.http, endpoints, idp.clientId);
    const controller = new AbortController();

    const polling = pollDeviceAuthorization(idp.http, endpoints, idp.clientId, authorization, { signal: controller.signal });
    controller.abort(new Error("closed"));

    await expect(polling).rejects.toThrow("closed");
    expect(idp.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(0);
  });
});

describe("refreshAccessToken", () => {
  it("exchanges a valid refresh token for a new access token", async () => {
    const idp = new InMemoryIdentityProvider();
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const { refreshToken } = idp.issue();

    const tokens = await refreshAccessToken(idp.http, endpoints, idp.clientId, refreshToken);

    expect(tokens.accessToken.split(".")).toHaveLength(3);
    const form = new URLSearchParams(idp.requests.at(-1)?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(refreshToken);
  });

  it("requires a new sign-in when the provider refuses the refresh token", async () => {
    const idp = new InMemoryIdentityProvider();
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const { refreshToken } = idp.issue();
    idp.revokeAll();

    const refresh = refreshAccessToken(idp.http, endpoints, idp.clientId, refreshToken);

    await expect(refresh).rejects.toBeInstanceOf(SignInRequiredError);
    // The token is a secret: the error never repeats it.
    await expect(refresh).rejects.not.toThrow(refreshToken);
  });

  it("reports provider outages as identity provider errors, not as a need to sign in", async () => {
    const idp = new InMemoryIdentityProvider();
    const endpoints = await discoverOidc(idp.http, idp.issuer);
    const { refreshToken } = idp.issue();
    idp.tokenFailures.push("server-error", "network");

    await expect(refreshAccessToken(idp.http, endpoints, idp.clientId, refreshToken)).rejects.toBeInstanceOf(IdentityProviderError);
    await expect(refreshAccessToken(idp.http, endpoints, idp.clientId, refreshToken)).rejects.toBeInstanceOf(IdentityProviderError);
  });

  it("reports a provider that never answers as unreachable after 30 s, not before (#730)", async () => {
    vi.useFakeTimers();
    try {
      const silent: HttpClient = () => new Promise(() => undefined);
      let failure: unknown;
      void refreshAccessToken(silent, { issuer: "", deviceAuthorizationEndpoint: "", tokenEndpoint: "https://idp.example/t" }, "c", "r").catch((error: unknown) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toBeInstanceOf(IdentityProviderError);
      expect((failure as IdentityProviderError).unreachable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the expiry from expires_in when the access token is not a JWT", async () => {
    const http = staticHttp(200, { access_token: "opaque", expires_in: 120 });

    const tokens = await refreshAccessToken(http, { issuer: "", deviceAuthorizationEndpoint: "", tokenEndpoint: "https://idp.example/t" }, "c", "r", { now: () => 5000 });

    expect(tokens).toEqual({ accessToken: "opaque", obtainedAt: 5000, expiresAt: 125_000 });
  });
});

describe("signInWithDeviceFlow", () => {
  it("shows the user code, then returns the tokens once the user approves it", async () => {
    const time = clock();
    const idp = new InMemoryIdentityProvider({ now: time.now });
    const shown: string[] = [];

    const tokens = await signInWithDeviceFlow(
      idp.http,
      { issuer: idp.issuer, clientId: idp.clientId },
      {
        now: time.now,
        sleep: time.sleep,
        onAuthorization: (authorization) => {
          shown.push(`${authorization.verificationUri} ${authorization.userCode}`);
          // The user enters the code in a browser.
          idp.approve(authorization.userCode);
        },
      },
    );

    expect(shown).toEqual(["https://idp.example/device USER-0001"]);
    expect(idp.isValidRefreshToken(tokens.refreshToken ?? "")).toBe(true);
  });
});

describe("oidcRefresher", () => {
  it("discovers the provider once and refreshes against its token endpoint", async () => {
    const idp = new InMemoryIdentityProvider();
    const refresh = oidcRefresher(idp.http, { issuer: idp.issuer, clientId: idp.clientId });
    const { refreshToken } = idp.issue();

    await refresh(refreshToken);
    await refresh(refreshToken);

    expect(idp.requests.map((request) => new URL(request.url).pathname)).toEqual(["/application/o/vault-sync/.well-known/openid-configuration", "/token", "/token"]);
  });

  it("tries discovery again after it failed", async () => {
    const idp = new InMemoryIdentityProvider();
    let down = true;
    const http: HttpClient = (request) => (down ? Promise.reject(new Error("offline")) : idp.http(request));
    const refresh = oidcRefresher(http, { issuer: idp.issuer, clientId: idp.clientId });
    const { refreshToken } = idp.issue();

    await expect(refresh(refreshToken)).rejects.toBeInstanceOf(IdentityProviderError);
    down = false;

    await expect(refresh(refreshToken)).resolves.toHaveProperty("accessToken");
  });
});

describe("jwtExpiry", () => {
  it("reads exp from a JWT payload in milliseconds", () => {
    const payload = btoa(JSON.stringify({ exp: 1_700_000_000 })).replace(/=+$/, "");
    expect(jwtExpiry(`e30.${payload}.sig`)).toBe(1_700_000_000_000);
  });

  it("returns undefined for anything else", () => {
    expect(jwtExpiry("opaque")).toBeUndefined();
    expect(jwtExpiry("a.!!!.c")).toBeUndefined();
    expect(jwtExpiry(`e30.${btoa(JSON.stringify({ exp: "soon" }))}.sig`)).toBeUndefined();
  });
});

describe("jwtSubject", () => {
  it("reads sub from a JWT payload", () => {
    const payload = btoa(JSON.stringify({ sub: "user-42", exp: 1 })).replace(/=+$/, "");
    expect(jwtSubject(`e30.${payload}.sig`)).toBe("user-42");
  });

  it("returns undefined for a token without a usable sub", () => {
    expect(jwtSubject("opaque")).toBeUndefined();
    expect(jwtSubject(`e30.${btoa(JSON.stringify({ sub: "" }))}.sig`)).toBeUndefined();
    expect(jwtSubject(`e30.${btoa(JSON.stringify({ sub: 42 }))}.sig`)).toBeUndefined();
  });
});
