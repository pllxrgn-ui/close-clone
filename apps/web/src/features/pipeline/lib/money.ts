import type { Opportunity } from '@switchboard/shared';

/*
 * Currency-aware money math for the board.
 *
 * A pipeline mixes currencies, and summing across them is meaningless — €1 is
 * not $1. So every total is a *set* of per-currency subtotals; the UI renders
 * one figure per currency rather than a single fabricated number. All arithmetic
 * stays in integer cents (money is never a float); formatting divides by 100 at
 * the very end.
 */

export interface CurrencySum {
  currency: string;
  cents: number;
}

function group(opps: readonly Opportunity[], valueOf: (o: Opportunity) => number): CurrencySum[] {
  const byCurrency = new Map<string, number>();
  for (const opp of opps) {
    byCurrency.set(opp.currency, (byCurrency.get(opp.currency) ?? 0) + valueOf(opp));
  }
  return [...byCurrency.entries()]
    .map(([currency, cents]) => ({ currency, cents }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Total value per currency (never summed across currencies). */
export function sumByCurrency(opps: readonly Opportunity[]): CurrencySum[] {
  return group(opps, (o) => o.valueCents);
}

/**
 * Confidence-weighted value per currency: each deal contributes
 * `value × confidence%`, rounded to whole cents, then summed within its currency.
 */
export function weightedByCurrency(opps: readonly Opportunity[]): CurrencySum[] {
  return group(opps, (o) => Math.round((o.valueCents * o.confidence) / 100));
}

export interface FormatMoneyOptions {
  /** Compact display numerals ($240K, €4.3M). Default true. */
  compact?: boolean;
}

/** Format integer cents as localized currency. Compact by default for the grid. */
export function formatMoney(
  cents: number,
  currency: string,
  opts: FormatMoneyOptions = {},
): string {
  const compact = opts.compact ?? true;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    minimumFractionDigits: 0,
    maximumFractionDigits: compact ? 1 : 0,
  }).format(cents / 100);
}
