import { http, HttpResponse } from 'msw';
import type { Activity, Contact, Lead } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import type { SearchHit } from '../../../api/types.ts';
import { adminStore } from '../../admin/mocks/adminStore.ts';
import { importStore, toResource, type ImportRecord } from '../data/store.ts';
import { CsvParseError, parseCsvRecords } from '../lib/csv.ts';
import { buildExistingIndex, type IndexContact, type IndexLead } from '../lib/existing.ts';
import { validateTargets } from '../lib/mapping.ts';
import { buildPlan, type CustomFieldSpec, type PlanContext } from '../lib/planner.ts';
import {
  DEDUPE_ACTIONS,
  defaultDedupeConfig,
  type CommitCounters,
  type DedupeAction,
  type DedupeConfig,
  type ImportColumn,
  type ImportMapping,
  type PlannedLead,
} from '../types.ts';

/*
 * MSW handlers for the CSV import flow — a drop-in for the REAL routes
 * (apps/api/src/routes/imports.ts): multipart POST /imports → POST
 * /imports/:id/dry-run → POST /imports/:id/commit, same request/response shapes
 * and the same §C8 `{error:{code,message,details?}}` envelope, so the identical
 * wizard drives the real server once credentials land. The dry-run runs the
 * client planner against a live snapshot of the mock db (leads/contacts +
 * admin custom-field defs), and COMMIT actually writes new leads/contacts +
 * their C4 activities into the shared timeline db, so the leads board and lead
 * pages visibly grow — no dead buttons.
 *
 * Registered like the other feature arrays (server.use(...importHandlers) in
 * tests; spread into the worker/server lists at merge — see routeWiring).
 */

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

/** Max upload the mock accepts (mirrors the server's byte cap → FileTooLarge). */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Multipart boundary token out of a content-type header. */
function boundaryOf(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const value = (m[1] ?? m[2] ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Read the first file part out of a raw multipart body — the demo-mode analogue
 * of the server's streaming `readFirstFilePart`. Used instead of MSW's
 * `request.formData()`, which hangs on a multipart body under the jsdom/undici
 * test runtime. CSV content (incl. its own CRLFs) is preserved; only the single
 * trailing CRLF the format inserts before the next delimiter is trimmed.
 */
function parseFirstFilePart(
  body: string,
  boundary: string,
): { filename: string; content: string } | null {
  for (const part of body.split(`--${boundary}`)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    if (!/filename=/i.test(headers)) continue;
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1] ?? 'import.csv';
    const content = part.slice(headerEnd + 4).replace(/\r\n$/, '');
    return { filename: filename.length > 0 ? filename : 'import.csv', content };
  }
  return null;
}

function actingUserId(): string {
  return db.users[0]?.id ?? 'demo-user';
}

// ── Mapping-context builders (from the live mock db + admin custom fields) ────
function leadCustomFieldSpecs(): Map<string, CustomFieldSpec> {
  const map = new Map<string, CustomFieldSpec>();
  for (const f of adminStore.customFields) {
    if (f.entity !== 'lead') continue;
    map.set(f.key, {
      key: f.key,
      type: f.type,
      options: f.options === null ? null : [...f.options],
    });
  }
  return map;
}

function planContext(): PlanContext {
  const statusByLabel = new Map<string, string>();
  for (const s of db.leadStatuses) statusByLabel.set(s.label.toLowerCase(), s.id);
  const userByEmail = new Map<string, string>();
  const userById = new Set<string>();
  for (const u of db.users) {
    userByEmail.set(u.email.toLowerCase(), u.id);
    userById.add(u.id);
  }
  return { customFields: leadCustomFieldSpecs(), statusByLabel, userByEmail, userById };
}

function existingSnapshot() {
  const leads: IndexLead[] = db.leads
    .filter((l) => l.deletedAt === null)
    .map((l) => ({ id: l.id, name: l.name, url: l.url }));
  const contacts: IndexContact[] = db.contacts
    .filter((c) => c.deletedAt === null)
    .map((c) => ({ leadId: c.leadId, emails: c.emails.map((e) => e.email) }));
  return buildExistingIndex(leads, contacts, importStore.suppressedEmails);
}

// ── Request parsing ──────────────────────────────────────────────────────────
function parseMapping(raw: unknown): ImportMapping | null {
  if (!isRecord(raw) || !Array.isArray(raw.columns) || raw.columns.length === 0) return null;
  const columns: ImportColumn[] = [];
  for (const col of raw.columns) {
    if (!isRecord(col) || typeof col.source !== 'string' || typeof col.target !== 'string') {
      return null;
    }
    columns.push({ source: col.source, target: col.target });
  }
  return { columns };
}

function normalizeDedupe(raw: unknown): DedupeConfig {
  const base = defaultDedupeConfig();
  if (!isRecord(raw)) return base;
  const action =
    typeof raw.action === 'string' && (DEDUPE_ACTIONS as readonly string[]).includes(raw.action)
      ? (raw.action as DedupeAction)
      : base.action;
  const matchRaw = isRecord(raw.matchOn) ? raw.matchOn : {};
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const threshold =
    typeof raw.fuzzyNameThreshold === 'number' &&
    raw.fuzzyNameThreshold >= 0 &&
    raw.fuzzyNameThreshold <= 1
      ? raw.fuzzyNameThreshold
      : base.fuzzyNameThreshold;
  return {
    action,
    matchOn: {
      email: bool(matchRaw.email, base.matchOn.email),
      domain: bool(matchRaw.domain, base.matchOn.domain),
      fuzzyName: bool(matchRaw.fuzzyName, base.matchOn.fuzzyName),
    },
    fuzzyNameThreshold: threshold,
  };
}

// ── Commit application (writes into the shared timeline db) ───────────────────
function pushActivity(
  leadId: string,
  userId: string | null,
  type: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): void {
  const activity: Activity = {
    id: crypto.randomUUID(),
    leadId,
    contactId: null,
    userId,
    type,
    occurredAt,
    payload,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const existing = db.activitiesByLead.get(leadId);
  if (existing) existing.unshift(activity);
  else db.activitiesByLead.set(leadId, [activity]);
}

function insertContact(
  contact: {
    id: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
  },
  leadId: string,
  leadName: string,
  now: string,
): void {
  const row: Contact = {
    id: contact.id,
    leadId,
    name: contact.name,
    title: contact.title,
    emails: contact.email === null ? [] : [{ email: contact.email, type: 'work' }],
    phones: contact.phone === null ? [] : [{ phone: contact.phone, type: 'work' }],
    dnc: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.contacts.unshift(row);
  db.searchIndex.unshift({
    type: 'contact',
    id: row.id,
    leadId,
    title: row.name,
    subtitle: leadName,
  });
}

function applyCommit(record: ImportRecord): CommitCounters {
  const plan = record.plan;
  const counters: CommitCounters = { leads: 0, contacts: 0, merged: 0, activities: 0 };
  if (plan === null) return counters;
  const now = new Date().toISOString();
  const user = actingUserId();

  for (const row of plan.rows) {
    if (row.outcome === 'create' && row.lead !== null) {
      const l = row.lead;
      const name = l.name ?? 'Unknown';
      const lead: Lead = {
        id: l.id,
        name,
        url: l.url,
        description: l.description,
        statusId: l.statusId,
        ownerId: l.ownerId,
        custom: l.custom,
        lastContactedAt: null,
        lastInboundAt: null,
        nextTaskDueAt: null,
        lastCallAt: null,
        lastEmailAt: null,
        lastSmsAt: null,
        dnc: l.dnc,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      db.leads.unshift(lead);
      db.searchIndex.unshift({
        type: 'lead',
        id: lead.id,
        leadId: lead.id,
        title: name,
        subtitle: 'Imported',
      } satisfies SearchHit);
      counters.leads += 1;
      pushActivity(lead.id, user, 'import_created', now, {
        importId: record.id,
        rowCount: record.rowCount ?? plan.counts.totalRows,
      });
      pushActivity(lead.id, user, 'lead_created', now, {});
      counters.activities += 2;
      if (row.contact !== null) {
        insertContact(row.contact, lead.id, name, now);
        counters.contacts += 1;
      }
      continue;
    }

    if (row.outcome === 'dedupe' && row.action === 'merge-fields' && row.targetLeadId !== null) {
      mergeLeadFields(row.targetLeadId, row.lead, now);
      if (row.contact !== null) {
        const target = db.leads.find((l) => l.id === row.targetLeadId);
        insertContact(row.contact, row.targetLeadId, target?.name ?? 'Unknown lead', now);
        counters.contacts += 1;
      }
      counters.merged += 1;
    }
  }
  return counters;
}

/** Fill only-empty fields on the matched lead (COALESCE), tighten dnc, merge custom. */
function mergeLeadFields(leadId: string, planned: PlannedLead | null, now: string): void {
  if (planned === null) return;
  const lead = db.leads.find((l) => l.id === leadId && l.deletedAt === null);
  if (!lead) return;
  lead.url = lead.url ?? planned.url;
  lead.description = lead.description ?? planned.description;
  lead.statusId = lead.statusId ?? planned.statusId;
  lead.ownerId = lead.ownerId ?? planned.ownerId;
  lead.dnc = lead.dnc || planned.dnc;
  lead.custom = { ...planned.custom, ...lead.custom };
  lead.updatedAt = now;
}

export const importHandlers = [
  // ── POST /imports — multipart CSV upload ──────────────────────────────────
  http.post(api('/imports'), async ({ request }) => {
    const boundary = boundaryOf(request.headers.get('content-type'));
    if (boundary === null) {
      return errorJson(400, 'VALIDATION_FAILED', 'expected multipart/form-data with a boundary');
    }
    const rawBody = await request.text();
    const part = parseFirstFilePart(rawBody, boundary);
    if (part === null) return errorJson(400, 'VALIDATION_FAILED', 'no file part in the upload');

    const csvText = part.content;
    if (csvText.length > MAX_UPLOAD_BYTES) {
      return errorJson(400, 'VALIDATION_FAILED', 'file exceeds the 5 MB import limit');
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const record: ImportRecord = {
      id,
      filename: part.filename,
      status: 'uploaded',
      rowCount: null,
      createdBy: actingUserId(),
      createdAt: now,
      updatedAt: now,
      csvText,
      mapping: null,
      dedupe: null,
      plan: null,
      counters: null,
    };
    importStore.imports.set(id, record);
    return HttpResponse.json(toResource(record), { status: 201 });
  }),

  // ── POST /imports/:id/dry-run — plan against the DB, no writes ─────────────
  http.post(api('/imports/:id/dry-run'), async ({ params, request }) => {
    const record = importStore.imports.get(String(params.id));
    if (!record) return errorJson(404, 'NOT_FOUND', 'import not found');
    if (record.status === 'committing' || record.status === 'committed') {
      return errorJson(409, 'CONFLICT', `import cannot be dry-run from '${record.status}'`);
    }

    const body = await readJson(request);
    const mapping = parseMapping(body?.mapping);
    if (mapping === null) {
      return errorJson(
        400,
        'VALIDATION_FAILED',
        'invalid mapping — expected a non-empty columns list',
      );
    }
    const dedupe = normalizeDedupe(body?.dedupeConfig);

    const ctx = planContext();
    const targetErrors = validateTargets(mapping.columns, new Set(ctx.customFields.keys()));
    if (targetErrors.length > 0) {
      return errorJson(400, 'VALIDATION_FAILED', 'mapping is invalid', targetErrors);
    }

    let records: string[][];
    try {
      records = parseCsvRecords(record.csvText);
    } catch (err) {
      if (err instanceof CsvParseError) {
        return errorJson(400, 'VALIDATION_FAILED', `malformed CSV: ${err.message}`);
      }
      throw err;
    }

    const plan = buildPlan({
      records,
      mapping,
      dedupe,
      ctx,
      existing: existingSnapshot(),
      newLeadId: () => crypto.randomUUID(),
      newContactId: () => crypto.randomUUID(),
    });

    record.mapping = mapping;
    record.dedupe = dedupe;
    record.plan = plan;
    record.rowCount = plan.counts.totalRows;
    record.status = 'dry_run';
    record.updatedAt = new Date().toISOString();

    return HttpResponse.json({ importId: record.id, ...plan });
  }),

  // ── POST /imports/:id/commit — idempotent apply ───────────────────────────
  http.post(api('/imports/:id/commit'), ({ params }) => {
    const record = importStore.imports.get(String(params.id));
    if (!record) return errorJson(404, 'NOT_FOUND', 'import not found');
    if (record.status === 'committed') {
      // Re-POST is a no-op CONFLICT (AlreadyCommittedError) — never a double write.
      return errorJson(409, 'CONFLICT', 'import is already committed');
    }
    if (record.status !== 'dry_run' || record.plan === null) {
      return errorJson(409, 'CONFLICT', `import cannot be committed from '${record.status}'`);
    }

    const counters = applyCommit(record);
    record.counters = counters;
    record.status = 'committed';
    record.updatedAt = new Date().toISOString();

    return HttpResponse.json({
      importId: record.id,
      status: 'committed',
      resumed: false,
      counters,
      nextRowIndex: record.plan.rows.length,
    });
  }),
];
