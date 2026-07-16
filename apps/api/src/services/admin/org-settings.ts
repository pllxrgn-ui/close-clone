import { eq } from 'drizzle-orm';
import type { OrgSettings } from '@switchboard/shared';
import { orgSettings, type Db } from '../../db/index.ts';
import { setRecordingEnabled } from '../telephony/recording.ts';
import { AdminForbiddenError, AdminNotFoundError, AdminValidationError } from './errors.ts';
import type { AdminActor } from './types.ts';

/**
 * Org-settings singleton (CONTRACTS §C1 `org_settings`, §C7 `admin/*`). Serves the
 * web's `GET /admin/org-settings` + `PATCH /admin/org-settings` (daily send cap).
 *
 * Compliance rails honored exactly as the MSW does:
 *   - I-REC: `recordingEnabled` cannot be flipped from the plain settings PATCH.
 *     A bare toggle is refused 403 (matching the shipped web). The ONLY way to
 *     move the switch is with an explicit legal sign-off reference, which routes
 *     through {@link setRecordingEnabled} (admin + audit-logged, atomic) — the
 *     sanctioned I-REC path, never a raw column write.
 *   - `dailySendCap` is the rate cap the send engine reads; it is bounded here.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const RECORDING_REFUSED =
  'Call recording requires legal sign-off and cannot be enabled from settings';

const SELECT_COLS = {
  id: orgSettings.id,
  recordingEnabled: orgSettings.recordingEnabled,
  recordingEnabledBy: orgSettings.recordingEnabledBy,
  recordingLegalSignoffRef: orgSettings.recordingLegalSignoffRef,
  quietHours: orgSettings.quietHours,
  sendingWindow: orgSettings.sendingWindow,
  dailySendCap: orgSettings.dailySendCap,
  companyTimezone: orgSettings.companyTimezone,
  createdAt: orgSettings.createdAt,
  updatedAt: orgSettings.updatedAt,
} as const;

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function toDto(r: {
  id: string;
  recordingEnabled: boolean;
  recordingEnabledBy: string | null;
  recordingLegalSignoffRef: string | null;
  quietHours: Record<string, unknown> | null;
  sendingWindow: Record<string, unknown> | null;
  dailySendCap: number;
  companyTimezone: string;
  createdAt: string;
  updatedAt: string;
}): OrgSettings {
  return {
    id: r.id,
    recordingEnabled: r.recordingEnabled,
    recordingEnabledBy: r.recordingEnabledBy,
    recordingLegalSignoffRef: r.recordingLegalSignoffRef,
    quietHours: r.quietHours,
    sendingWindow: r.sendingWindow,
    dailySendCap: r.dailySendCap,
    companyTimezone: r.companyTimezone,
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  };
}

async function readSingleton(db: Db): Promise<OrgSettings> {
  const rows = await db.select(SELECT_COLS).from(orgSettings).limit(1);
  const row = rows[0];
  if (row === undefined) throw new AdminNotFoundError('org settings not found');
  return toDto(row);
}

/** Read the org-settings singleton. */
export function getOrgSettings(db: Db): Promise<OrgSettings> {
  return readSingleton(db);
}

export interface PatchOrgSettingsInput {
  dailySendCap?: unknown;
  quietHours?: unknown;
  sendingWindow?: unknown;
  recordingEnabled?: unknown;
  /** Legal sign-off handle; presence is what authorizes a recording flip (I-REC). */
  legalSignoffRef?: unknown;
  reason?: unknown;
}

function isJsonObjectOrNull(v: unknown): v is Record<string, unknown> | null {
  return v === null || (typeof v === 'object' && v !== null && !Array.isArray(v));
}

/**
 * Patch the org-settings singleton. `dailySendCap` / `quietHours` / `sendingWindow`
 * update in place; `recordingEnabled` is gated on a legal sign-off ref and routed
 * through the audited recording switch, else refused 403 (the shipped-web behavior).
 */
export async function patchOrgSettings(
  db: Db,
  input: PatchOrgSettingsInput,
  actor: AdminActor,
): Promise<OrgSettings> {
  // I-REC gate — resolve the recording flip first so its audit is atomic.
  if (input.recordingEnabled !== undefined) {
    if (typeof input.recordingEnabled !== 'boolean') {
      throw new AdminValidationError('recordingEnabled must be a boolean', {
        field: 'recordingEnabled',
      });
    }
    const signoff = typeof input.legalSignoffRef === 'string' ? input.legalSignoffRef.trim() : '';
    // No sign-off ref → the plain settings toggle: refused, exactly like the MSW.
    if (signoff.length === 0) {
      throw new AdminForbiddenError(RECORDING_REFUSED);
    }
    await setRecordingEnabled(db, {
      enabled: input.recordingEnabled,
      actorId: actor.id,
      actorType: actor.type,
      legalSignoffRef: signoff,
      ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
      ip: actor.ip,
    });
  }

  const set: Partial<typeof orgSettings.$inferInsert> = {};
  if (input.dailySendCap !== undefined) {
    const cap = input.dailySendCap;
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > 100_000) {
      throw new AdminValidationError('dailySendCap must be an integer between 1 and 100000', {
        field: 'dailySendCap',
      });
    }
    set.dailySendCap = cap;
  }
  if (input.quietHours !== undefined) {
    if (!isJsonObjectOrNull(input.quietHours)) {
      throw new AdminValidationError('quietHours must be an object or null', {
        field: 'quietHours',
      });
    }
    set.quietHours = input.quietHours;
  }
  if (input.sendingWindow !== undefined) {
    if (!isJsonObjectOrNull(input.sendingWindow)) {
      throw new AdminValidationError('sendingWindow must be an object or null', {
        field: 'sendingWindow',
      });
    }
    set.sendingWindow = input.sendingWindow;
  }

  if (Object.keys(set).length > 0) {
    const current = await db.select({ id: orgSettings.id }).from(orgSettings).limit(1);
    const id = current[0]?.id;
    if (id === undefined) throw new AdminNotFoundError('org settings not found');
    set.updatedAt = new Date().toISOString();
    await db.update(orgSettings).set(set).where(eq(orgSettings.id, id));
  }

  return readSingleton(db);
}
