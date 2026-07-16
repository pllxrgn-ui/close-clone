import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';

import { auditLog, orgSettings, suppressions, users } from '../db/index.ts';
import { createTestDb, type TestDb } from '../db/test-helpers.ts';
import { registerAdminCrudRoutes } from './admin-crud.ts';

/**
 * TASK R4 — admin CRUD routes over real Postgres (PGlite). Verifies the injected
 * admin guard, the exact web-facing shapes (bare `CustomFieldRow[]`, `OrgSettings`
 * singleton), the create-field validation parity with the MSW, the I-REC recording
 * gate (403 bare, audited flip with sign-off), and the blessed suppression release
 * (audited; reason-required; not-found / already-released failure paths).
 */

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const REP = '00000000-0000-4000-8000-0000000000a2';

const allowGuard: preHandlerHookHandler = async () => {};
const denyGuard: preHandlerHookHandler = async (_req, reply) =>
  reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'admin required' } });

let ctx: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb();
  await ctx.db.insert(users).values([
    { id: ADMIN, email: 'admin@x.test', name: 'Ada Admin', role: 'admin', idpSubject: 'idp|a1' },
    { id: REP, email: 'rep@x.test', name: 'Rex Rep', role: 'rep', idpSubject: 'idp|a2' },
  ]);
  await ctx.db.insert(orgSettings).values({
    dailySendCap: 200,
    companyTimezone: 'America/New_York',
    quietHours: { start: '08:00', end: '21:00', tz: 'recipient-local' },
    sendingWindow: { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  });

  app = Fastify({ logger: false });
  registerAdminCrudRoutes(app, {
    db: ctx.db,
    adminGuard: allowGuard,
    resolveActorId: () => ADMIN,
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('admin guard', () => {
  test('deny guard → 403, handler never runs', async () => {
    const denyApp = Fastify({ logger: false });
    registerAdminCrudRoutes(denyApp, { db: ctx.db, adminGuard: denyGuard });
    await denyApp.ready();
    const res = await denyApp.inject({ method: 'GET', url: '/api/v1/admin/users' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await denyApp.close();
  });
});

describe('GET /admin/users (full shape)', () => {
  test('returns the full user DTO as a bare array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/users' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    const admin = body.find((u: { id: string }) => u.id === ADMIN);
    expect(admin).toMatchObject({
      id: ADMIN,
      email: 'admin@x.test',
      name: 'Ada Admin',
      role: 'admin',
      isActive: true,
      timezone: 'UTC',
    });
    expect(typeof admin.createdAt).toBe('string');
    expect(admin.createdAt).toMatch(/T.*Z$/);
    // The full shape never leaks idp_subject.
    expect('idpSubject' in admin).toBe(false);
  });
});

describe('PATCH /admin/users/:id (is_active)', () => {
  test('flips is_active and writes an admin.user_changed audit row', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${REP}`,
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);

    const audit = await ctx.db
      .select({ action: auditLog.action, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'user'), eq(auditLog.entityId, REP)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'admin.user_changed', actorId: ADMIN });

    // Re-activate to leave state clean.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${REP}`,
      payload: { is_active: true },
    });
  });

  test('unknown user → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/00000000-0000-4000-8000-0000000000ff`,
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  test('non-boolean isActive → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${REP}`,
      payload: { isActive: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  test('non-uuid id → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/users/not-a-uuid',
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('custom fields', () => {
  test('GET returns a bare CustomFieldRow[] (no timestamps)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/custom-fields' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  test('POST creates a field (201) with the exact row shape + audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: {
        entity: 'lead',
        key: 'segment',
        label: 'Segment',
        type: 'select',
        options: ['SMB', 'Ent'],
      },
    });
    expect(res.statusCode).toBe(201);
    const field = res.json();
    expect(field).toMatchObject({
      entity: 'lead',
      key: 'segment',
      label: 'Segment',
      type: 'select',
      options: ['SMB', 'Ent'],
      required: false,
    });
    expect(typeof field.id).toBe('string');
    // Timestamp-free row (matches the web CustomFieldRow / view-builder shape).
    expect('createdAt' in field).toBe(false);

    const audit = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'custom_field_def'), eq(auditLog.entityId, field.id)));
    expect(audit[0]?.action).toBe('admin.custom_field_created');
  });

  test('duplicate (entity,key) → 409 CONFLICT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: { entity: 'lead', key: 'segment', label: 'Dup', type: 'text' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(res.json().error.details.field).toBe('key');
  });

  test('bad entity → 400 (message parity with MSW)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: { entity: 'account', key: 'x', label: 'X', type: 'text' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('entity must be lead, contact, or opportunity');
  });

  test('non-snake_case key → 400 field:key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: { entity: 'lead', key: 'Bad Key', label: 'X', type: 'text' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.field).toBe('key');
  });

  test('empty label → 400 field:label', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: { entity: 'lead', key: 'good_key', label: '   ', type: 'text' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.field).toBe('label');
  });

  test('invalid type → 400 field:type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: { entity: 'lead', key: 'k2', label: 'K2', type: 'boolean' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.field).toBe('type');
    expect(res.json().error.message).toBe('type must be one of text, number, date, select, user');
  });

  test('select without options → 400 field:options', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: { entity: 'lead', key: 'k3', label: 'K3', type: 'select' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.field).toBe('options');
  });

  test('PATCH updates label + required (audited)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: { entity: 'contact', key: 'persona', label: 'Persona', type: 'text' },
    });
    const id = created.json().id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/custom-fields/${id}`,
      payload: { label: 'Buyer persona', required: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: 'Buyer persona', required: true });
    const audit = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'custom_field_def'), eq(auditLog.entityId, id)));
    expect(audit.some((a) => a.action === 'admin.custom_field_updated')).toBe(true);
  });

  test('DELETE removes the field (204) + audit; re-DELETE → 404', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      payload: { entity: 'opportunity', key: 'forecast', label: 'Forecast', type: 'text' },
    });
    const id = created.json().id;
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/admin/custom-fields/${id}` });
    expect(del.statusCode).toBe(204);
    const audit = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'custom_field_def'), eq(auditLog.entityId, id)));
    expect(audit.some((a) => a.action === 'admin.custom_field_deleted')).toBe(true);

    const again = await app.inject({ method: 'DELETE', url: `/api/v1/admin/custom-fields/${id}` });
    expect(again.statusCode).toBe(404);
  });
});

describe('org settings', () => {
  test('GET returns the OrgSettings singleton', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/org-settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      recordingEnabled: false,
      dailySendCap: 200,
      companyTimezone: 'America/New_York',
    });
  });

  test('PATCH dailySendCap within range → 200 updated', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/org-settings',
      payload: { dailySendCap: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dailySendCap).toBe(500);
    // restore
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/org-settings',
      payload: { dailySendCap: 200 },
    });
  });

  test('PATCH dailySendCap out of range → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/org-settings',
      payload: { dailySendCap: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.field).toBe('dailySendCap');
  });

  test('bare recordingEnabled → 403 (I-REC, matches MSW)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/org-settings',
      payload: { recordingEnabled: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    const settings = await app.inject({ method: 'GET', url: '/api/v1/admin/org-settings' });
    expect(settings.json().recordingEnabled).toBe(false);
  });

  test('recordingEnabled WITH legal sign-off → flips + audits (admin.compliance_switch_changed)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/org-settings',
      payload: { recordingEnabled: true, legalSignoffRef: 'legal-2026-07', reason: 'GC signed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().recordingEnabled).toBe(true);
    expect(res.json().recordingLegalSignoffRef).toBe('legal-2026-07');

    const audit = await ctx.db
      .select({ action: auditLog.action, reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'org_settings')));
    expect(audit.some((a) => a.action === 'admin.compliance_switch_changed')).toBe(true);

    // disable again (also audited path).
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/org-settings',
      payload: { recordingEnabled: false, legalSignoffRef: 'n/a' },
    });
  });
});

describe('suppressions', () => {
  test('POST add (email) → 201 with the suppression row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/suppressions',
      payload: { kind: 'email', value: 'block@x.test', reason: 'manual test' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: 'email',
      value: 'block@x.test',
      source: 'manual',
      reason: 'manual test',
      releasedAt: null,
    });
  });

  test('POST add (phone) normalizes to the 10-digit key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/suppressions',
      payload: { kind: 'phone', value: '+1 (305) 555-0147' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'phone', value: '3055550147', source: 'manual' });
  });

  test('POST add invalid kind → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/suppressions',
      payload: { kind: 'fax', value: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.field).toBe('kind');
  });

  test('GET lists suppressions (keyset envelope)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/suppressions?active=true' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  test('release requires a reason → 400', async () => {
    const [row] = await ctx.db
      .insert(suppressions)
      .values({ kind: 'email', value: 'rel1@x.test', source: 'manual' })
      .returning({ id: suppressions.id });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/suppressions/${row!.id}/release`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.field).toBe('reason');
  });

  test('release with reason → 200, audited (admin.suppression_released), then 409 on re-release', async () => {
    const [row] = await ctx.db
      .insert(suppressions)
      .values({ kind: 'email', value: 'rel2@x.test', source: 'manual' })
      .returning({ id: suppressions.id });
    const id = row!.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/suppressions/${id}/release`,
      payload: { reason: 'false positive' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().releasedAt).not.toBeNull();
    expect(res.json().releaseReason).toBe('false positive');

    const audit = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'suppression'), eq(auditLog.entityId, id)));
    expect(audit[0]?.action).toBe('admin.suppression_released');

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/suppressions/${id}/release`,
      payload: { reason: 'again' },
    });
    expect(again.statusCode).toBe(409);
  });

  test('release unknown id → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/suppressions/00000000-0000-4000-8000-0000000000fe/release',
      payload: { reason: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});
