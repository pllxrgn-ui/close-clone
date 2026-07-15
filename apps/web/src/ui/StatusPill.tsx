import type { JSX, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';

/*
 * Semantic state tones (build guide: color is spent almost entirely on STATE).
 * Each maps to the AA-verified --state-* token pair in tokens.css.
 */
export const STATUS_TONES = [
  'neutral',
  'newReply',
  'overdue',
  'inSequence',
  'dnc',
  'won',
  'lost',
  'draft',
] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: '',
  newReply: 'sb-pill--new-reply',
  overdue: 'sb-pill--overdue',
  inSequence: 'sb-pill--in-sequence',
  dnc: 'sb-pill--dnc',
  won: 'sb-pill--won',
  lost: 'sb-pill--lost',
  draft: 'sb-pill--draft',
};

interface StatusPillProps {
  tone?: StatusTone;
  /** Show a leading state dot. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

export function StatusPill({
  tone = 'neutral',
  dot = false,
  children,
  className,
}: StatusPillProps): JSX.Element {
  return (
    <span className={cx('sb-pill', TONE_CLASS[tone], className)}>
      {dot ? <span className="sb-pill__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
