import type { JSX } from 'react';
import { cx } from '../lib/cx.ts';
import { Lamp, LAMP_LEGEND } from './Lamp.tsx';

/*
 * StateLegend — the key to the status lamps: every state, its lamp, and what it
 * means. Rendered inside the `?` cheat-sheet overlay (so the legend is always
 * one keystroke away) and exported standalone for any surface that wants it in a
 * popover. Lamps here are decorative — the visible name carries the a11y label.
 */
export function StateLegend({ className }: { className?: string }): JSX.Element {
  return (
    <section className={cx('sb-state-legend', className)} aria-label="Status lamp legend">
      <h3 className="sb-state-legend__title">Status lamps</h3>
      <ul className="sb-state-legend__list">
        {LAMP_LEGEND.map((meta) => (
          <li key={meta.state} className="sb-state-legend__row">
            <Lamp state={meta.state} decorative className="sb-state-legend__lamp" />
            <span className="sb-state-legend__name">{meta.label}</span>
            <span className="sb-state-legend__meaning">{meta.meaning}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
