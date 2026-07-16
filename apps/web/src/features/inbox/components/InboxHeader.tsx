import type { JSX } from 'react';
import type { InboxStats } from '../model/types.ts';

/*
 * The header strip: title + three display-numeral stats that update live as the
 * rep works the queue. Reuses the shell's `.sb-stat` readout (condensed display
 * face, tabular-nums); "Overdue" and "Done today" carry a state tint, the rest of
 * the chrome stays achromatic. Each value is a polite live region so its change
 * is announced without moving focus.
 */

type StatTone = 'neutral' | 'overdue' | 'done';

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: StatTone;
}): JSX.Element {
  return (
    <div className="sb-stat sb-inbox__stat">
      <span
        className={`sb-stat__value sb-inbox__stat-value sb-inbox__stat-value--${tone}`}
        aria-live="polite"
        aria-atomic="true"
        aria-label={`${value} ${label.toLowerCase()}`}
      >
        {value.toLocaleString('en-US')}
      </span>
      <span className="sb-stat__label">{label}</span>
    </div>
  );
}

export function InboxHeader({ stats }: { stats: InboxStats }): JSX.Element {
  return (
    <header className="sb-inbox__header">
      <div className="sb-inbox__heading">
        <h1 className="sb-inbox__title">Inbox</h1>
        <p className="sb-inbox__lede">Everything waiting on you — one lamp-lit queue.</p>
      </div>
      <div className="sb-stat-row sb-inbox__stats">
        <Stat label="Needs you now" value={stats.needsYouNow} tone="neutral" />
        <Stat label="Overdue" value={stats.overdue} tone="overdue" />
        <Stat label="Done today" value={stats.doneToday} tone="done" />
      </div>
    </header>
  );
}
