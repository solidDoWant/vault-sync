import { SignInRequiredError, type TokenSet } from "./oidc";

/**
 * Whether the device can authenticate: `signed-out` (it never signed in, or
 * signed out), `signed-in`, or `sign-in-required` (the refresh token stopped
 * working; sync pauses until the user signs in again).
 */
export type AuthState = "signed-out" | "signed-in" | "sign-in-required";

export interface TokenManagerOptions {
  /** The stored refresh token, if the device signed in before. */
  refreshToken?: string;
  /** Exchanges a refresh token for new tokens (refreshAccessToken bound to the provider). */
  refresh: (refreshToken: string) => Promise<TokenSet>;
  /**
   * Stores the refresh token (undefined removes it). It is called, and
   * awaited, before a new or rotated refresh token is used, so a token the
   * provider rotated is never lost to a crash.
   */
  persist: (refreshToken: string | undefined) => Promise<void>;
  /** Called after every change of `state`. */
  onStateChange?: (state: AuthState) => void;
  now?: () => number;
  /**
   * How long before the access token's expiry it is refreshed, in
   * milliseconds, so a request never carries a token that expires on the way.
   * At most half the token's lifetime is used. Defaults to 60 seconds.
   */
  refreshMarginMs?: number;
}

interface CachedToken {
  token: string;
  /** When to refresh it, in milliseconds since the epoch; undefined if its expiry is unknown. */
  refreshAt: number | undefined;
}

const defaultRefreshMarginMs = 60_000;

/**
 * Holds the device's tokens (SPEC.md §9.1): the refresh token, persisted in
 * plugin data, and the current access token, in memory only. accessToken()
 * refreshes ahead of expiry, and concurrent callers share one refresh. A
 * refresh refused with `invalid_grant` drops the refresh token and moves to
 * `sign-in-required`; nothing else (in particular no local change) is
 * discarded, so sync resumes after the next sign-in.
 */
export class TokenManager {
  private refreshToken: string | undefined;
  private cached: CachedToken | undefined;
  private refreshing: Promise<string> | undefined;
  /** Bumped by every sign-in and sign-out, so a refresh that started before one never overwrites its result. */
  private generation = 0;
  private current: AuthState;
  private readonly refresh: (refreshToken: string) => Promise<TokenSet>;
  private readonly persist: (refreshToken: string | undefined) => Promise<void>;
  private readonly onStateChange: (state: AuthState) => void;
  private readonly now: () => number;
  private readonly refreshMarginMs: number;

  constructor(options: TokenManagerOptions) {
    this.refreshToken = options.refreshToken === "" ? undefined : options.refreshToken;
    this.current = this.refreshToken === undefined ? "signed-out" : "signed-in";
    this.refresh = options.refresh;
    this.persist = options.persist;
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.refreshMarginMs = options.refreshMarginMs ?? defaultRefreshMarginMs;
  }

  get state(): AuthState {
    return this.current;
  }

  /** Records the tokens of a completed sign-in. A grant without a refresh token is refused: the device could not stay signed in. */
  async signIn(tokens: TokenSet): Promise<void> {
    if (tokens.refreshToken === undefined) {
      throw new Error("the identity provider issued no refresh token; allow the offline_access scope for this client");
    }
    this.generation++;
    this.refreshing = undefined;
    await this.persist(tokens.refreshToken);
    this.refreshToken = tokens.refreshToken;
    this.cached = this.cache(tokens);
    this.setState("signed-in");
  }

  /** Forgets both tokens. */
  async signOut(): Promise<void> {
    this.generation++;
    this.refreshing = undefined;
    this.refreshToken = undefined;
    this.cached = undefined;
    await this.persist(undefined);
    this.setState("signed-out");
  }

  /**
   * A valid access token: the cached one unless it is within the refresh
   * margin of its expiry (or invalidated), else a fresh one. Rejects with
   * SignInRequiredError when there is no working refresh token, and with the
   * provider's error when a refresh fails for another reason (a network
   * failure, say), after which the next call tries again.
   */
  accessToken(): Promise<string> {
    const cached = this.cached;
    if (cached !== undefined && (cached.refreshAt === undefined || this.now() < cached.refreshAt)) return Promise.resolve(cached.token);
    if (this.refreshing === undefined) {
      const run: Promise<string> = this.refreshOnce().finally(() => {
        if (this.refreshing === run) this.refreshing = undefined;
      });
      this.refreshing = run;
    }
    return this.refreshing;
  }

  /**
   * Reports that the server refused `token` as unauthenticated (it expired
   * early, or the clock is off), so the next accessToken() refreshes. A token
   * that was already replaced is ignored, so many requests failing with the
   * same token cause one refresh.
   */
  invalidate(token: string): void {
    if (this.cached?.token === token) this.cached = undefined;
  }

  private async refreshOnce(): Promise<string> {
    const generation = this.generation;
    const refreshToken = this.refreshToken;
    if (refreshToken === undefined) {
      throw new SignInRequiredError(this.current === "sign-in-required" ? "sign-in required: the identity provider ended the session" : "not signed in");
    }
    let tokens: TokenSet;
    try {
      tokens = await this.refresh(refreshToken);
    } catch (error) {
      if (error instanceof SignInRequiredError && generation === this.generation) await this.requireSignIn();
      throw error;
    }
    if (generation !== this.generation) {
      // Signed out, or signed in again, while this refresh ran: its tokens
      // belong to the old session and are dropped.
      if (this.cached !== undefined) return this.cached.token;
      throw new SignInRequiredError("not signed in");
    }
    if (tokens.refreshToken !== undefined && tokens.refreshToken !== refreshToken) {
      // Rotated: the provider may already refuse the old one, so the new
      // one is stored before anything relies on it.
      this.refreshToken = tokens.refreshToken;
      await this.persist(tokens.refreshToken);
    }
    this.cached = this.cache(tokens);
    return tokens.accessToken;
  }

  /** The refresh token stopped working: forget it and wait for the user to sign in again. */
  private async requireSignIn(): Promise<void> {
    this.generation++;
    this.refreshToken = undefined;
    this.cached = undefined;
    this.setState("sign-in-required");
    try {
      await this.persist(undefined);
    } catch {
      // A dead token left on disk is refused again on the next start; the
      // state change above is what pauses sync.
    }
  }

  private cache(tokens: TokenSet): CachedToken {
    if (tokens.expiresAt === undefined) return { token: tokens.accessToken, refreshAt: undefined };
    const lifetime = Math.max(0, tokens.expiresAt - tokens.obtainedAt);
    return { token: tokens.accessToken, refreshAt: tokens.expiresAt - Math.min(this.refreshMarginMs, lifetime / 2) };
  }

  private setState(state: AuthState): void {
    if (this.current === state) return;
    this.current = state;
    this.onStateChange(state);
  }
}
