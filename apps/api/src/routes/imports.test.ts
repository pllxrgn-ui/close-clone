import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { customFieldDefs, suppressions, users, type Db } from '../db/index.ts';
import { ImportStorage } from '../services/imports/index.ts';
import { registerImportRoutes, type ImportActor, type ImportRouteDeps } from './imports.ts';
import { sendError } from './http.ts';

/**
 * `POST /imports` (multipart) → `POST /imports/:id/dry-run` → `POST /imports/:id/commit`
 * (CONTRACTS §C7/§C8). Drives the plugin through `fastify.inject` against a PGlite
 * DB + a temp-disk storage, with a stub actor resolver (header-driven) and an
 * injectable RBAC preHandler — both the seams the orchestrator wires.
 */

const USER = '00000000-0000-4000-8000-0000000000f1';
const BOUNDARY = 'SwitchboardImportBoundary9x7';

let ctx: TestDb;
let storeDir: string;
let storage: ImportStorage;

/** Header-driven actor stub: `x-actor-id` present → that user, else unauthenticated. */
function getActor(request: FastifyRequest): ImportActor | null {
  const h = request.headers['x-actor-id'];
  return typeof h === 'string' && h.length > 0 ? { userId: h } : null;
}

async function seed(db: Db): Promise<void> {
  await db.insert(users).values({
    id: USER,
    email: 'importer@example.com',
    name: 'Importer',
    role: 'admin',
    idpSubject: 'idp|routes',
  });
  await db.insert(customFieldDefs).values([
    { entity: 'lead', key: 'industry', label: 'Industry', type: 'text' },
    { entity: 'lead', key: 'employees', label: 'Employees', type: 'number' },
  ]);
  await db
    .insert(suppressions)
    .values({ kind: 'email', value: 'sup@suppco.com', source: 'manual' });
}

function buildApp(overrides: Partial<ImportRouteDeps> = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const deps: ImportRouteDeps = { db: ctx.db, storage, getActor, ...overrides };
  registerImportRoutes(app, deps);
  return app;
}

/** Assemble a single-file multipart/form-data body. */
function multipart(filename: string, content: string): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: text/csv\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8');
  return Buffer.concat([head, Buffer.from(content, 'utf8'), tail]);
}

const MULTIPART_CT = `multipart/form-data; boundary=${BOUNDARY}`;

async function upload(app: FastifyInstance, csv: string, filename = 'leads.csv') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/imports',
    headers: { 'content-type': MULTIPART_CT, 'x-actor-id': USER },
    payload: multipart(filename, csv),
  });
}

const MAPPING = {
  columns: [
    { source: 'Company', target: 'lead.name' },
    { source: 'Website', target: 'lead.url' },
    { source: 'Email', target: 'contact.email' },
  ],
};

async function count(db: Db, table: string): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return (r as { rows: { n: number }[] }).rows[0]?.n ?? -1;
}

beforeEach(async () => {
  ctx = await createTestDb();
  await seed(ctx.db);
  storeDir = await mkdtemp(join(tmpdir(), 'sb-import-routes-'));
  storage = new ImportStorage(storeDir);
}, 60_000);

afterEach(async () => {
  await ctx.close();
  await rm(storeDir, { recursive: true, force: true });
});

describe('POST /api/v1/imports — upload', () => {
  test('stores the file and returns 201 with an uploaded import', async () => {
    const app = buildApp();
    const res = await upload(app, 'Company,Website,Email\nAcme,https://acme.com,a@acme.com\n');
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string; filename: string }>();
    expect(body.status).toBe('uploaded');
    expect(body.filename).toBe('leads.csv');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  test('a non-multipart body → 400 VALIDATION_FAILED', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      headers: { 'content-type': 'application/json', 'x-actor-id': USER },
      payload: { not: 'multipart' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  test('the byte cap surfaces as 400 VALIDATION_FAILED', async () => {
    const app = buildApp({ maxBytes: 8 });
    const res = await upload(app, 'Company,Website,Email\nAcme,https://acme.com,a@acme.com\n');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });
});

describe('imports — auth + RBAC (C8)', () => {
  test('missing actor → 401 UNAUTHENTICATED on every endpoint', async () => {
    const app = buildApp();
    const up = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      headers: { 'content-type': MULTIPART_CT },
      payload: multipart('x.csv', 'Company\nAcme\n'),
    });
    expect(up.statusCode).toBe(401);
    expect(up.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');

    const dr = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/00000000-0000-4000-8000-000000000abc/dry-run',
      payload: { mapping: MAPPING },
    });
    expect(dr.statusCode).toBe(401);
    await app.close();
  });

  test('an injected RBAC preHandler that denies → 403 FORBIDDEN', async () => {
    const app = buildApp({
      preHandler: async (_request, reply) => {
        await sendError(reply, 'FORBIDDEN', 'RBAC: import scope required');
      },
    });
    const res = await upload(app, 'Company\nAcme\n');
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    await app.close();
  });
});

describe('imports — dry-run → commit (full flow)', () => {
  const csv =
    'Company,Website,Email\nAcme,https://acme.com,a@acme.com\nGlobex,globex.io,b@globex.io\n';

  async function dryRun(app: FastifyInstance, id: string, mapping: unknown = MAPPING) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/dry-run`,
      headers: { 'x-actor-id': USER },
      payload: { mapping },
    });
  }

  test('dry-run returns counts + per-row disposition and writes nothing', async () => {
    const app = buildApp();
    const id = (await upload(app, csv)).json<{ id: string }>().id;

    const res = await dryRun(app, id);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      counts: { leadsCreated: number; contactsCreated: number };
      rows: { outcome: string }[];
    }>();
    expect(body.counts.leadsCreated).toBe(2);
    expect(body.counts.contactsCreated).toBe(2);
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r) => r.outcome === 'create')).toBe(true);
    // Dry-run wrote no leads/contacts.
    expect(await count(ctx.db, 'leads')).toBe(0);
    expect(await count(ctx.db, 'contacts')).toBe(0);
    await app.close();
  });

  test('commit creates rows + events, and re-commit is a 409 CONFLICT no-op', async () => {
    const app = buildApp();
    const id = (await upload(app, csv)).json<{ id: string }>().id;
    await dryRun(app, id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/commit`,
      headers: { 'x-actor-id': USER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; counters: { leads: number } }>();
    expect(body.status).toBe('committed');
    expect(body.counters.leads).toBe(2);
    expect(await count(ctx.db, 'leads')).toBe(2);
    expect(await count(ctx.db, 'contacts')).toBe(2);

    // Idempotent re-POST: CONFLICT, and no duplicate rows.
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/commit`,
      headers: { 'x-actor-id': USER },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    expect(await count(ctx.db, 'leads')).toBe(2);
    await app.close();
  });

  test('committing before dry-run → 409 CONFLICT', async () => {
    const app = buildApp();
    const id = (await upload(app, csv)).json<{ id: string }>().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/commit`,
      headers: { 'x-actor-id': USER },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    await app.close();
  });
});

describe('imports — dry-run failure paths (C8)', () => {
  test('an unknown custom field → 400 VALIDATION_FAILED', async () => {
    const app = buildApp();
    const id = (await upload(app, 'Company\nAcme\n')).json<{ id: string }>().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/dry-run`,
      headers: { 'x-actor-id': USER },
      payload: { mapping: { columns: [{ source: 'Company', target: 'custom.nope' }] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  test('a malformed mapping body → 400 VALIDATION_FAILED', async () => {
    const app = buildApp();
    const id = (await upload(app, 'Company\nAcme\n')).json<{ id: string }>().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/dry-run`,
      headers: { 'x-actor-id': USER },
      payload: { mapping: { columns: [] } }, // min(1) violated
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  test('dry-run on an unknown import → 404 NOT_FOUND', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/00000000-0000-4000-8000-0000000000ff/dry-run',
      headers: { 'x-actor-id': USER },
      payload: { mapping: MAPPING },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    await app.close();
  });
});

describe('imports — suppressed emails are imported + flagged (never contacted)', () => {
  test('a suppressed contact email is flagged in the plan and still imported', async () => {
    const app = buildApp();
    const id = (
      await upload(app, 'Company,Website,Email\nSuppCo,suppco.com,sup@suppco.com\n')
    ).json<{ id: string }>().id;

    const dr = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/dry-run`,
      headers: { 'x-actor-id': USER },
      payload: { mapping: MAPPING },
    });
    const plan = dr.json<{
      counts: { suppressedContacts: number };
      rows: { suppressedEmails: string[]; contact: { suppressed: boolean } | null }[];
    }>();
    expect(plan.counts.suppressedContacts).toBe(1);
    expect(plan.rows[0]?.suppressedEmails).toEqual(['sup@suppco.com']);
    expect(plan.rows[0]?.contact?.suppressed).toBe(true);

    // Still imported (the send-safety rails, not this route, prevent contact).
    const commit = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/commit`,
      headers: { 'x-actor-id': USER },
    });
    expect(commit.statusCode).toBe(200);
    expect(await count(ctx.db, 'contacts')).toBe(1);
    await app.close();
  });
});
