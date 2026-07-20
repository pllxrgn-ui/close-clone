/*
 * Date-range logic for the reporting surface. Everything is UTC-anchored to match
 * the API (CONTRACTS §C3 / reports/schemas.ts): `from`/`to` are calendar dates
 * read as UTC, and a range resolves to a half-open instant window
 * `[fromTs, toExclusiveTs)` where `to` is fully included (upper bound is the
 * following UTC midnight).
 *
 * `REPORT_NOW` is a fixed demo anchor: the MSW report seed is anchored here, so
 * the preset ranges always land on populated data. Real mode passes the wall
 * clock instead — the preset math takes `now` as an argument.
 */
import type { DateRange } from '../types.ts';

export const MS_PER_DAY = 86_400_000;

/** Max span of a report range, in days (mirrors API `MAX_RANGE_DAYS`). */
export const MAX_RANGE_DAYS = 366;

/**
 * Fixed anchor for the mock/demo (the seed's newest events sit on this UTC day).
 * Kept independent of the wall clock so the demo is byte-stable and every preset
 * range is non-empty.
 */
export const REPORT_NOW = new Date('2026-07-15T12:00:00.000Z');

/** Production follows the wall clock; deterministic mock tests keep the seed anchor. */
export function reportNow(): Date {
  return import.meta.env.VITE_API_MODE === 'real' ? new Date() : REPORT_NOW;
}

export interface RangePreset {
  key: '7d' | '30d' | '90d';
  /** Number of calendar days the window spans, inclusive of `to`. */
  days: number;
  /** Segmented-control label. */
  label: string;
  /** Accessible name for the option. */
  aria: string;
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { key: '7d', days: 7, label: '7D', aria: 'Last 7 days' },
  { key: '30d', days: 30, label: '30D', aria: 'Last 30 days' },
  { key: '90d', days: 90, label: '90D', aria: 'Last 90 days' },
];

export type RangePresetKey = RangePreset['key'];

export const DEFAULT_PRESET_KEY: RangePresetKey = '30d';

/** `YYYY-MM-DD` (UTC) for a Date. */
export function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC midnight epoch-ms of the calendar day an instant falls on. */
function utcDayStartMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * The `{from,to}` for a rolling window of `days` calendar days ending on `now`'s
 * UTC day (inclusive). A 7-day window ending Jul 15 → `Jul 09 … Jul 15`.
 */
export function presetRange(days: number, now: Date = REPORT_NOW): DateRange {
  const toMs = utcDayStartMs(now);
  const fromMs = toMs - (days - 1) * MS_PER_DAY;
  return { from: toUtcDateString(new Date(fromMs)), to: toUtcDateString(new Date(toMs)) };
}

/** Look up a preset by key (falls back to the default when unknown). */
export function presetByKey(key: string): RangePreset {
  return RANGE_PRESETS.find((p) => p.key === key) ?? defaultPreset();
}

function defaultPreset(): RangePreset {
  const found = RANGE_PRESETS.find((p) => p.key === DEFAULT_PRESET_KEY);
  if (!found) throw new Error('DEFAULT_PRESET_KEY must name a real preset');
  return found;
}

/** `{from,to}` for a preset key. */
export function rangeForKey(key: string, now: Date = REPORT_NOW): DateRange {
  return presetRange(presetByKey(key).days, now);
}

// ── Range resolution (server-side, mirrors reports/schemas.ts) ───────────────

/** Malformed / inverted / oversized range → maps to VALIDATION_FAILED (§C8). */
export class ReportRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportRangeError';
  }
}

/** A resolved half-open UTC instant range for filtering (`[fromMs, toExclusiveMs)`). */
export interface ResolvedRange {
  fromMs: number;
  toExclusiveMs: number;
  /** Inclusive lower date `YYYY-MM-DD` (for DATE-column comparisons like close_date). */
  fromDate: string;
  /** Exclusive upper date `YYYY-MM-DD`. */
  toExclusiveDate: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `YYYY-MM-DD` to a UTC-midnight epoch-ms, rejecting non-calendar dates. */
export function parseUtcDateMs(value: string): number {
  const m = DATE_RE.exec(value);
  if (m === null) throw new ReportRangeError(`invalid date: ${value}`);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Date.UTC normalises overflow (Feb 30 → Mar 2), so a mismatch means the input
  // was not a real calendar date.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new ReportRangeError(`invalid date: ${value}`);
  }
  return ms;
}

/**
 * Resolve a `from`/`to` pair to a half-open UTC instant + date window. Enforces
 * `from <= to` and a span no larger than `MAX_RANGE_DAYS`.
 */
export function resolveRange(from: string, to: string): ResolvedRange {
  const fromMs = parseUtcDateMs(from);
  const toMs = parseUtcDateMs(to);
  if (fromMs > toMs) throw new ReportRangeError('`from` must be on or before `to`');
  const spanDays = (toMs - fromMs) / MS_PER_DAY;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new ReportRangeError(`date range exceeds ${MAX_RANGE_DAYS} days`);
  }
  const toExclusiveMs = toMs + MS_PER_DAY;
  return {
    fromMs,
    toExclusiveMs,
    fromDate: from,
    toExclusiveDate: toUtcDateString(new Date(toExclusiveMs)),
  };
}
