import { describe, expect, test } from 'vitest';
import type { Opportunity } from '@switchboard/shared';
import { formatMoney, sumByCurrency, weightedByCurrency } from './money.ts';

function opp(partial: Partial<Opportunity>): Opportunity {
  return {
    id: partial.id ?? 'o1',
    leadId: 'l1',
    contactId: null,
    valueCents: partial.valueCents ?? 0,
    currency: partial.currency ?? 'USD',
    stageId: partial.stageId ?? 's1',
    confidence: partial.confidence ?? 50,
    closeDate: partial.closeDate ?? null,
    ownerId: null,
    status: partial.status ?? 'active',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('sumByCurrency', () => {
  test('groups totals by currency and never sums across them', () => {
    const sums = sumByCurrency([
      opp({ currency: 'USD', valueCents: 100_00 }),
      opp({ currency: 'EUR', valueCents: 250_00 }),
      opp({ currency: 'USD', valueCents: 50_00 }),
    ]);
    expect(sums).toEqual([
      { currency: 'EUR', cents: 250_00 },
      { currency: 'USD', cents: 150_00 },
    ]);
  });

  test('empty input yields no rows', () => {
    expect(sumByCurrency([])).toEqual([]);
  });
});

describe('weightedByCurrency', () => {
  test('weights each deal by confidence, rounds to cents, groups by currency', () => {
    const weighted = weightedByCurrency([
      opp({ currency: 'USD', valueCents: 100_00, confidence: 25 }), // 2500
      opp({ currency: 'USD', valueCents: 100_00, confidence: 50 }), // 5000
      opp({ currency: 'EUR', valueCents: 100_00, confidence: 10 }), // 1000
    ]);
    expect(weighted).toEqual([
      { currency: 'EUR', cents: 1000 },
      { currency: 'USD', cents: 7500 },
    ]);
  });

  test('rounds half-cent weightings deterministically', () => {
    // 333c * 33% = 109.89 → rounds to 110.
    expect(weightedByCurrency([opp({ valueCents: 333, confidence: 33 })])).toEqual([
      { currency: 'USD', cents: 110 },
    ]);
  });
});

describe('formatMoney', () => {
  test('compact display numerals carry the currency and magnitude', () => {
    expect(formatMoney(240_000_00, 'USD')).toMatch(/240K/);
    expect(formatMoney(240_000_00, 'USD')).toContain('$');
    expect(formatMoney(4_300_000_00, 'EUR')).toMatch(/4\.3M/);
  });

  test('standard form spells the amount out without fractional cents', () => {
    const full = formatMoney(240_000_00, 'USD', { compact: false });
    expect(full).toContain('240,000');
    expect(full).not.toContain('.00');
  });

  test('AUD renders without throwing (distinct symbol from USD)', () => {
    expect(() => formatMoney(5_000_00, 'AUD')).not.toThrow();
    expect(formatMoney(5_000_00, 'AUD')).toMatch(/5K/);
  });
});
