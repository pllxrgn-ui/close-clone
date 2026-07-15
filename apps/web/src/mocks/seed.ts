/*
 * Deterministic PRNG + helpers for fixtures. A fixed seed means every load
 * produces byte-identical data (no Math.random at module scope), so tests and
 * the dev app are stable.
 */

/** mulberry32 — small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  const value = arr[Math.floor(rng() * arr.length)];
  if (value === undefined) {
    throw new Error('pick() called on an empty array');
  }
  return value;
}

/** Inclusive integer in [min, max]. */
export function int(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}

/** Deterministic RFC-4122 v4-shaped UUID built from the PRNG stream. */
export function uuidFrom(rng: () => number): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i += 1) {
    bytes.push(Math.floor(rng() * 256));
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
