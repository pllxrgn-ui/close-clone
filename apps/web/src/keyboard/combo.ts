/*
 * Combo normalization + presentation.
 *
 * A "combo" is a canonical, lowercase string token that both bindings and live
 * keyboard events reduce to, so matching is a string compare:
 *   - modifiers collapse: Ctrl and Cmd both become `mod` (platform-agnostic
 *     matching; the *display* differs per platform)
 *   - order is fixed: `mod+alt+shift+<key>`
 *   - printable keys carry their shifted character (`?` not `shift+/`), so shift
 *     is only recorded for named keys (e.g. `shift+enter`)
 *   - key names are lowercased (`Escape` -> `escape`, `ArrowDown` -> `arrowdown`)
 * A sequence (chord) is two combos separated by a space: `g i`.
 */

interface ModifierState {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /mac os/i.test(nav.userAgent ?? '');
}

/** True on Apple platforms — only affects how modifiers are *rendered*. */
export const IS_MAC = detectMac();

/** Reduce a keyboard event to its canonical combo token. */
export function eventToCombo(event: ModifierState): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');

  let key = event.key;
  const printable = key.length === 1;
  // For printable characters the shifted glyph is already in `key` ('?' not '/').
  if (event.shiftKey && !printable) parts.push('shift');
  if (key === ' ') key = 'space';
  parts.push(key.toLowerCase());
  return parts.join('+');
}

/** Is a target a text-entry surface (so non-global bindings should be ignored)? */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

/** A combo is a sequence if it has more than one space-separated step. */
export function isSequence(combo: string): boolean {
  return combo.includes(' ');
}

/** The first step of a (possibly sequence) combo — its trigger prefix. */
export function sequencePrefix(combo: string): string {
  const [first = ''] = combo.split(' ');
  return first;
}

// ── Presentation ─────────────────────────────────────────────────────────────

const NAMED_CAP: Record<string, string> = {
  escape: 'Esc',
  enter: '↵',
  space: 'Space',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  home: 'Home',
  end: 'End',
};

const NAMED_WORD: Record<string, string> = {
  escape: 'Escape',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
};

function capLabel(token: string): string {
  if (token === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
  if (token === 'alt') return IS_MAC ? '⌥' : 'Alt';
  if (token === 'shift') return IS_MAC ? '⇧' : 'Shift';
  const named = NAMED_CAP[token];
  if (named) return named;
  if (token.length === 1) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function wordLabel(token: string): string {
  if (token === 'mod') return IS_MAC ? 'Command' : 'Control';
  if (token === 'alt') return IS_MAC ? 'Option' : 'Alt';
  if (token === 'shift') return 'Shift';
  const word = NAMED_WORD[token];
  if (word) return word;
  if (token.length === 1) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Split a combo into steps of key-cap labels for visual rendering, e.g.
 * `mod+k` -> [['⌘','K']], `g i` -> [['G'],['I']].
 */
export function comboToCapSteps(combo: string): string[][] {
  return combo
    .split(' ')
    .filter(Boolean)
    .map((step) => step.split('+').filter(Boolean).map(capLabel));
}

/**
 * A screen-reader-friendly rendering, e.g. `mod+k` -> "Control K",
 * `g i` -> "G then I".
 */
export function readableCombo(combo: string): string {
  return combo
    .split(' ')
    .filter(Boolean)
    .map((step) => step.split('+').filter(Boolean).map(wordLabel).join(' '))
    .join(' then ');
}
