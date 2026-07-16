import type { CSSProperties, JSX } from 'react';
import { cx } from '../../lib/cx.ts';
import type { StateKey } from './fixtures.ts';

/*
 * A single state lamp: a state-colored dot plus its wide-caps word. The dot is
 * the color budget; the word stays achromatic (--ink-dim) so it always clears
 * AA. reply + live lamps glow (dark theme only) and carry the page's one
 * ambient motion (a slow opacity pulse) — both handled in CSS by the state
 * modifier class.
 */
export interface StateLampProps {
  state: StateKey;
  word: string;
  /** Ignition stagger index (drives per-lamp transition-delay in CSS). */
  index?: number;
  /** Render only the dot (no word) — used inside dense rows. */
  dotOnly?: boolean;
  className?: string;
}

export function StateLamp({
  state,
  word,
  index,
  dotOnly = false,
  className,
}: StateLampProps): JSX.Element {
  const style = index === undefined ? undefined : ({ '--lamp-i': index } as CSSProperties);

  if (dotOnly) {
    return (
      <span
        className={cx('sb-welcome__lamp', `sb-welcome__lamp--${state}`, 'is-dot', className)}
        style={style}
      >
        <span className="sb-welcome__lamp-dot" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className={cx('sb-welcome__lamp', `sb-welcome__lamp--${state}`, className)} style={style}>
      <span className="sb-welcome__lamp-dot" aria-hidden="true" />
      <span className="sb-welcome__lamp-word">{word}</span>
    </span>
  );
}
