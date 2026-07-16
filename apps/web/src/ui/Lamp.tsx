import type { CSSProperties, JSX } from 'react';
import { cx } from '../lib/cx.ts';

/*
 * Lamp — the Operator Grid status indicator. Color is the ENTIRE budget, so a
 * lamp is how a row announces its state at a glance. Six states; `reply` and
 * `live` pulse (the only ambient motion) and, in the dark theme only, carry a
 * soft glow. The light theme prints solid dots (no glow) so they read like
 * silk-screened indicators. Exported (with LampRail) for every list/board track.
 */

export const LAMP_STATES = ['reply', 'overdue', 'seq', 'dnc', 'live', 'idle'] as const;
export type LampState = (typeof LAMP_STATES)[number];

export interface LampMeta {
  state: LampState;
  /** Short state WORD (used as the default accessible name + legend title). */
  label: string;
  /** One-line meaning for the state legend. */
  meaning: string;
}

/** The canonical registry — the single source the legend and any consumer read. */
export const LAMP_META: Record<LampState, LampMeta> = {
  reply: { state: 'reply', label: 'Reply', meaning: 'New inbound reply is waiting' },
  overdue: { state: 'overdue', label: 'Overdue', meaning: 'A task or follow-up is past due' },
  seq: { state: 'seq', label: 'Sequence', meaning: 'Enrolled in an active sequence' },
  dnc: { state: 'dnc', label: 'Do not contact', meaning: 'Suppressed / DNC — no outreach allowed' },
  live: { state: 'live', label: 'Live', meaning: 'A live call or realtime activity right now' },
  idle: { state: 'idle', label: 'Idle', meaning: 'No pending activity' },
};

/** Ordered metadata list (registry order) for rendering the legend. */
export const LAMP_LEGEND: readonly LampMeta[] = LAMP_STATES.map((state) => LAMP_META[state]);

/** States that pulse + glow, per the law. */
function isActiveState(state: LampState): boolean {
  return state === 'reply' || state === 'live';
}

export interface LampProps {
  state: LampState;
  /** Accessible name; defaults to the state's label. Ignored when decorative. */
  label?: string;
  /** Suppress the pulse (e.g. very dense lists). reply/live pulse by default. */
  pulse?: boolean;
  /** Hide from the a11y tree when adjacent text already names the state. */
  decorative?: boolean;
  /** Dot diameter in px (default 9). */
  size?: number;
  className?: string;
}

/** A single status dot. 9px by default. */
export function Lamp({
  state,
  label,
  pulse = true,
  decorative = false,
  size,
  className,
}: LampProps): JSX.Element {
  const meta = LAMP_META[state];
  const style: CSSProperties | undefined =
    size !== undefined ? { width: `${size}px`, height: `${size}px` } : undefined;
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': label ?? meta.label } as const);
  // Only reply/live animate; data-static disables it when the caller opts out.
  const staticFlag = isActiveState(state) && !pulse ? '' : undefined;

  return (
    <span
      className={cx('sb-lamp', `sb-lamp--${state}`, className)}
      data-static={staticFlag}
      style={style}
      {...a11y}
    />
  );
}

export interface LampRailProps {
  state: LampState;
  /** Accessible name; defaults to the state's label. Ignored when decorative. */
  label?: string;
  /** Suppress the pulse (reply/live). */
  pulse?: boolean;
  /** Hide from the a11y tree when adjacent text already names the state. */
  decorative?: boolean;
  className?: string;
}

/**
 * LampRail — a 4px vertical status rail carrying a 9px Lamp node, sized to sit
 * as the leading edge of a list row (it stretches to the row's height). The
 * rail is a dim wash of the state color; the node is a full-strength Lamp.
 */
export function LampRail({
  state,
  label,
  pulse = true,
  decorative = false,
  className,
}: LampRailProps): JSX.Element {
  const meta = LAMP_META[state];
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': label ?? meta.label } as const);

  return (
    <span className={cx('sb-lamp-rail', `sb-lamp-rail--${state}`, className)} {...a11y}>
      <span className="sb-lamp-rail__track" aria-hidden="true" />
      <Lamp state={state} pulse={pulse} decorative className="sb-lamp-rail__node" />
    </span>
  );
}
