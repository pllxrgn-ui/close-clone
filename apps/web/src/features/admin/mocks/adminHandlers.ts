/*
 * MSW handlers for the admin settings + bulk surfaces. Shapes match CONTRACTS
 * §C7 exactly (`/api/v1` base, camelCase JSON, `{error:{code}}` bodies per C8).
 * Registered two ways, like the other feature handler sets:
 *   - tests: `server.use(...adminHandlers)` (runtime handlers take priority),
 *   - dev/prod runtime: the orchestrator spreads it into the MSW handler list at
 *     merge — see the task report's routeWiring (spread BEFORE viewBuilderHandlers
 *     so the create-aware GET /admin/custom-fields supersedes the static one).
 *
 * Compliance rails are honored here, never bypassed (C6):
 *   - bulk enroll never enrolls a DNC lead (I-DNC),
 *   - a DNC set/clear requires an audit reason (C1 audit_log.reason),
 *   - enabling call recording via the API is refused — legal sign-off only (I-REC).
 */
import { http, HttpResponse } from 'msw';
import type { Lead } from '@switchboard/shared';
import { customFieldTypeValues } from '@switchboard/shared';
import { readStoredUser } from '../../../auth/auth.ts';
import { db } from '../../../mocks/fixtures.ts';
import type { CustomFieldRow, EnrollResult } from '../types.ts';
import { adminStore } from './adminStore.ts';

const api = (path: string): string => `*/api/v1${path}`;

function errorJson(status: number, code: string, message: string, details?: unknown) {
  const body =
    details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return HttpResponse.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const nowIso = (): string => new Date().toISOString();

export const adminHandlers = [
  // ── Personal Gmail account linking ────────────────────────────────────────
  http.get(api('/email-accounts'), () => {
    const user = readStoredUser();
    if (!user) return errorJson(401, 'UNAUTHENTICATED', 'No active session');
    return HttpResponse.json(
      adminStore.emailAccounts.filter((account) => account.userId === user.id),
    );
  }),
  http.post(api('/oauth/gmail/start'), async ({ request }) => {
    const user = readStoredUser();
    if (!user) return errorJson(401, 'UNAUTHENTICATED', 'No active session');
    const body = await readJson(request);
    const address = typeof body?.address === 'string' ? body.address.trim().toLowerCase() : '';
    if (!/^\S+@\S+\.\S+$/.test(address)) {
      return errorJson(400, 'VALIDATION_FAILED', 'Enter a valid Gmail address', {
        field: 'address',
      });
    }
    const timestamp = nowIso();
    let account = adminStore.emailAccounts.find(
      (candidate) => candidate.userId === user.id && candidate.address === address,
    );
    if (account) {
      account.syncStatus = 'LIVE';
      account.updatedAt = timestamp;
    } else {
      account = {
        id: crypto.randomUUID(),
        userId: user.id,
        address,
        provider: 'gmail',
        syncStatus: 'LIVE',
        historyCursor: null,
        backfillCheckpoint: null,
        dailySendCount: 0,
        dailyCountDate: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      adminStore.emailAccounts.push(account);
    }
    return HttpResponse.json({
      accountId: account.id,
      authUrl: '/settings?section=inboxes&gmail=connected',
    });
  }),
  http.delete(api('/email-accounts/:id'), ({ params }) => {
    const user = readStoredUser();
    if (!user) return errorJson(401, 'UNAUTHENTICATED', 'No active session');
    const account = adminStore.emailAccounts.find(
      (candidate) => candidate.id === String(params.id) && candidate.userId === user.id,
    );
    if (!account) return errorJson(404, 'NOT_FOUND', 'Email account not found');
    account.syncStatus = 'REAUTH_REQUIRED';
    account.historyCursor = null;
    account.backfillCheckpoint = null;
    account.updatedAt = nowIso();
    return new HttpResponse(null, { status: 204 });
  }),

  // ── Reference: sequences (with live enrollment counts) ─────────────────────
  http.get(api('/sequences'), () => HttpResponse.json(adminStore.sequences)),

  // ── Bulk enroll over an explicit selection (C7 POST /sequences/:id/enroll) ──
  // I-DNC: DNC leads are never enrolled; the count split surfaces the rail.
  //
  // Body-shape routing. MSW is first-match-wins and this handler is registered
  // BEFORE comms' (see mocks/browser.ts + server.ts). The same C7 path also serves
  // the single-contact enroll the sequence drawer POSTs as {leadId, contactId};
  // that one is owned by comms' handler. This handler owns only the BULK
  // {leadIds:[...]} body — so when the body is not a bulk body, return undefined to
  // fall through to comms rather than 400 on the missing leadIds. We read a CLONE
  // for the shape probe so the original request body stays unconsumed for the comms
  // handler that answers next.
  http.post(api('/sequences/:id/enroll'), async ({ params, request }) => {
    const body = await readJson(request.clone());
    if (!body || !Array.isArray(body.leadIds)) return undefined;

    const seq = adminStore.sequences.find((s) => s.id === String(params.id));
    if (!seq) return errorJson(404, 'NOT_FOUND', 'Sequence not found');
    if (seq.status !== 'active') {
      return errorJson(422, 'VALIDATION_FAILED', 'Cannot enroll into an archived sequence');
    }
    if (body.leadIds.length === 0) {
      return errorJson(400, 'VALIDATION_FAILED', 'leadIds must be a non-empty array');
    }
    const ids = new Set(body.leadIds.map(String));
    const selected = db.leads.filter((l) => ids.has(l.id));
    const enrollable = selected.filter((l) => !l.dnc);
    const skipped = selected.length - enrollable.length;
    seq.activeEnrollments += enrollable.length;
    const result: EnrollResult = {
      sequenceId: seq.id,
      enrolled: enrollable.length,
      skipped,
      ...(skipped > 0 ? { skipReason: 'dnc' as const } : {}),
      activeEnrollments: seq.activeEnrollments,
    };
    return HttpResponse.json(result);
  }),

  // ── Bulk field mutations over the selection (C7 leads CRUD `PATCH /leads/:id`)
  http.patch(api('/leads/:id'), async ({ params, request }) => {
    const lead = db.leads.find((l) => l.id === String(params.id));
    if (!lead) return errorJson(404, 'NOT_FOUND', 'Lead not found');
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');

    // DNC set/clear must carry an audit reason (C1 audit_log.reason) — the rail's
    // paper trail, never a silent flip.
    if (typeof body.dnc === 'boolean') {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length === 0) {
        return errorJson(400, 'VALIDATION_FAILED', 'A reason is required to change DNC', {
          field: 'reason',
        });
      }
      lead.dnc = body.dnc;
    }
    if (body.ownerId !== undefined) {
      if (typeof body.ownerId !== 'string') {
        return errorJson(400, 'VALIDATION_FAILED', 'ownerId must be a user id');
      }
      lead.ownerId = body.ownerId;
    }
    if (body.statusId !== undefined) {
      if (typeof body.statusId !== 'string') {
        return errorJson(400, 'VALIDATION_FAILED', 'statusId must be a status id');
      }
      lead.statusId = body.statusId;
    }
    lead.updatedAt = nowIso();
    return HttpResponse.json(lead satisfies Lead);
  }),

  // ── Custom fields (C7 admin/custom-fields) ─────────────────────────────────
  http.get(api('/admin/custom-fields'), () => HttpResponse.json(adminStore.customFields)),
  http.post(api('/admin/custom-fields'), async ({ request }) => {
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    const entity = body.entity;
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const type = body.type;

    if (entity !== 'lead' && entity !== 'contact' && entity !== 'opportunity') {
      return errorJson(400, 'VALIDATION_FAILED', 'entity must be lead, contact, or opportunity');
    }
    if (!SNAKE_CASE.test(key)) {
      return errorJson(400, 'VALIDATION_FAILED', 'key must be snake_case (a–z, 0–9, _)', {
        field: 'key',
      });
    }
    if (label.length === 0) {
      return errorJson(400, 'VALIDATION_FAILED', 'label is required', { field: 'label' });
    }
    if (typeof type !== 'string' || !(customFieldTypeValues as readonly string[]).includes(type)) {
      return errorJson(
        400,
        'VALIDATION_FAILED',
        `type must be one of ${customFieldTypeValues.join(', ')}`,
        {
          field: 'type',
        },
      );
    }
    if (adminStore.customFields.some((f) => f.entity === entity && f.key === key)) {
      return errorJson(409, 'CONFLICT', `A ${entity} field with key "${key}" already exists`, {
        field: 'key',
      });
    }
    const options =
      type === 'select' && Array.isArray(body.options)
        ? body.options.map(String).filter((o) => o.length > 0)
        : null;
    if (type === 'select' && (!options || options.length === 0)) {
      return errorJson(400, 'VALIDATION_FAILED', 'select fields need at least one option', {
        field: 'options',
      });
    }
    const field: CustomFieldRow = {
      id: `cf-${entity}-${key}-${crypto.randomUUID().slice(0, 8)}`,
      entity,
      key,
      label,
      type: type as CustomFieldRow['type'],
      options,
      required: body.required === true,
    };
    adminStore.customFields.push(field);
    return HttpResponse.json(field, { status: 201 });
  }),

  // ── Templates (C7 templates) ───────────────────────────────────────────────
  http.get(api('/templates'), () => HttpResponse.json(adminStore.templates)),
  http.patch(api('/templates/:id'), async ({ params, request }) => {
    const tpl = adminStore.templates.find((t) => t.id === String(params.id));
    if (!tpl) return errorJson(404, 'NOT_FOUND', 'Template not found');
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    if (typeof body.name === 'string') {
      if (body.name.trim().length === 0) {
        return errorJson(400, 'VALIDATION_FAILED', 'name cannot be empty', { field: 'name' });
      }
      tpl.name = body.name.trim();
    }
    if (typeof body.subject === 'string' || body.subject === null) {
      tpl.subject = body.subject;
    }
    if (typeof body.body === 'string') {
      if (body.body.length === 0) {
        return errorJson(400, 'VALIDATION_FAILED', 'body cannot be empty', { field: 'body' });
      }
      tpl.body = body.body;
    }
    tpl.updatedAt = nowIso();
    return HttpResponse.json(tpl);
  }),

  // ── Snippets (C7 snippets) ─────────────────────────────────────────────────
  http.get(api('/snippets'), () => HttpResponse.json(adminStore.snippets)),
  http.patch(api('/snippets/:id'), async ({ params, request }) => {
    const snp = adminStore.snippets.find((s) => s.id === String(params.id));
    if (!snp) return errorJson(404, 'NOT_FOUND', 'Snippet not found');
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    if (typeof body.shortcut === 'string') {
      if (body.shortcut.trim().length === 0) {
        return errorJson(400, 'VALIDATION_FAILED', 'shortcut cannot be empty', {
          field: 'shortcut',
        });
      }
      snp.shortcut = body.shortcut.trim();
    }
    if (typeof body.body === 'string') {
      if (body.body.length === 0) {
        return errorJson(400, 'VALIDATION_FAILED', 'body cannot be empty', { field: 'body' });
      }
      snp.body = body.body;
    }
    snp.updatedAt = nowIso();
    return HttpResponse.json(snp);
  }),

  // ── Org settings singleton (C7 admin/org-settings) ─────────────────────────
  http.get(api('/admin/org-settings'), () => HttpResponse.json(adminStore.orgSettings)),
  http.patch(api('/admin/org-settings'), async ({ request }) => {
    const body = await readJson(request);
    if (!body) return errorJson(400, 'VALIDATION_FAILED', 'Invalid body');
    // I-REC: recording is gated on legal sign-off — never toggled from the app.
    if (body.recordingEnabled !== undefined) {
      return errorJson(
        403,
        'FORBIDDEN',
        'Call recording requires legal sign-off and cannot be enabled from settings',
      );
    }
    if (body.dailySendCap !== undefined) {
      const cap = body.dailySendCap;
      if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > 100_000) {
        return errorJson(
          400,
          'VALIDATION_FAILED',
          'dailySendCap must be an integer between 1 and 100000',
          {
            field: 'dailySendCap',
          },
        );
      }
      adminStore.orgSettings.dailySendCap = cap;
    }
    adminStore.orgSettings.updatedAt = nowIso();
    return HttpResponse.json(adminStore.orgSettings);
  }),
];
