import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  activities,
  contacts,
  leads,
  leadStatuses,
  opportunities,
  opportunityStages,
  tasks,
  users,
} from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import { loadGoldenFixtures, loadLatencyFixtures } from './loader.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');
const goldenDir = resolve(repoRoot, 'fixtures/out/golden');
const latencyDir = resolve(repoRoot, 'fixtures/out/latency');
const cli = resolve(repoRoot, 'fixtures/src/cli.ts');

// CI checks out with fixtures/out gitignored — generate on demand so the loader
// has something to read (matches the task's `pnpm fixtures:generate --golden`).
beforeAll(() => {
  if (!existsSync(resolve(goldenDir, 'leads.json'))) {
    execFileSync('node', [cli, '--golden'], { cwd: repoRoot, stdio: 'ignore' });
  }
  if (!existsSync(resolve(latencyDir, 'leads.ndjson'))) {
    execFileSync('node', [cli, '--latency'], { cwd: repoRoot, stdio: 'ignore' });
  }
}, 300_000);

let ctx: TestDb;
beforeEach(async () => {
  ctx = await createTestDb();
});
afterEach(async () => {
  await ctx.close();
});

async function count(table: PgTable): Promise<number> {
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row?.n ?? 0;
}

describe('golden fixture loader', () => {
  test('loads the 5k golden set with counts matching the manifest', async () => {
    const manifest = JSON.parse(readFileSync(resolve(goldenDir, 'manifest.json'), 'utf8')) as {
      counts: {
        leads: number;
        contacts: number;
        opportunities: number;
        tasks: number;
        activities: number;
      };
    };

    const result = await loadGoldenFixtures(ctx.db);

    // Reported counts match the manifest …
    expect(result).toMatchObject(manifest.counts);
    // … and the rows are actually in the DB.
    expect(await count(leads)).toBe(manifest.counts.leads);
    expect(await count(contacts)).toBe(manifest.counts.contacts);
    expect(await count(opportunities)).toBe(manifest.counts.opportunities);
    expect(await count(tasks)).toBe(manifest.counts.tasks);
    expect(await count(activities)).toBe(manifest.counts.activities);

    // Dimension rows were synthesized from the fixtures' label/owner references.
    expect(await count(users)).toBeGreaterThan(0);
    expect(await count(leadStatuses)).toBeGreaterThan(0);
    expect(await count(opportunityStages)).toBeGreaterThan(0);
  }, 120_000);

  test('preserves fixture denorm columns and resolves FKs', async () => {
    await loadGoldenFixtures(ctx.db);
    // Every lead resolves to a real owner + status (FKs held on insert).
    const [orphans] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(sql`${leads.ownerId} is null or ${leads.statusId} is null`);
    expect(orphans?.n ?? -1).toBe(0);
    // A denorm hot column survived the round-trip for at least some leads.
    const [withTouch] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(sql`${leads.lastContactedAt} is not null`);
    expect(withTouch?.n ?? 0).toBeGreaterThan(0);
  }, 120_000);
});

describe('latency fixture loader (streamed ndjson)', () => {
  test('streams and bulk-loads a bounded slice end-to-end', async () => {
    const result = await loadLatencyFixtures(ctx.db, { maxLeads: 250 });
    expect(result.leads).toBe(250);
    expect(await count(leads)).toBe(250);
    // Children of the loaded leads came through the streaming path.
    expect(result.contacts).toBeGreaterThan(0);
    expect(await count(contacts)).toBe(result.contacts);
    expect(await count(activities)).toBe(result.activities);
  }, 120_000);
});
