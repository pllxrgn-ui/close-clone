/*
 * Pure, deterministic formatters for the reporting surface. Locale is pinned to
 * en-US so digit grouping, currency symbols, and month names are stable across
 * machines (tabular-nums at the call site handles visual alignment). No wall-clock
 * reads — callers pass instants explicitly.
 */

const intFmt = new Intl.NumberFormat('en-US');
const moneyFmtCache = new Map<string, Intl.NumberFormat>();
const dayMonthFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const dayMonthYearFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Grouped integer, e.g. `12842` → `12,842`. */
export function formatInt(n: number): string {
  return intFmt.format(Math.trunc(n));
}

function moneyFmt(currency: string): Intl.NumberFormat {
  const key = currency.toUpperCase();
  let fmt = moneyFmtCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: key,
        maximumFractionDigits: 0,
      });
    } catch {
      // Unknown ISO code → fall back to a plain grouped integer with the code.
      fmt = intFmt;
    }
    moneyFmtCache.set(key, fmt);
  }
  return fmt;
}

/** Whole-unit money from integer cents, e.g. `1_250_000` → `$12,500` (USD). */
export function formatMoneyCents(cents: number, currency = 'USD'): string {
  const fmt = moneyFmt(currency);
  const units = Math.round(cents / 100);
  if (fmt === intFmt) return `${intFmt.format(units)} ${currency.toUpperCase()}`;
  return fmt.format(units);
}

/**
 * Talk time as mono `H:MM` (hours:minutes), seconds floored to whole minutes.
 * `0` → `0:00`, `3725` → `1:02`, `216000` → `60:00`.
 */
export function formatTalkTime(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}:${String(mins).padStart(2, '0')}`;
}

/**
 * Reply rate as a percentage in `[0, 100]`. Zero sends → 0 (no divide-by-zero,
 * matches the "honest empty" contract rather than showing NaN%).
 */
export function replyRatePercent(sends: number, replies: number): number {
  if (sends <= 0) return 0;
  return (replies / sends) * 100;
}

/** Percentage with fixed precision, e.g. `22.5` → `22.5%`. */
export function formatPercent(pct: number, digits = 1): string {
  return `${pct.toFixed(digits)}%`;
}

/** Meter tone bands for reply rate (S4): ≥15 jade · 5–15 amber · <5 dim. */
export type MeterTone = 'high' | 'mid' | 'low';

export function meterTone(pct: number): MeterTone {
  if (pct >= 15) return 'high';
  if (pct >= 5) return 'mid';
  return 'low';
}

/** UTC date span for the picker caption, e.g. `Jun 15 – Jul 15, 2026`. */
export function formatDateRangeLabel(from: string, to: string): string {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${from} – ${to}`;
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const left = sameYear ? dayMonthFmt.format(a) : dayMonthYearFmt.format(a);
  return `${left} – ${dayMonthYearFmt.format(b)}`;
}
