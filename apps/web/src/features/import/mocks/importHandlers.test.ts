import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Activity, Contact, Lead } from '@switchboard/shared';
import type { SearchHit } from '../../../api/types.ts';
import { ApiError } from '../../../api/errors.ts';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { commitImport, dryRunImport, uploadImport } from '../api/imports.ts';
import { resetImportStore } from '../data/store.ts';
import { importHandlers } from './importHandlers.ts';
import { defaultDedupeConfig, type DryRunRequest, type ImportMapping } from '../types.ts';

/*
 * The MSW import surface must be a drop-in for the real routes: same shapes, same
 * §C8 errors, and a commit that actually grows the shared timeline db. These
 * tests drive it through the real api-client. The commit mutates module-scope
 * `db`, so a snapshot is restored after every test to keep them isolated.
 */

const MAPPING: ImportMapping = {
  columns: [
    { source: 'Company', target: 'lead.name' },
    { source: 'Website', target: 'lead.url' },
    { source: 'Email', target: 'contact.email' },
  ],
};

const CSV =
  'Company,Website,Email\n' +
  'Marlowe Textiles,marlowe-textiles.example.com,dana@marlowe-textiles.example.com\n' +
  'Kestrel Provisions,kestrel-provisions.example.com,amir@kestrel-provisions.example.com';

// Fuzzy off so the two invented companies never accidentally match a seeded lead.
function dryRunBody(): DryRunRequest {
  return {
    mapping: MAPPING,
    dedupeConfig: {
      ...defaultDedupeConfig(),
      matchOn: { email: true, domain: true, fuzzyName: false },
    },
  };
}

function csvFile(text = CSV, name = 'leads.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

let savedLeads: Lead[];
let savedContacts: Contact[];
let savedSearch: SearchHit[];
let savedActivities: Map<string, Activity[]>;

beforeEach(() => {
  resetImportStore();
  server.use(...importHandlers);
  savedLeads = [...db.leads];
  savedContacts = [...db.contacts];
  savedSearch = [...db.searchIndex];
  savedActivities = new Map([...db.activitiesByLead].map(([k, v]) => [k, [...v]]));
});

afterEach(() => {
  db.leads.splice(0, db.leads.length, ...savedLeads);
  db.contacts.splice(0, db.contacts.length, ...savedContacts);
  db.searchIndex.splice(0, db.searchIndex.length, ...savedSearch);
  db.activitiesByLead.clear();
  for (const [k, v] of savedActivities) db.activitiesByLead.set(k, v);
});

describe('POST /imports', () => {
  test('accepts a CSV and returns an uploaded row', async () => {
    const res = await uploadImport(csvFile());
    expect(res.id).toBeTruthy();
    expect(res.status).toBe('uploaded');
    expect(res.filename).toBe('leads.csv');
    expect(res.rowCount).toBeNull();
  });

  test('rejects an upload with no file part', async () => {
    const boundary = '----test-no-file';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${boundary}--\r\n`;
    const status = await fetch('/api/v1/imports', {
      method: 'POST',
      body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    }).then((r) => r.status);
    expect(status).toBe(400);
  });
});

describe('POST /imports/:id/dry-run', () => {
  test('plans the mapping and returns the counts + rows', async () => {
    const { id } = await uploadImport(csvFile());
    const plan = await dryRunImport(id, dryRunBody());
    expect(plan.importId).toBe(id);
    expect(plan.counts.totalRows).toBe(2);
    expect(plan.counts.leadsCreated).toBe(2);
    expect(plan.counts.contactsCreated).toBe(2);
    expect(plan.rows).toHaveLength(2);
    // The sample seed's suppressed address is flagged, not blocked.
    expect(plan.counts.suppressedContacts).toBe(1);
  });

  test('404s for an unknown import id', async () => {
    await expect(dryRunImport('does-not-exist', dryRunBody())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('400s with details for an unknown custom target', async () => {
    const { id } = await uploadImport(csvFile());
    const bad: DryRunRequest = {
      mapping: { columns: [{ source: 'Company', target: 'custom.made_up' }] },
      dedupeConfig: defaultDedupeConfig(),
    };
    await expect(dryRunImport(id, bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  test('400s on a malformed CSV', async () => {
    const { id } = await uploadImport(csvFile('Company,Email\n"never closed,x'));
    await expect(dryRunImport(id, dryRunBody())).rejects.toBeInstanceOf(ApiError);
  });
});

describe('POST /imports/:id/commit', () => {
  test('writes the planned leads + contacts into the shared db', async () => {
    const leadsBefore = db.leads.length;
    const contactsBefore = db.contacts.length;
    const { id } = await uploadImport(csvFile());
    await dryRunImport(id, dryRunBody());
    const outcome = await commitImport(id);

    expect(outcome.status).toBe('committed');
    expect(outcome.counters).toEqual({ leads: 2, contacts: 2, merged: 0, activities: 4 });
    expect(db.leads.length).toBe(leadsBefore + 2);
    expect(db.contacts.length).toBe(contactsBefore + 2);
    // New lead is discoverable + has a timeline.
    const created = db.leads.find((l) => l.name === 'Marlowe Textiles');
    expect(created).toBeDefined();
    if (created) expect(db.activitiesByLead.get(created.id)?.length).toBeGreaterThan(0);
  });

  test('is idempotent — a second commit is a CONFLICT, not a double write', async () => {
    const { id } = await uploadImport(csvFile());
    await dryRunImport(id, dryRunBody());
    await commitImport(id);
    const leadsAfterFirst = db.leads.length;
    await expect(commitImport(id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.leads.length).toBe(leadsAfterFirst);
  });

  test('refuses to commit before a dry-run', async () => {
    const { id } = await uploadImport(csvFile());
    await expect(commitImport(id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
