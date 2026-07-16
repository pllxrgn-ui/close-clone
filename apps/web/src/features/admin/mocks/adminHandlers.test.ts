import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiError } from '../../../api/index.ts';
import { db } from '../../../mocks/fixtures.ts';
import { server } from '../../../mocks/server.ts';
import {
  createCustomField,
  enrollLeads,
  getOrgSettings,
  listCustomFields,
  listSequences,
  listSnippets,
  listTemplates,
  patchLead,
  updateDailySendCap,
  updateSnippet,
  updateTemplate,
} from '../api.ts';
import { adminHandlers } from './adminHandlers.ts';
import { adminStore, resetAdminStore } from './adminStore.ts';

/*
 * MSW-layer contract tests: every admin/bulk endpoint mutates the module-scope
 * store (or the shared leads db) and speaks the C7 envelope + C8 error shapes.
 * Failure paths (validation, conflict, not-found, and the compliance rails) are
 * asserted alongside the happy paths.
 */

/** Snapshot the mutable fields of a lead so PATCH tests don't pollute siblings. */
function snapshotLead(id: string): () => void {
  const lead = db.leads.find((l) => l.id === id);
  if (!lead) throw new Error(`no lead ${id}`);
  const { ownerId, statusId, dnc, updatedAt } = lead;
  return () => {
    lead.ownerId = ownerId;
    lead.statusId = statusId;
    lead.dnc = dnc;
    lead.updatedAt = updatedAt;
  };
}

async function expectApiError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe(code);
    expect(apiErr.status).toBe(status);
    return apiErr;
  }
  throw new Error('expected the request to reject');
}

let restores: Array<() => void> = [];
beforeEach(() => {
  resetAdminStore();
  server.use(...adminHandlers);
  restores = [];
});
afterEach(() => {
  for (const restore of restores) restore();
});

describe('custom fields', () => {
  test('GET returns the seed and POST appends a create-aware row', async () => {
    const before = await listCustomFields();
    expect(before.length).toBeGreaterThan(0);

    const created = await createCustomField({
      entity: 'lead',
      key: 'account_tier',
      label: 'Account tier',
      type: 'select',
      options: ['Gold', 'Silver'],
    });
    expect(created.key).toBe('account_tier');
    expect(created.options).toEqual(['Gold', 'Silver']);

    const after = await listCustomFields();
    expect(after.length).toBe(before.length + 1);
    expect(after.some((f) => f.key === 'account_tier')).toBe(true);
  });

  test('rejects a non-snake_case key (VALIDATION_FAILED 400)', async () => {
    await expectApiError(
      createCustomField({ entity: 'lead', key: 'Account Tier', label: 'x', type: 'text' }),
      'VALIDATION_FAILED',
      400,
    );
  });

  test('rejects a duplicate key per entity (CONFLICT 409)', async () => {
    await expectApiError(
      createCustomField({ entity: 'lead', key: 'segment', label: 'Segment', type: 'text' }),
      'CONFLICT',
      409,
    );
  });

  test('rejects a select field with no options (VALIDATION_FAILED 400)', async () => {
    await expectApiError(
      createCustomField({ entity: 'lead', key: 'tier', label: 'Tier', type: 'select' }),
      'VALIDATION_FAILED',
      400,
    );
  });
});

describe('templates + snippets', () => {
  test('PATCH edits a template body and persists to the store', async () => {
    const [tpl] = await listTemplates();
    if (!tpl) throw new Error('no templates seeded');
    const updated = await updateTemplate(tpl.id, { body: 'New body copy' });
    expect(updated.body).toBe('New body copy');
    expect(adminStore.templates.find((t) => t.id === tpl.id)?.body).toBe('New body copy');
  });

  test('PATCH on an unknown template is NOT_FOUND 404', async () => {
    await expectApiError(updateTemplate('nope', { body: 'x' }), 'NOT_FOUND', 404);
  });

  test('rejects an empty snippet body (VALIDATION_FAILED 400)', async () => {
    const [snp] = await listSnippets();
    if (!snp) throw new Error('no snippets seeded');
    await expectApiError(updateSnippet(snp.id, { body: '' }), 'VALIDATION_FAILED', 400);
  });
});

describe('org settings', () => {
  test('the daily cap is editable and persists', async () => {
    const before = await getOrgSettings();
    expect(before.recordingEnabled).toBe(false);
    const updated = await updateDailySendCap(350);
    expect(updated.dailySendCap).toBe(350);
    expect((await getOrgSettings()).dailySendCap).toBe(350);
  });

  test('rejects a non-positive cap (VALIDATION_FAILED 400)', async () => {
    await expectApiError(updateDailySendCap(0), 'VALIDATION_FAILED', 400);
  });

  test('refuses to enable recording via the API — legal sign-off only (FORBIDDEN 403)', async () => {
    // I-REC: the rail cannot be flipped from settings.
    const { apiRequest } = await import('../../../api/client.ts');
    await expectApiError(
      apiRequest('/admin/org-settings', { method: 'PATCH', body: { recordingEnabled: true } }),
      'FORBIDDEN',
      403,
    );
  });
});

describe('bulk enroll (I-DNC honored)', () => {
  test('enrolls non-DNC leads and skips DNC ones, ticking the count', async () => {
    const dncLead = db.leads.find((l) => l.dnc);
    const okLead = db.leads.find((l) => !l.dnc);
    if (!dncLead || !okLead) throw new Error('fixture needs a DNC and a non-DNC lead');

    const seqs = await listSequences();
    const seq = seqs.find((s) => s.status === 'active');
    if (!seq) throw new Error('no active sequence');
    const startCount = seq.activeEnrollments;

    const result = await enrollLeads(seq.id, [okLead.id, dncLead.id]);
    expect(result.enrolled).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skipReason).toBe('dnc');
    expect(result.activeEnrollments).toBe(startCount + 1);
    expect(adminStore.sequences.find((s) => s.id === seq.id)?.activeEnrollments).toBe(
      startCount + 1,
    );
  });

  test('rejects enrolling into an archived sequence (VALIDATION_FAILED 422)', async () => {
    const okLead = db.leads.find((l) => !l.dnc);
    if (!okLead) throw new Error('need a lead');
    await expectApiError(enrollLeads('seq-winback-2024', [okLead.id]), 'VALIDATION_FAILED', 422);
  });

  test('rejects an empty selection (VALIDATION_FAILED 400)', async () => {
    await expectApiError(enrollLeads('seq-onboarding', []), 'VALIDATION_FAILED', 400);
  });
});

describe('bulk lead field mutations (leads CRUD)', () => {
  test('assigns an owner and persists to the shared leads db', async () => {
    const lead = db.leads[0];
    if (!lead) throw new Error('no leads');
    restores.push(snapshotLead(lead.id));
    const newOwner = db.users[1]?.id ?? '';
    const updated = await patchLead(lead.id, { ownerId: newOwner });
    expect(updated.ownerId).toBe(newOwner);
    expect(db.leads.find((l) => l.id === lead.id)?.ownerId).toBe(newOwner);
  });

  test('set-DNC requires a reason (VALIDATION_FAILED 400), then flips with one', async () => {
    const lead = db.leads.find((l) => !l.dnc);
    if (!lead) throw new Error('need a non-DNC lead');
    restores.push(snapshotLead(lead.id));

    const { apiRequest } = await import('../../../api/client.ts');
    await expectApiError(
      apiRequest(`/leads/${lead.id}`, { method: 'PATCH', body: { dnc: true } }),
      'VALIDATION_FAILED',
      400,
    );
    expect(db.leads.find((l) => l.id === lead.id)?.dnc).toBe(false);

    const updated = await patchLead(lead.id, { dnc: true, reason: 'Requested by contact' });
    expect(updated.dnc).toBe(true);
    expect(db.leads.find((l) => l.id === lead.id)?.dnc).toBe(true);
  });

  test('PATCH on an unknown lead is NOT_FOUND 404', async () => {
    await expectApiError(patchLead('nope', { statusId: 'x' }), 'NOT_FOUND', 404);
  });
});
