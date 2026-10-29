import { describe, expect, it } from "vitest";

import { InMemoryIdentityProvider } from "./memory-idp";
import { IdentityProviderError, refreshAccessToken, SignInRequiredError, type OidcEndpoints } from "./oidc";
import { TokenManager, type AuthState, type TokenManagerOptions } from "./tokens";

const endpoints: OidcEndpoints = {
  issuer: "https://idp.example/application/o/vault-sync/",
  deviceAuthorizationEndpoint: "https://idp.example/device",
  tokenEndpoint: "https://idp.example/token",
};

/** A token manager over an in-memory provider and a fake clock, recording what it persists and its state changes. */
function setup(options: { lifetime?: number; rotate?: boolean; signedIn?: boolean; manager?: Partial<TokenManagerOptions> } = {}) {
  const time = { now: 1_000_000_000 };
  const now = () => time.now;
  const idp = new InMemoryIdentityProvider({ now, accessTokenLifetime: options.lifetime ?? 300, rotateRefreshTokens: options.rotate ?? false });
  const persisted: (string | undefined)[] = [];
  const states: AuthState[] = [];
  const stored = options.signedIn === false ? undefined : idp.issue().refreshToken;
  const manager = new TokenManager({
    ...(stored === undefined ? {} : { refreshToken: stored }),
    refresh: (refreshToken) => refreshAccessToken(idp.http, endpoints, idp.clientId, refreshToken, { now }),
    persist: (token) => {
      persisted.push(token);
      return Promise.resolve();
    },
    onStateChange: (state) => states.push(state),
    now,
    ...options.manager,
  });
  return { time, idp, manager, persisted, states, stored };
}

describe("TokenManager", () => {
  it("starts signed out without a stored refresh token and asks for a sign-in instead of calling the provider", async () => {
    const { manager, idp } = setup({ signedIn: false });

    expect(manager.state).toBe("signed-out");
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
    expect(idp.refreshes).toBe(0);
  });

  it("starts needing a sign-in when the device signed in before but its refresh token is gone, without calling the provider", async () => {
    const { manager, idp } = setup({ signedIn: false, manager: { signInRequired: true } });

    expect(manager.state).toBe("sign-in-required");
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
    expect(idp.refreshes).toBe(0);
  });

  it("gets an access token with the stored refresh token and reuses it while it is fresh", async () => {
    const { manager, idp } = setup();
    expect(manager.state).toBe("signed-in");

    const first = await manager.accessToken();
    const second = await manager.accessToken();

    expect(second).toBe(first);
    expect(idp.refreshes).toBe(1);
  });

  it("refreshes the access token a minute before it expires", async () => {
    const { manager, idp, time } = setup({ lifetime: 300 });
    const first = await manager.accessToken();
    const issuedAt = time.now;

    // Still more than 60 s left: the cached token is used.
    time.now = issuedAt + 239_999;
    expect(await manager.accessToken()).toBe(first);
    expect(idp.refreshes).toBe(1);

    // 60 s before exp: refreshed ahead of expiry.
    time.now = issuedAt + 240_000;
    const second = await manager.accessToken();
    expect(second).not.toBe(first);
    expect(idp.refreshes).toBe(2);
  });

  it("refreshes a short-lived token halfway through its lifetime", async () => {
    const { manager, idp, time } = setup({ lifetime: 60 });
    const first = await manager.accessToken();
    const issuedAt = time.now;

    time.now = issuedAt + 29_999;
    expect(await manager.accessToken()).toBe(first);
    time.now = issuedAt + 30_000;
    expect(await manager.accessToken()).not.toBe(first);
    expect(idp.refreshes).toBe(2);
  });

  it("shares one refresh among concurrent callers", async () => {
    const { manager, idp } = setup();
    idp.holdRefreshes();

    const calls = Array.from({ length: 5 }, () => manager.accessToken());
    await Promise.resolve();
    idp.release();
    const tokens = await Promise.all(calls);

    expect(new Set(tokens).size).toBe(1);
    expect(idp.refreshes).toBe(1);
  });

  it("refreshes once after the server refuses a token, however many requests carried it", async () => {
    const { manager, idp } = setup();
    const refused = await manager.accessToken();

    manager.invalidate(refused);
    manager.invalidate(refused);
    const fresh = await manager.accessToken();
    // A late report about the old token does not throw the new one away.
    manager.invalidate(refused);

    expect(fresh).not.toBe(refused);
    expect(await manager.accessToken()).toBe(fresh);
    expect(idp.refreshes).toBe(2);
  });

  it("stores a rotated refresh token before handing out the access token it came with", async () => {
    const order: string[] = [];
    const { manager, idp, stored } = setup({
      rotate: true,
      manager: {
        persist: (token) => {
          order.push(`persist ${String(token)}`);
          return Promise.resolve();
        },
      },
    });

    const token = await manager.accessToken();
    order.push("token");

    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/^persist refresh-token-/);
    expect(order[0]).not.toBe(`persist ${String(stored)}`);
    expect(order[1]).toBe("token");
    expect(idp.isValidRefreshToken(stored ?? "")).toBe(false);
    expect(token).not.toBe("");
    // The rotated token is the one used next.
    manager.invalidate(token);
    await manager.accessToken();
    expect(idp.refreshes).toBe(2);
  });

  it("moves to sign-in-required and forgets the refresh token when the provider revokes it", async () => {
    const { manager, idp, persisted, states } = setup();
    idp.revokeAll();

    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);

    expect(manager.state).toBe("sign-in-required");
    expect(states).toEqual(["sign-in-required"]);
    expect(persisted).toEqual([undefined]);
    // Later requests fail at once, without asking the provider again.
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
    expect(idp.refreshes).toBe(1);
  });

  it("stays signed in through a provider outage and retries on the next request", async () => {
    const { manager, idp } = setup();
    idp.tokenFailures.push("network");

    await expect(manager.accessToken()).rejects.toBeInstanceOf(IdentityProviderError);
    expect(manager.state).toBe("signed-in");

    await expect(manager.accessToken()).resolves.not.toBe("");
    expect(idp.refreshes).toBe(2);
  });

  it("signs in again after a revocation and uses the new tokens", async () => {
    const { manager, idp, persisted, states } = setup();
    idp.revokeAll();
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);

    const issued = idp.issue();
    await manager.signIn({ accessToken: issued.accessToken, refreshToken: issued.refreshToken, obtainedAt: 1_000_000_000, expiresAt: 1_000_300_000 });

    expect(manager.state).toBe("signed-in");
    expect(states).toEqual(["sign-in-required", "signed-in"]);
    expect(persisted).toEqual([undefined, issued.refreshToken]);
    expect(await manager.accessToken()).toBe(issued.accessToken);
    expect(idp.refreshes).toBe(1);
  });

  it("never hands out the previous session's access token while a sign-in on a signed-in manager is being stored", async () => {
    let releaseWrite: (() => void) | undefined;
    const { manager, idp, time } = setup({
      manager: {
        persist: () => new Promise<void>((resolve) => (releaseWrite = resolve)),
      },
    });
    const previous = await manager.accessToken();
    expect(idp.refreshes).toBe(1);

    const issued = idp.issue();
    const signedIn = manager.signIn({ accessToken: issued.accessToken, refreshToken: issued.refreshToken, obtainedAt: time.now, expiresAt: time.now + 300_000 });
    await settle();
    expect(releaseWrite).toBeDefined();

    // While the write is held, neither the cached token nor a refresh with the old refresh token is used.
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
    expect(idp.refreshes).toBe(1);

    releaseWrite?.();
    await signedIn;
    expect(manager.state).toBe("signed-in");
    const current = await manager.accessToken();
    expect(current).toBe(issued.accessToken);
    expect(current).not.toBe(previous);
  });

  it("never hands a refresh that a sign-in overtook the previous session's access token", async () => {
    let releaseWrite: (() => void) | undefined;
    const { manager, idp, time } = setup({
      manager: {
        persist: () => new Promise<void>((resolve) => (releaseWrite = resolve)),
      },
    });
    await manager.accessToken();
    // Within the refresh margin: the old token is still cached, but the next call refreshes.
    time.now += 250_000;

    idp.holdRefreshes();
    const refreshing = manager.accessToken();
    await settle();
    const issued = idp.issue();
    const signedIn = manager.signIn({ accessToken: issued.accessToken, refreshToken: issued.refreshToken, obtainedAt: time.now, expiresAt: time.now + 300_000 });
    idp.release();

    // The overtaken refresh settles while the sign-in's write is still held.
    await expect(refreshing).rejects.toBeInstanceOf(SignInRequiredError);
    releaseWrite?.();
    await signedIn;
    expect(await manager.accessToken()).toBe(issued.accessToken);
  });

  it("is signed out, not signed in with no tokens, when storing a sign-in on a signed-in manager fails", async () => {
    const { manager, idp, states } = setup({
      manager: { persist: () => Promise.reject(new Error("disk full")) },
    });
    await manager.accessToken();

    const issued = idp.issue();
    await expect(manager.signIn({ accessToken: issued.accessToken, refreshToken: issued.refreshToken, obtainedAt: 1_000_000_000 })).rejects.toThrow(/disk full/);

    expect(manager.state).toBe("signed-out");
    expect(states).toEqual(["signed-out"]);
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
  });

  it("removes the previous session's refresh token from disk when storing a sign-in on a signed-in manager fails, so a restart is signed out too", async () => {
    // What is on disk: a failed write leaves it as it was.
    const disk: { token: string | undefined } = { token: undefined };
    const { manager, idp, stored } = setup({
      manager: {
        persist: (token) => {
          if (token !== undefined) return Promise.reject(new Error("disk full"));
          disk.token = token;
          return Promise.resolve();
        },
      },
    });
    disk.token = stored;
    await manager.accessToken();

    const issued = idp.issue();
    await expect(manager.signIn({ accessToken: issued.accessToken, refreshToken: issued.refreshToken, obtainedAt: 1_000_000_000 })).rejects.toThrow(/disk full/);

    expect(manager.state).toBe("signed-out");
    expect(disk.token).toBeUndefined();
    const restarted = new TokenManager({ ...(disk.token === undefined ? {} : { refreshToken: disk.token }), refresh: () => Promise.reject(new Error("unused")), persist: () => Promise.resolve() });
    expect(restarted.state).toBe(manager.state);
  });

  it("does not report a failed sign-in until the previous session's refresh token is removed from disk", async () => {
    // What is on disk: a failed write leaves it as it was; the removal lands when it is released.
    const disk: { token: string | undefined } = { token: undefined };
    let releaseRemoval: (() => void) | undefined;
    const { manager, idp, stored } = setup({
      manager: {
        persist: (token) => {
          if (token !== undefined) return Promise.reject(new Error("disk full"));
          return new Promise<void>((resolve) => {
            releaseRemoval = () => {
              disk.token = token;
              resolve();
            };
          });
        },
      },
    });
    disk.token = stored;
    await manager.accessToken();

    const issued = idp.issue();
    let settled = false;
    const signingIn = manager.signIn({ accessToken: issued.accessToken, refreshToken: issued.refreshToken, obtainedAt: 1_000_000_000 });
    signingIn.then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();

    // The removal is held: the sign-in has not settled and the old refresh token is still on disk.
    expect(releaseRemoval).toBeDefined();
    expect(settled).toBe(false);
    expect(disk.token).toBe(stored);

    releaseRemoval?.();
    await expect(signingIn).rejects.toThrow(/disk full/);
    expect(disk.token).toBeUndefined();
  });

  it("still rejects with the sign-in's own error when removing the previous refresh token after it fails too", async () => {
    const { manager, idp, states } = setup({
      manager: { persist: (token) => Promise.reject(new Error(token === undefined ? "removal failed" : "disk full")) },
    });
    await manager.accessToken();

    const issued = idp.issue();
    await expect(manager.signIn({ accessToken: issued.accessToken, refreshToken: issued.refreshToken, obtainedAt: 1_000_000_000 })).rejects.toThrow(/disk full/);
    expect(manager.state).toBe("signed-out");
    expect(states).toEqual(["signed-out"]);
  });

  it("refuses a sign-in that issued no refresh token", async () => {
    const { manager, persisted } = setup({ signedIn: false });

    await expect(manager.signIn({ accessToken: "a", obtainedAt: 0 })).rejects.toThrow(/offline_access/);
    expect(manager.state).toBe("signed-out");
    expect(persisted).toEqual([]);
  });

  it("drops the result of a refresh that was still running when the user signed out", async () => {
    const { manager, idp, persisted } = setup();
    idp.holdRefreshes();

    const pending = manager.accessToken();
    await Promise.resolve();
    await manager.signOut();
    idp.release();

    await expect(pending).rejects.toBeInstanceOf(SignInRequiredError);
    expect(manager.state).toBe("signed-out");
    expect(persisted).toEqual([undefined]);
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
  });

  it("drops a refresh whose rotated refresh token was still being stored when the user signed out", async () => {
    // What is on disk: each write lands when its persist call completes.
    const disk: { token: string | undefined } = { token: undefined };
    let releaseRotated: (() => void) | undefined;
    const { manager, stored } = setup({
      rotate: true,
      manager: {
        persist: (token) => {
          if (releaseRotated !== undefined || token === undefined) {
            disk.token = token;
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            releaseRotated = () => {
              disk.token = token;
              resolve();
            };
          });
        },
      },
    });
    disk.token = stored;

    const pending = manager.accessToken();
    await settle();
    expect(releaseRotated).toBeDefined();
    const signedOut = manager.signOut();
    releaseRotated?.();
    await signedOut;

    await expect(pending).rejects.toBeInstanceOf(SignInRequiredError);
    expect(manager.state).toBe("signed-out");
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
    // The sign-out's removal is the last write: the old session's rotated token is not left on disk.
    expect(disk.token).toBeUndefined();
  });

  it("never stores the rotated refresh token of a refresh that a sign-out overtook", async () => {
    const { manager, idp, persisted, stored } = setup({ rotate: true });
    idp.holdRefreshes();

    const pending = manager.accessToken();
    await settle();
    expect(idp.refreshes).toBe(1);
    await manager.signOut();
    idp.release();

    await expect(pending).rejects.toBeInstanceOf(SignInRequiredError);
    // The provider did rotate: the stored token is spent, a new one was issued.
    expect(idp.isValidRefreshToken(stored ?? "")).toBe(false);
    expect(persisted).toEqual([undefined]);
    expect(manager.state).toBe("signed-out");
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
  });

  it("fails a sign-in that a sign-out overtook while its refresh token was being stored, and the sign-out's removal is the last write", async () => {
    const writes: (string | undefined)[] = [];
    let releaseFirst: (() => void) | undefined;
    const { manager, idp } = setup({
      manager: {
        persist: (token) => {
          writes.push(token);
          if (writes.length === 1) return new Promise<void>((resolve) => (releaseFirst = resolve));
          return Promise.resolve();
        },
      },
    });
    // A sign-in whose write is held. It already forgot the previous session's
    // refresh token, so a call meanwhile does not refresh with it.
    const issued = idp.issue();
    const signedIn = manager.signIn({ accessToken: issued.accessToken, refreshToken: issued.refreshToken, obtainedAt: 1_000_000_000 });
    const pending = expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
    await settle();
    expect(idp.refreshes).toBe(0);
    const signedOut = manager.signOut();
    releaseFirst?.();

    await expect(signedIn).rejects.toThrow(/signed out/);
    await signedOut;
    await pending;
    expect(writes).toEqual([issued.refreshToken, undefined]);
    expect(manager.state).toBe("signed-out");
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SignInRequiredError);
  });
});

/** Lets every pending promise callback run: the provider and persist fakes never wait on timers. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
