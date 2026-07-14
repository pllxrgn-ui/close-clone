/**
 * Deterministic PRNG for fixture generation. A given seed string always yields
 * the same stream — this is what makes the golden/latency datasets reproducible
 * (same seed → identical content hash), which the DSL golden tests rely on.
 *
 * xmur3 (seed hashing) + mulberry32 (uniform generator) — small, fast, stable.
 */

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = '0123456789abcdef';

export class Rng {
  private readonly next01: () => number;

  constructor(seed: string) {
    const hash = xmur3(seed);
    this.next01 = mulberry32(hash());
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next01();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next01() * (max - min + 1));
  }

  /** True with probability `p`. */
  bool(p: number): boolean {
    return this.next01() < p;
  }

  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) {
      throw new Error('Rng.pick called on empty array');
    }
    return item;
  }

  /** Weighted element: `weights` parallel to `items`, need not sum to 1. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = this.next01() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i] ?? 0;
      if (roll < 0) {
        return items[i] as T;
      }
    }
    return items[items.length - 1] as T;
  }

  /** Deterministic UUID-v4-shaped string (consumes a fixed number of draws). */
  uuid(): string {
    let out = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        out += '-';
      } else if (i === 14) {
        out += '4';
      } else if (i === 19) {
        out += HEX[8 + this.int(0, 3)];
      } else {
        out += HEX[this.int(0, 15)];
      }
    }
    return out;
  }
}
