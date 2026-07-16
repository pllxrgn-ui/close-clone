import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, orgSettings, type Db } from '../../db/index.ts';
import { createTestDb, type TestDb } from '../../db/test-helpers.ts';
import {
  OrgSettingsNotFoundError,
  callHasRecordingConsent,
  isRecordingEnabled,
  setRecordingEnabled,
} from './recording.ts';
import { seedOrgSettings, seedUser } from './test-helpers.ts';

/**
 * Recording enablement (task 3d): the §I-REC compliance switch is admin + audit
 * logged, DEFAULTS OFF, and the flip + its ledger row commit atomically. Failure
 * paths: missing singleton, no-op re-affirm (no ledger noise), disable clears the
 * enabling actor + legal sign-off.
 */

let ctx: TestDb;
let db: Db;
let admin: string;

async function readOrg(): Promise<{
  recordingEnabled: boolean;
  recordingEnabledBy: string | null;
  recordingLegalSignoffRef: string | null;
}> {
  const rows = await db
    .select({
      recordingEnabled: orgSettings.recordingEnabled,
      recordingEnabledBy: orgSettings.recordingEnabledBy,
      recordingLegalSignoffRef: orgSettings.recordingLegalSignoffRef,
    })
    .from(orgSettings)
    .limit(1);
  return rows[0]!;
}

async function complianceAuditRows(): Promise<(typeof auditLog.$inferSelect)[]> {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'admin.compliance_switch_changed')));
}

beforeEach(async () => {
  ctx = await createTestDb();
  db = ctx.db;
  admin = await seedUser(db, { name: 'Admin', role: 'admin' });
}, 120_000);

afterEach(async () => {
  await ctx.close();
});

describe('default OFF', () => {
  test('a freshly-seeded org does not record', async () => {
    await seedOrgSettings(db);
    expect(await isRecordingEnabled(db)).toBe(false);
  });

  test('isRecordingEnabled fails closed (false) when the singleton is absent', async () => {
    expect(await isRecordingEnabled(db)).toBe(false);
  });
});

describe('setRecordingEnabled — atomic switch + audit', () => {
  test('enabling flips the flag, stamps actor + sign-off, and writes one audit row', async () => {
    await seedOrgSettings(db, { recordingEnabled: false });
    const res = await setRecordingEnabled(db, {
      enabled: true,
      actorId: admin,
      legalSignoffRef: 'legal-signoff-2026-07',
      reason: 'two-party consent counsel sign-off',
    });
    expect(res).toMatchObject({ recordingEnabled: true, changed: true });
    expect(res.auditId).not.toBeNull();

    const org = await readOrg();
    expect(org.recordingEnabled).toBe(true);
    expect(org.recordingEnabledBy).toBe(admin);
    expect(org.recordingLegalSignoffRef).toBe('legal-signoff-2026-07');

    const audits = await complianceAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entity: 'org_settings',
      actorId: admin,
      actorType: 'user',
      reason: 'two-party consent counsel sign-off',
    });
    expect((audits[0]?.after as { recordingEnabled?: boolean }).recordingEnabled).toBe(true);
    expect((audits[0]?.before as { recordingEnabled?: boolean }).recordingEnabled).toBe(false);
  });

  test('disabling clears the enabling actor + sign-off and audits the flip', async () => {
    await seedOrgSettings(db);
    await setRecordingEnabled(db, { enabled: true, actorId: admin, legalSignoffRef: 'ref-1' });
    const res = await setRecordingEnabled(db, { enabled: false, actorId: admin });
    expect(res).toMatchObject({ recordingEnabled: false, changed: true });

    const org = await readOrg();
    expect(org.recordingEnabledBy).toBeNull();
    expect(org.recordingLegalSignoffRef).toBeNull();
    expect(await complianceAuditRows()).toHaveLength(2);
  });

  test('re-affirming the same state is a no-op — no write, no ledger row', async () => {
    await seedOrgSettings(db);
    await setRecordingEnabled(db, { enabled: true, actorId: admin, legalSignoffRef: 'ref-1' });
    const again = await setRecordingEnabled(db, {
      enabled: true,
      actorId: admin,
      legalSignoffRef: 'ref-1',
    });
    expect(again).toMatchObject({ recordingEnabled: true, changed: false, auditId: null });
    expect(await complianceAuditRows()).toHaveLength(1);
  });

  test('changing only the legal sign-off ref while enabled audits the change', async () => {
    await seedOrgSettings(db);
    await setRecordingEnabled(db, { enabled: true, actorId: admin, legalSignoffRef: 'ref-1' });
    const res = await setRecordingEnabled(db, {
      enabled: true,
      actorId: admin,
      legalSignoffRef: 'ref-2',
    });
    expect(res.changed).toBe(true);
    expect((await readOrg()).recordingLegalSignoffRef).toBe('ref-2');
    expect(await complianceAuditRows()).toHaveLength(2);
  });

  test('a missing org_settings singleton throws OrgSettingsNotFoundError (no audit)', async () => {
    await expect(setRecordingEnabled(db, { enabled: true, actorId: admin })).rejects.toBeInstanceOf(
      OrgSettingsNotFoundError,
    );
    expect(await complianceAuditRows()).toHaveLength(0);
  });
});

describe('callHasRecordingConsent', () => {
  test('is false for a call with no consent marker', async () => {
    await seedOrgSettings(db);
    expect(
      await callHasRecordingConsent(
        db,
        '00000000-0000-4000-8000-0000000000aa',
        '00000000-0000-4000-8000-0000000000bb',
      ),
    ).toBe(false);
  });
});
