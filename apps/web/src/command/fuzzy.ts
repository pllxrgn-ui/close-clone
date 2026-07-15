/*
 * A small, deterministic fuzzy matcher for the command palette.
 *
 * Matching is a case-insensitive subsequence test; scoring rewards matches that
 * are contiguous, at the start of the string, or on a word boundary, and lightly
 * penalizes longer targets so shorter exact-ish hits float up. Returns the match
 * ranges so the UI can highlight the matched characters.
 */

export interface FuzzyMatch {
  score: number;
  /** Half-open [start, end) ranges of matched characters in the original text. */
  ranges: Array<[number, number]>;
}

const BOUNDARY = new Set([' ', '-', '_', '/', '.', ':', '@']);

function compressRanges(indices: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && index === last[1]) {
      last[1] = index + 1;
    } else {
      ranges.push([index, index + 1]);
    }
  }
  return ranges;
}

/**
 * Score `text` against `query`. Returns null when `query` is not a subsequence
 * of `text`. An empty query matches everything with a neutral score.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (q === '') return { score: 0, ranges: [] };

  const haystack = text.toLowerCase();
  const matched: number[] = [];
  let queryIndex = 0;
  let previousMatch = -2;
  let score = 0;

  for (let i = 0; i < haystack.length && queryIndex < q.length; i += 1) {
    if (haystack[i] !== q[queryIndex]) continue;

    let bonus = 1;
    if (i === previousMatch + 1) bonus += 4; // contiguous run
    if (i === 0) {
      bonus += 5; // very start
    } else if (BOUNDARY.has(haystack[i - 1] ?? '')) {
      bonus += 3; // word boundary
    }
    score += bonus;
    matched.push(i);
    previousMatch = i;
    queryIndex += 1;
  }

  if (queryIndex < q.length) return null;

  // Gentle length penalty: a hit in a short label beats the same hit in a long one.
  score -= haystack.length * 0.02;
  return { score, ranges: compressRanges(matched) };
}

/** Best score of a command's title plus any keyword aliases (title wins ties). */
export function scoreEntry(
  query: string,
  title: string,
  keywords: readonly string[] = [],
): FuzzyMatch | null {
  const titleMatch = fuzzyMatch(query, title);
  let best = titleMatch;
  for (const keyword of keywords) {
    const keywordMatch = fuzzyMatch(query, keyword);
    if (keywordMatch && (best === null || keywordMatch.score > best.score)) {
      // Keep title ranges for highlighting; keywords only lift the score.
      best = { score: keywordMatch.score, ranges: titleMatch ? titleMatch.ranges : [] };
    }
  }
  return best;
}
