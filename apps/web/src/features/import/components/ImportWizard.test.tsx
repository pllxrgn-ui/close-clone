import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Activity, Contact, Lead } from '@switchboard/shared';
import type { SearchHit } from '../../../api/types.ts';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { importHandlers } from '../mocks/importHandlers.ts';
import { resetImportStore } from '../data/store.ts';
import { ImportWizard } from './ImportWizard.tsx';
import { renderImport } from '../test/harness.tsx';

/*
 * End-to-end wizard behavior against the MSW import surface + the shared mock db:
 * every step advances, the mapping gate blocks a bad mapping, the dry-run counts
 * render, commit writes the new leads to the board, and a malformed file fails
 * loudly at upload. The commit mutates `db`, so a snapshot is restored per test.
 */

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
  cleanup();
});

/** Advance from the empty upload step to the map step using the sample file. */
async function toMapStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /use a sample file/i }));
  await user.click(await screen.findByRole('button', { name: /upload & continue/i }));
  await screen.findByRole('button', { name: /run dry run/i });
}

describe('ImportWizard', () => {
  test('walks upload → map → preview → commit and grows the leads board', async () => {
    const user = userEvent.setup();
    const leadsBefore = db.leads.length;
    renderImport(<ImportWizard />);

    // 01 Upload → 02 Map (sample auto-maps Company → Lead → Name).
    await toMapStep(user);
    const companySelect = screen.getByLabelText('Map column Company') as HTMLSelectElement;
    expect(companySelect.value).toBe('lead.name');

    // Turn fuzzy-name matching off so the counts are fixture-independent.
    await user.click(screen.getByLabelText('Similar company name'));
    await user.click(screen.getByRole('button', { name: /run dry run/i }));

    // 03 Preview — the dry-run board + ledger.
    await screen.findByRole('group', { name: /dry-run summary/i });
    expect(screen.getByText('Leads to create')).toBeInTheDocument();
    expect(screen.getByText('Error rows')).toBeInTheDocument();
    // The malformed-email row surfaces its reason in the ledger.
    expect(screen.getByText('Invalid email address')).toBeInTheDocument();

    // 04 Commit.
    await user.click(screen.getByRole('button', { name: /commit import/i }));
    await screen.findByText('Import complete');
    expect(screen.getByRole('button', { name: /go to leads board/i })).toBeInTheDocument();

    // 5 fresh companies landed on the board (rows: 5 create, 1 dupe, 2 error, 1 empty).
    expect(db.leads.length).toBe(leadsBefore + 5);
    expect(db.leads.some((l) => l.name === 'Marlowe Textiles')).toBe(true);
  });

  test('blocks the dry run until a company-name column is mapped', async () => {
    const user = userEvent.setup();
    renderImport(<ImportWizard />);
    await toMapStep(user);

    // Unmap the company column → readiness fails, the button disables.
    await user.selectOptions(screen.getByLabelText('Map column Company'), 'ignore');
    expect(screen.getByRole('button', { name: /run dry run/i })).toBeDisabled();
    expect(screen.getByText(/Map a column to Lead → Name/i)).toBeInTheDocument();

    // Restore it → the gate opens.
    await user.selectOptions(screen.getByLabelText('Map column Company'), 'lead.name');
    expect(screen.getByRole('button', { name: /run dry run/i })).toBeEnabled();
  });

  test('surfaces a malformed-file error at upload without leaving step 01', async () => {
    const user = userEvent.setup();
    const { container } = renderImport(<ImportWizard />);
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();

    const bad = new File(['Company,Email\n"never closed,oops'], 'bad.csv', { type: 'text/csv' });
    await user.upload(input as HTMLInputElement, bad);

    await screen.findByText(/won't import/i);
    // Still on upload — no dry-run control has appeared.
    expect(screen.queryByRole('button', { name: /run dry run/i })).toBeNull();
  });

  test('shows the mapping gate message on first arrival when nothing maps to a name', async () => {
    // Guard: an unrecognized-header file arrives with no auto lead-name mapping.
    const user = userEvent.setup();
    const { container } = renderImport(<ImportWizard />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    // Email auto-maps to Contact → Email, but nothing maps to a company name.
    const file = new File(['Widget,Email\nfoo,a@b.com'], 'mystery.csv', { type: 'text/csv' });
    await user.upload(input, file);
    await user.click(await screen.findByRole('button', { name: /upload & continue/i }));

    await screen.findByRole('button', { name: /run dry run/i });
    expect(screen.getByRole('button', { name: /run dry run/i })).toBeDisabled();
    expect(screen.getByText(/Map a column to Lead → Name/i)).toBeInTheDocument();
  });
});
