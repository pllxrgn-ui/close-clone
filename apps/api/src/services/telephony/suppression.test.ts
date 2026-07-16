import { afterEach, beforeEach, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { suppressions } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { addPhoneSuppression, isPhoneSuppressed } from './suppression.ts';

/**
 * Phone suppression (task 3b, CONTRACTS §C6 I-QUIET / I-DNC). A global `(phone,
 * key)` suppression blocks every SMS/dial path; adds are idempotent and a released
 * suppression is re-activated by a fresh STOP.
 */

const KEY = '3055550147';

let ctx: TestDb;

beforeEach(async () => {
  ctx = await createTestDb();
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

test('adds and probes a phone suppression', async () => {
  expect(await isPhoneSuppressed(ctx.db, KEY)).toBe(false);
  const res = await addPhoneSuppression(ctx.db, { key: KEY, source: 'stop_keyword' });
  expect(res.created).toBe(true);
  expect(await isPhoneSuppressed(ctx.db, KEY)).toBe(true);
});

test('is idempotent on repeated adds', async () => {
  await addPhoneSuppression(ctx.db, { key: KEY, source: 'stop_keyword' });
  const again = await addPhoneSuppression(ctx.db, { key: KEY, source: 'stop_keyword' });
  expect(again.created).toBe(false);
  const rows = await ctx.db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(sql`${suppressions.kind} = 'phone' AND ${suppressions.value} = ${KEY}`);
  expect(rows).toHaveLength(1);
});

test('re-activates a released suppression', async () => {
  const first = await addPhoneSuppression(ctx.db, { key: KEY, source: 'stop_keyword' });
  // Admin release (audited elsewhere) — simulate by stamping released_at.
  await ctx.db
    .update(suppressions)
    .set({ releasedAt: sql`now()` })
    .where(eq(suppressions.id, first.suppressionId));
  expect(await isPhoneSuppressed(ctx.db, KEY)).toBe(false);

  const reactivated = await addPhoneSuppression(ctx.db, { key: KEY, source: 'stop_keyword' });
  expect(reactivated.created).toBe(true);
  expect(reactivated.suppressionId).toBe(first.suppressionId);
  expect(await isPhoneSuppressed(ctx.db, KEY)).toBe(true);
});

test('an empty key never matches', async () => {
  expect(await isPhoneSuppressed(ctx.db, '')).toBe(false);
});
