/*
 * Hand-rolled Operator-Grid charts — no chart library. Bars/meters grow via
 * transform: scaleX (law: transform/opacity only); the funnel sizes segment
 * widths directly (labels live inside, so they must not distort). Color is spent
 * only on STATE: the bar leader in --state-live, funnel won/lost in reply/dnc,
 * the meter across reply/overdue/idle. Numbers pass in preformatted so the charts
 * stay pure and the tabular-nums alignment is owned by CSS.
 */
import type { CSSProperties, JSX } from 'react';
import { cx } from '../../../lib/cx.ts';
import type { StageKind } from '../lib/stages.ts';
import type { MeterTone } from '../lib/format.ts';

// ── Stat tile ────────────────────────────────────────────────────────────────

export function StatTile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rpt-tile">
      <span className="rpt-tile__num">{value}</span>
      <span className="rpt-tile__label">{label}</span>
    </div>
  );
}

// ── Horizontal bar comparison ────────────────────────────────────────────────

export interface BarItem {
  id: string;
  label: string;
  value: number;
  /** Preformatted value shown at the row end (defaults to the raw number). */
  display?: string;
}

function scaleStyle(ratio: number): CSSProperties {
  const clamped = Math.max(0, Math.min(1, ratio));
  return { transform: `scaleX(${clamped})` };
}

/**
 * Achromatic horizontal bars with the single leader (max value) in --state-live.
 * The label + value are real text (the track is decorative), so the comparison is
 * fully legible to a screen reader without the visual.
 */
export function BarComparison({
  items,
  unitLabel,
}: {
  items: readonly BarItem[];
  /** Screen-reader unit suffix, e.g. "calls". */
  unitLabel: string;
}): JSX.Element {
  const max = items.reduce((m, it) => Math.max(m, it.value), 0);
  const leaderId = max > 0 ? items.find((it) => it.value === max)?.id : undefined;
  return (
    <ul className="rpt-bars">
      {items.map((it) => {
        const isLeader = it.id === leaderId;
        return (
          <li
            key={it.id}
            className={cx('rpt-bar', isLeader && 'rpt-bar--leader')}
            aria-label={`${it.label}: ${it.display ?? String(it.value)} ${unitLabel}${isLeader ? ', leader' : ''}`}
          >
            <span className="rpt-bar__label" aria-hidden="true">
              {it.label}
            </span>
            <span className="rpt-bar__track" aria-hidden="true">
              <span className="rpt-bar__fill" style={scaleStyle(max > 0 ? it.value / max : 0)} />
            </span>
            <span className="rpt-bar__val" aria-hidden="true">
              {it.display ?? String(it.value)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ── Funnel band ──────────────────────────────────────────────────────────────

export interface FunnelSegment {
  id: string;
  label: string;
  count: number;
  display: string;
  kind: StageKind;
}

const KIND_CLASS: Record<StageKind, string | false> = {
  open: false,
  won: 'rpt-funnel__seg--won',
  lost: 'rpt-funnel__seg--lost',
};

/**
 * Proportional horizontal funnel: one row per stage, width ∝ the stage total.
 * Achromatic fills except won (--state-reply) / lost (--state-dnc); the label +
 * count sit inside (min-width keeps small stages readable).
 */
export function FunnelBand({ segments }: { segments: readonly FunnelSegment[] }): JSX.Element {
  const max = segments.reduce((m, s) => Math.max(m, s.count), 0);
  return (
    <div className="rpt-funnel" role="list" aria-label="Pipeline funnel by stage">
      {segments.map((s) => (
        <div className="rpt-funnel__row" key={s.id}>
          <div
            className={cx('rpt-funnel__seg', KIND_CLASS[s.kind])}
            role="listitem"
            aria-label={`${s.label}: ${s.display}`}
            style={{ width: `${max > 0 ? (s.count / max) * 100 : 100}%` }}
          >
            <span className="rpt-funnel__seg-label" aria-hidden="true">
              {s.label}
            </span>
            <span className="rpt-funnel__seg-count" aria-hidden="true">
              {s.display}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Reply-rate meter ─────────────────────────────────────────────────────────

const METER_CLASS: Record<MeterTone, string> = {
  high: 'rpt-meter--high',
  mid: 'rpt-meter--mid',
  low: 'rpt-meter--low',
};

/**
 * Compact reply-rate meter. The fill length encodes the rate; the tone encodes
 * the band (≥15 jade · 5–15 amber · <5 dim). The percent is real text so the
 * value survives without color (the track is decorative).
 */
export function MeterBar({
  percent,
  tone,
  valueText,
}: {
  percent: number;
  tone: MeterTone;
  valueText: string;
}): JSX.Element {
  return (
    <div className={cx('rpt-meter', METER_CLASS[tone])}>
      <span className="rpt-meter__track" aria-hidden="true">
        <span className="rpt-meter__fill" style={scaleStyle(percent / 100)} />
      </span>
      <span className="rpt-meter__val">{valueText}</span>
    </div>
  );
}
