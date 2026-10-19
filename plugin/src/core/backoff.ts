// Bounded, jittered backoff, shared by the realtime reconnects (SPEC.md §6.4)
// and the engine's wait after the server's per-user limit (§12).

/** The timer functions a backoff waits with; tests pass fake ones. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const globalTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface Backoff {
  /** The first delay's ceiling, in milliseconds; each consecutive failure doubles it. */
  initialMs: number;
  /** The largest delay ceiling, in milliseconds. */
  maxMs: number;
}

/**
 * The delay after `failures` consecutive failures (1 for the first): a
 * ceiling that doubles from `initialMs` up to `maxMs`, with "equal jitter"
 * (half the ceiling plus `random`, in [0, 1], times the other half), so it is
 * never below half the ceiling and never above `maxMs`.
 */
export function backoffDelay(failures: number, backoff: Backoff, random: number): number {
  const ceiling = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.max(0, Math.min(failures - 1, 30)));
  return ceiling / 2 + (ceiling / 2) * Math.min(Math.max(random, 0), 1);
}
