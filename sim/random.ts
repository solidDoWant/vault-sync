// Seeded pseudo-random numbers for the simulation (SPEC.md §13). Everything the
// harness decides (operations, targets, faults) comes from a Random derived
// from the run's seed, so a seed always replays the same client-side schedule.

/** Mixes a 32-bit value (splitmix32's finalizer). */
function mix32(value: number): number {
  let z = (value + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** FNV-1a hash of a string, used to derive independent named streams. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic generator (sfc32). Two instances built from the same seed
 * produce the same sequence on every platform: it uses only 32-bit integer
 * arithmetic.
 */
export class Random {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    const base = seed >>> 0;
    this.a = mix32(base);
    this.b = mix32(this.a ^ 0x6a09e667);
    this.c = mix32(this.b ^ 0xbb67ae85);
    this.d = 1;
    // Discard the first outputs, which correlate with the seed.
    for (let index = 0; index < 12; index++) this.uint32();
  }

  /** A generator for `label` that is independent of this one's later draws. */
  static derive(seed: number, label: string): Random {
    return new Random(mix32((seed >>> 0) ^ hashString(label)));
  }

  /** A uniformly distributed unsigned 32-bit integer. */
  uint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** A float in [0, 1). */
  float(): number {
    return this.uint32() / 0x1_0000_0000;
  }

  /** An integer in [0, bound). `bound` must be a positive integer. */
  int(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0) throw new RangeError(`bound must be a positive integer, got ${String(bound)}`);
    return Math.floor(this.float() * bound);
  }

  /** True with probability `probability`. */
  chance(probability: number): boolean {
    return this.float() < probability;
  }

  /** A uniformly chosen element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new RangeError("cannot pick from an empty array");
    return item;
  }

  /** A key of `weights` chosen with probability proportional to its weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.float() * total;
    for (const [key, weight] of entries) {
      if (roll < weight) return key;
      roll -= weight;
    }
    const last = entries[entries.length - 1];
    if (last === undefined) throw new RangeError("weights must not be empty");
    return last[0];
  }
}
