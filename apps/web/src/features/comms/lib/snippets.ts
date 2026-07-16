import type { Snippet } from '@switchboard/shared';

/*
 * `/shortcut` snippet autocomplete — the pure text logic behind the composer's
 * body editor. Detects an active slash token at the caret, filters the snippet
 * library, and computes the exact text/caret result of inserting a snippet. No
 * React, no DOM: the editor component maps these results onto a textarea.
 */

export interface SlashToken {
  /** The typed shortcut without the leading slash (may be ''). */
  query: string;
  /** Index of the `/` in the source text. */
  start: number;
  /** Caret index (exclusive end of the token). */
  end: number;
}

// A shortcut token is `/` + [word chars/hyphen], with NO whitespace inside.
const TOKEN_CHAR = /[A-Za-z0-9_-]/;

/**
 * Find the slash-command token ending at `caret`, or null if none is active.
 *
 * Rules that keep it from firing on prose and URLs:
 *  - the `/` must sit at the string start or right after whitespace (so
 *    `http://x` and `a/b` never trigger);
 *  - only word characters/hyphens may sit between the `/` and the caret (a
 *    space closes the token).
 */
export function detectSlashToken(text: string, caret: number): SlashToken | null {
  if (caret < 0 || caret > text.length) return null;
  // Walk left from the caret over token characters.
  let i = caret;
  while (i > 0 && TOKEN_CHAR.test(text[i - 1] ?? '')) {
    i -= 1;
  }
  // The char immediately left of the run must be the slash.
  const slashIdx = i - 1;
  if (slashIdx < 0 || text[slashIdx] !== '/') return null;
  // The slash must be at the start or preceded by whitespace.
  const before = slashIdx > 0 ? (text[slashIdx - 1] ?? '') : '';
  if (slashIdx > 0 && !/\s/.test(before)) return null;
  return { query: text.slice(slashIdx + 1, caret), start: slashIdx, end: caret };
}

/**
 * Snippets whose shortcut starts with `query` (case-insensitive). An empty
 * query returns all snippets (the menu shows the full library on a bare `/`).
 * Results are sorted by shortcut for a stable, scannable menu.
 */
export function matchSnippets(query: string, snippets: readonly Snippet[]): Snippet[] {
  const q = query.toLowerCase();
  return snippets
    .filter((s) => s.shortcut.toLowerCase().startsWith(q))
    .sort((a, b) => a.shortcut.localeCompare(b.shortcut));
}

export interface SnippetInsertion {
  text: string;
  /** Caret position after the inserted body. */
  caret: number;
}

/**
 * Replace the slash token `[start,end)` with `body`, returning the new text and
 * the caret position (end of the inserted body). A single trailing space is
 * appended so the user can keep typing.
 */
export function applySnippet(text: string, token: SlashToken, body: string): SnippetInsertion {
  const insert = `${body} `;
  const next = text.slice(0, token.start) + insert + text.slice(token.end);
  return { text: next, caret: token.start + insert.length };
}
