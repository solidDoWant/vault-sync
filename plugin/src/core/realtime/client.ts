import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { ClientFrameSchema, ErrorCode, ServerFrameSchema, type ServerFrame } from "../../gen/vaultsync/v1/realtime_pb";

// The realtime channel's client (SPEC.md §6.4): one WebSocket that tells the
// device a vault changed, so it pulls without waiting for its pull timer. It
// is a latency optimization only. Every notification makes the caller pull
// from its durable cursor, so a lost notification, a dropped connection or a
// missed reconnect only delays a change until the next pull.

/** The subprotocol both sides speak; the server echoes only this one. */
export const realtimeSubprotocol = "vaultsync.v1";
/** Prefix of the subprotocol that carries the access token (browsers cannot set headers on a WebSocket request). */
export const bearerSubprotocolPrefix = "vaultsync.bearer.";
/** The realtime endpoint's path, under the server's base URL. */
export const realtimePath = "/v1/realtime";

/** WebSocket close codes the client tells apart in its log. */
export const closeCodes = {
  normal: 1000,
  goingAway: 1001,
  /** No close frame: the network dropped, or the upgrade was refused (a browser does not expose the HTTP status). */
  abnormal: 1006,
  policyViolation: 1008,
} as const;

/** What a socket reports to the client. */
export interface RealtimeSocketHandlers {
  open(): void;
  /** A binary message. Text messages are not passed on. */
  message(data: Uint8Array): void;
  /** The socket closed, or never opened (a refused upgrade or a network failure, 1006). Called at most once. */
  close(code: number): void;
}

export interface RealtimeSocket {
  send(data: Uint8Array): void;
  close(): void;
}

/**
 * Opens a socket to the realtime endpoint, offering `protocols`. The endpoint
 * is fixed when the connector is made; the token reaches it only inside
 * `protocols`, so it never appears in a URL. Handlers are called
 * asynchronously, never from within the call, as a WebSocket's events are.
 */
export type RealtimeConnector = (protocols: readonly string[], handlers: RealtimeSocketHandlers) => RealtimeSocket;

export interface RealtimeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeBackoff {
  /** The first reconnect's delay ceiling, in milliseconds; each consecutive failure doubles it. */
  initialMs: number;
  /** The largest delay ceiling, in milliseconds. */
  maxMs: number;
}

export const defaultRealtimeBackoff: Readonly<RealtimeBackoff> = { initialMs: 1000, maxMs: 60_000 };

export interface RealtimeClientOptions {
  vaultId: string;
  connect: RealtimeConnector;
  /** A valid access token (TokenManager.accessToken): refreshed by the token manager, never by the user. */
  accessToken: () => Promise<string>;
  /** Reports that the server refused `token` as expired (TokenManager.invalidate), so the next accessToken() is a fresh one. */
  invalidate?: (token: string) => void;
  /**
   * Pulls from the durable cursor. Called after every (re)subscribe and every
   * notification of the vault, never twice at once: notifications arriving
   * during a pull are coalesced into one more pull after it.
   */
  onChange: () => Promise<unknown>;
  timers?: RealtimeTimers;
  /** Uniform in [0, 1); spreads reconnects out. */
  random?: () => number;
  backoff?: RealtimeBackoff;
  /** Diagnostics. Messages never contain the token. */
  log?: (message: string) => void;
}

const globalTimers: RealtimeTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * The delay before reconnect attempt `failures` (1 for the first): a ceiling
 * that doubles from `initialMs` up to `maxMs`, with "equal jitter" (half the
 * ceiling plus a random part of the other half), so it is never below half
 * the ceiling and never above `maxMs`.
 */
export function reconnectDelay(failures: number, backoff: RealtimeBackoff, random: number): number {
  const ceiling = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.max(0, Math.min(failures - 1, 30)));
  return ceiling / 2 + (ceiling / 2) * Math.min(Math.max(random, 0), 1);
}

/** The realtime endpoint for a server base URL: ws: for http:, wss: for https:. */
export function realtimeUrl(serverUrl: string): string {
  const url = new URL(serverUrl.replace(/\/+$/, "") + realtimePath);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error(`the server URL must be http: or https:, not ${url.protocol}`);
  return url.toString();
}

/**
 * Keeps one realtime subscription to a vault open while started, and calls
 * `onChange` whenever the vault may have changed. Any close reconnects with
 * bounded, jittered backoff (a drain, a refused upgrade, a dropped network,
 * a rate limit); the fatal UNAUTHENTICATED frame first invalidates the token,
 * so the reconnect carries a fresh one. The backoff resets once a subscribe
 * succeeds.
 */
export class RealtimeClient {
  private started = false;
  private stopped = false;
  private socket: RealtimeSocket | undefined;
  /** Bumped by every connect and by stop, so a stale socket's events are ignored. */
  private generation = 0;
  private failures = 0;
  private retry: unknown;
  private pulling = false;
  private again = false;
  private readonly timers: RealtimeTimers;
  private readonly random: () => number;
  private readonly backoff: RealtimeBackoff;
  private readonly log: (message: string) => void;

  constructor(private readonly options: RealtimeClientOptions) {
    this.timers = options.timers ?? globalTimers;
    this.random = options.random ?? Math.random;
    this.backoff = options.backoff ?? defaultRealtimeBackoff;
    this.log =
      options.log ??
      ((message) => {
        console.debug(`vault-sync: ${message}`);
      });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.connect();
  }

  /** Closes the connection for good; no reconnect, and no further onChange call starts. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    if (this.retry !== undefined) this.timers.clearTimeout(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    let token: string;
    try {
      token = await this.options.accessToken();
    } catch {
      // Offline, or sign-in required (the controller stops sync then).
      if (generation === this.generation) this.reconnectLater("no access token");
      return;
    }
    if (generation !== this.generation) return;
    let expired = false;
    const current = () => generation === this.generation;
    const handlers: RealtimeSocketHandlers = {
      open: () => {
        if (!current()) return;
        const frame = create(ClientFrameSchema, { frame: { case: "subscribe", value: { vaultId: this.options.vaultId } } });
        this.socket?.send(toBinary(ClientFrameSchema, frame));
      },
      message: (data) => {
        if (!current()) return;
        let frame: ServerFrame;
        try {
          frame = fromBinary(ServerFrameSchema, data);
        } catch {
          this.log("ignored a malformed realtime frame");
          return;
        }
        if (this.handle(frame)) expired = true;
      },
      close: (code) => {
        if (!current()) return;
        this.socket = undefined;
        this.generation++;
        if (expired) this.options.invalidate?.(token);
        this.reconnectLater(expired ? "access token expired" : `closed with code ${String(code)}`);
      },
    };
    try {
      this.socket = this.options.connect([realtimeSubprotocol, bearerSubprotocolPrefix + token], handlers);
    } catch {
      this.socket = undefined;
      this.reconnectLater("could not open");
    }
  }

  /** Acts on a frame; true if it announces the token's expiry. */
  private handle(frame: ServerFrame): boolean {
    const { vaultId } = this.options;
    switch (frame.frame.case) {
      case "subscribed":
        if (frame.frame.value.vaultId !== vaultId) return false;
        this.failures = 0;
        // Notifications sent before the subscription are gone: pull from the cursor.
        this.changed();
        return false;
      case "vaultChanged":
        if (frame.frame.value.vaultId === vaultId) this.changed();
        return false;
      case "error": {
        const error = frame.frame.value;
        if (error.fatal && error.code === ErrorCode.UNAUTHENTICATED) return true;
        if (!error.fatal && error.vaultId === vaultId) {
          // Not (or no longer) a member, or refused for now: try again later.
          this.generation++;
          const socket = this.socket;
          this.socket = undefined;
          socket?.close();
          this.reconnectLater(`subscription refused (${(ErrorCode[error.code] as string | undefined) ?? String(error.code)})`);
        }
        return false;
      }
      default:
        // A frame type this client does not know (SPEC.md §6.4: receivers ignore them).
        return false;
    }
  }

  private reconnectLater(reason: string): void {
    if (this.stopped) return;
    this.failures++;
    const delay = reconnectDelay(this.failures, this.backoff, this.random());
    this.log(`realtime connection ${reason}; reconnecting in ${String(Math.round(delay))} ms`);
    this.retry = this.timers.setTimeout(() => {
      this.retry = undefined;
      if (!this.stopped) void this.connect();
    }, delay);
  }

  /** Runs onChange, or once more after the running one if it already runs. */
  private changed(): void {
    if (this.stopped) return;
    if (this.pulling) {
      this.again = true;
      return;
    }
    this.pulling = true;
    void (async () => {
      do {
        this.again = false;
        try {
          await this.options.onChange();
        } catch {
          // The caller records its own failures; the pull timer retries.
        }
      } while (this.pullAgain());
      this.pulling = false;
    })();
  }

  /** Read through a call: the loop's own assignment would narrow `again` to false. */
  private pullAgain(): boolean {
    return this.again && !this.stopped;
  }
}
