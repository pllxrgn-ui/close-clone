import { describe, expect, it } from 'vitest';
import { GOLDEN, LATENCY, countDataset, datasetHash, generateDataset } from './generate.ts';

describe('fixture generator', () => {
  it('is deterministic: same seed → identical content hash', () => {
    const a = generateDataset(500, 'determinism-check');
    const b = generateDataset(500, 'determinism-check');
    expect(datasetHash(a)).toBe(datasetHash(b));
    expect(a).toEqual(b);
  });

  it('diverges on a different seed', () => {
    const a = generateDataset(500, 'seed-a');
    const b = generateDataset(500, 'seed-b');
    expect(datasetHash(a)).not.toBe(datasetHash(b));
  });

  it('produces the golden 5k lead set with related records', () => {
    const dataset = generateDataset(GOLDEN.count, GOLDEN.seed);
    const counts = countDataset(dataset);
    expect(counts.leads).toBe(5000);
    // Pinned content hash of the enriched golden set (Task 1d added the optional
    // `renewal_date`/`csm` custom fields so the DSL goldens cover all five custom
    // types + presence). Any generator change must consciously update this pin
    // and regenerate `fixtures/out/golden`.
    expect(datasetHash(dataset)).toBe(
      '0b400aadd3506d4e8c6bce405c33c56466ef44d4d234a16fcf727155cff532d3',
    );
    // Distributions suitable for DSL golden tests: every related entity present.
    expect(counts.contacts).toBeGreaterThan(counts.leads); // 1..3 per lead
    expect(counts.opportunities).toBeGreaterThan(0);
    expect(counts.tasks).toBeGreaterThan(0);
    expect(counts.activities).toBeGreaterThan(0);
  });

  it('spreads leads across every status and populates custom fields', () => {
    const dataset = generateDataset(GOLDEN.count, GOLDEN.seed);
    const statuses = new Set(dataset.leads.map((l) => l.status));
    for (const s of ['Potential', 'Contacted', 'Qualified', 'Won', 'Lost']) {
      expect(statuses.has(s)).toBe(true);
    }
    const first = dataset.leads[0];
    expect(first).toBeDefined();
    expect(Object.keys(first?.custom ?? {})).toContain('industry');
  });

  it('emits valid UUIDs and derives denormalized activity columns', () => {
    const dataset = generateDataset(200, 'uuid-check');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(dataset.leads.every((l) => uuidRe.test(l.id))).toBe(true);
    // At least one lead should have a computed last-contacted timestamp.
    expect(dataset.leads.some((l) => l.lastContactedAt !== null)).toBe(true);
  });

  it('pins the dataset sizes named in the plan', () => {
    expect(GOLDEN.count).toBe(5000);
    expect(LATENCY.count).toBe(100_000);
  });
});
