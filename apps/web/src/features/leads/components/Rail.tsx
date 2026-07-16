import type { CSSProperties, JSX } from 'react';
import { cx } from '../../../lib/cx.ts';
import { LEAD_STATE } from '../lib/leadState.ts';
import type { LeadStateKey } from '../lib/leadState.ts';

/*
 * Minimal leading state rail — the 4px slot every row reserves so the list reads
 * like a status board. Deliberately one small file so the re-skin track's
 * LampRail primitive can drop in one-for-one at merge. Matches the LAW: 4px,
 * square (radius 0), state-colored; the reply state is a lamp (glow + 2.2s pulse,
 * dark-theme only), driven entirely by CSS off `data-lamp`/`data-live` — no JS
 * animation, and reduced-motion drops the pulse (see leads.css).
 */

interface RailProps {
  state: LeadStateKey | null;
  /** Live (real-time) accent — the only other glowing lamp per the LAW. */
  live?: boolean;
  className?: string;
}

export function Rail({ state, live = false, className }: RailProps): JSX.Element {
  const meta = state ? LEAD_STATE[state] : null;
  const style = meta ? ({ '--rail-color': `var(${meta.solidVar})` } as CSSProperties) : undefined;
  return (
    <span
      className={cx('lead-rail', meta && 'is-on', className)}
      style={style}
      data-state={state ?? undefined}
      data-lamp={meta?.lamp ? 'true' : undefined}
      data-live={live ? 'true' : undefined}
      aria-hidden="true"
    />
  );
}
