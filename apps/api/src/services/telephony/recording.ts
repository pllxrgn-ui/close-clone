import { eq, sql } from 'drizzle-orm';
import { activities, orgSettings, type Db } from '../../db/index.ts';
import { writeAudit } from '../audit/index.ts';
import type { AuditActorType } from '../audit/actions.ts';

/**
 * Call-recording enablement + the §I-REC engine invariant (CONTRACTS §C6 I-REC,
 * §4.5; task 3d). Two responsibilities:
 *
 *  1. The compliance switch. `org_settings.recording_enabled` DEFAULTS OFF and may
 *     only flip through {@link setRecordingEnabled}, which writes the
 *     `admin.compliance_switch_changed` audit row IN THE SAME TRANSACTION as the
 *     update (reusing the 5b audit writer). A flipped switch can therefore never
 *     exist without its ledger entry, and vice-versa — the atomicity 5b's audit
 *     writer was built for. `recording_enabled_by` / `recording_legal_signoff_ref`
 *     track the current enabling actor + legal sign-off, cleared when disabled.
 *
 *  2. The read + invariant helpers the dial path and the property suite consume:
 *     {@link isRecordingEnabled} (the single authority for "may this org record")
 *     and {@link callHasRecordingConsent} (a call carries a `recording_consent_played`
 *     marker) — the two halves §I-REC ANDs together. Recording is armed on a dial
 *     ONLY when the org flag is set AND consent is announced before recording
 *     starts; the adapter refuses to record without a preceding consent event, and
 *     `recording_started`/`recording_completed` never precede the consent marker
 *     (structural in the mock, asserted end-to-end by `recording.property.test.ts`).
 *
 * Encryption-at-rest note (REAL mode HUMAN_TODO): `calls.recording_ref` stores an
 * opaque provider handle, not audio bytes. In real mode the referenced Twilio
 * recording must be fetched over TLS and stored in an encrypted-at-rest bucket
 * (SSE-KMS or equivalent); `recording_ref` then points at that encrypted object.
 * MOCK_MODE holds only a synthetic ref, so no key material is involved here.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export class RecordingSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingSettingsError';
  }
}

/** The `org_settings` singleton row is missing (bootstrap seeds exactly one). */
export class OrgSettingsNotFoundError extends RecordingSettingsError {
  constructor() {
    super('org_settings singleton row not found');
    this.name = 'OrgSettingsNotFoundError';
  }
}

export interface SetRecordingEnabledInput {
  enabled: boolean;
  /** The admin performing the change (audit actor). */
  actorId?: string | null;
  /** Defaults to `user` (a compliance switch is an admin action; tokens pass theirs). */
  actorType?: AuditActorType;
  /** Legal sign-off handle stored while recording is enabled (cleared on disable). */
  legalSignoffRef?: string | null;
  reason?: string | null;
  ip?: string | null;
}

export interface SetRecordingEnabledResult {
  recordingEnabled: boolean;
  /** False when the call was a no-op (already in the requested state, no ledger row). */
  changed: boolean;
  auditId: string | null;
}

interface OrgSettingsSnapshot {
  id: string;
  recordingEnabled: boolean;
  recordingEnabledBy: string | null;
  recordingLegalSignoffRef: string | null;
}

/**
 * Flip `org_settings.recording_enabled` (§I-REC "admin + audit-logged change").
 * The update + its `admin.compliance_switch_changed` audit row commit together.
 * A change that does not alter the effective state (same flag, same sign-off ref)
 * is a no-op: no write, no ledger noise.
 */
export async function setRecordingEnabled(
  db: Db,
  input: SetRecordingEnabledInput,
): Promise<SetRecordingEnabledResult> {
  const actorId = input.actorId ?? null;
  const actorType: AuditActorType = input.actorType ?? 'user';
  // When enabling, carry the sign-off ref forward; disabling clears both fields.
  const nextEnabledBy = input.enabled ? actorId : null;
  const nextSignoff = input.enabled ? (input.legalSignoffRef ?? null) : null;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as Db;
    // Lock the singleton for the txn so two concurrent flips serialise.
    const rows = await tx
      .select({
        id: orgSettings.id,
        recordingEnabled: orgSettings.recordingEnabled,
        recordingEnabledBy: orgSettings.recordingEnabledBy,
        recordingLegalSignoffRef: orgSettings.recordingLegalSignoffRef,
      })
      .from(orgSettings)
      .limit(1)
      .for('update');
    const before = rows[0] as OrgSettingsSnapshot | undefined;
    if (before === undefined) throw new OrgSettingsNotFoundError();

    const unchanged =
      before.recordingEnabled === input.enabled &&
      before.recordingEnabledBy === nextEnabledBy &&
      before.recordingLegalSignoffRef === nextSignoff;
    if (unchanged) {
      return { recordingEnabled: before.recordingEnabled, changed: false, auditId: null };
    }

    await tx
      .update(orgSettings)
      .set({
        recordingEnabled: input.enabled,
        recordingEnabledBy: nextEnabledBy,
        recordingLegalSignoffRef: nextSignoff,
        updatedAt: sql`now()`,
      })
      .where(eq(orgSettings.id, before.id));

    const audit = await writeAudit(tx, {
      action: 'admin.compliance_switch_changed',
      entity: 'org_settings',
      entityId: before.id,
      actorType,
      actorId,
      before: {
        recordingEnabled: before.recordingEnabled,
        recordingEnabledBy: before.recordingEnabledBy,
        recordingLegalSignoffRef: before.recordingLegalSignoffRef,
      },
      after: {
        recordingEnabled: input.enabled,
        recordingEnabledBy: nextEnabledBy,
        recordingLegalSignoffRef: nextSignoff,
      },
      ...(input.reason != null ? { reason: input.reason } : {}),
      ...(input.ip != null ? { ip: input.ip } : {}),
    });

    return { recordingEnabled: input.enabled, changed: true, auditId: audit.id };
  });
}

/**
 * The single authority for "may this org record" (§I-REC). Reads the singleton;
 * a missing row is treated as OFF (DEFAULT OFF), never a throw — a dial must fail
 * closed to not-recording, not fail the call.
 */
export async function isRecordingEnabled(db: Db): Promise<boolean> {
  const rows = await db
    .select({ recordingEnabled: orgSettings.recordingEnabled })
    .from(orgSettings)
    .limit(1);
  return rows[0]?.recordingEnabled ?? false;
}

/**
 * §I-REC other half: does this call carry a `recording_consent_played` marker?
 * A recording ref may exist on a call ONLY if this returns true — the DB-level
 * expression of "consent precedes recording", asserted by the property suite.
 */
export async function callHasRecordingConsent(
  db: Db,
  leadId: string,
  callId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: activities.id })
    .from(activities)
    .where(
      sql`${activities.leadId} = ${leadId} AND ${activities.type} = 'recording_consent_played' AND ${activities.payload}->>'callId' = ${callId}`,
    )
    .limit(1);
  return rows.length > 0;
}
