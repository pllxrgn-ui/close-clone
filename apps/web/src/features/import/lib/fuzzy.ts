/*
 * Trigram similarity for demo-mode fuzzy company-name dedupe — a stand-in for the
 * server's pg_trgm `similarity()`. Dice coefficient over space-padded 3-grams;
 * inputs are expected to be `normalizeName`-normalized already. Deterministic and
 * pure so the mock dry-run matches the real engine's "fuzzy-name" disposition
 * closely enough to be believable, and unit-tests without a database.
 */

function trigrams(value: string): Set<string> {
  const s = `  ${value} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i += 1) grams.add(s.slice(i, i + 3));
  return grams;
}

/** Dice similarity in [0, 1]; 1 for identical, 0 when either side is empty. */
export function trigramSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return (2 * inter) / (ga.size + gb.size);
}

export interface FuzzyCandidate {
  /** normalizeName'd company name. */
  key: string;
  /** Lead id to return on a match. */
  id: string;
}

/**
 * Best-scoring candidate id whose similarity to `query` clears `threshold`, or
 * null. Ties resolve to the first candidate in corpus order (stable).
 */
export function bestFuzzyMatch(
  query: string,
  corpus: readonly FuzzyCandidate[],
  threshold: number,
): string | null {
  let bestId: string | null = null;
  let bestScore = threshold;
  for (const cand of corpus) {
    const score = trigramSimilarity(query, cand.key);
    if (score >= bestScore && (bestId === null || score > bestScore)) {
      bestScore = score;
      bestId = cand.id;
    }
  }
  return bestId;
}
