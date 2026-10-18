// Minimizes a failing schedule by deleting steps (a simple form of delta
// debugging): try removing chunks of steps, halving the chunk size when no
// chunk can go, and keep every removal after which the schedule still fails.
// Steps select their targets relative to what is pending when they run (see
// schedule.ts), so any subsequence is still a valid schedule.

export interface ShrinkResult<T> {
  items: T[];
  /** How many candidates were tried. */
  runs: number;
}

/**
 * The smallest subsequence of `items` found within `maxRuns` attempts for
 * which `fails` still holds. `fails(items)` is assumed to hold.
 */
export async function shrink<T>(items: readonly T[], fails: (candidate: T[]) => Promise<boolean>, maxRuns: number): Promise<ShrinkResult<T>> {
  let current = [...items];
  let runs = 0;
  let chunk = Math.max(1, Math.ceil(current.length / 2));
  while (current.length > 0 && runs < maxRuns) {
    let removed = false;
    for (let start = 0; start < current.length && runs < maxRuns; ) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
      runs++;
      if (await fails(candidate)) {
        current = candidate;
        removed = true;
      } else {
        start += chunk;
      }
    }
    if (!removed) {
      if (chunk === 1) break;
      chunk = Math.ceil(chunk / 2);
    } else {
      chunk = Math.min(chunk, Math.max(1, Math.ceil(current.length / 2)));
    }
  }
  return { items: current, runs };
}
