import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contact, Lead } from '@switchboard/shared';
import { search } from '../../../api/search.ts';
import { enrollInSequence } from '../api/comms.ts';
import { enrollLeads } from '../../admin/api.ts';
import { db } from '../../../mocks/fixtures.ts';
import { commsStore, enrollmentCounts, resetCommsStore } from '../data/store.ts';
import { adminStore, resetAdminStore } from '../../admin/mocks/adminStore.ts';
import { SequenceDetail } from '../components/SequenceDetail.tsx';
import { renderComms } from '../test/harness.tsx';

/*
 * Regression suite for the admin ⇄ comms MSW route collisions on
 * `POST /sequences/:id/enroll` and the enroll-drawer lead search.
 *
 * These tests run against the SHARED `server` (src/mocks/server.ts) in its
 * PRODUCTION spread order — handlers → pipeline → admin → reports → comms →
 * view-builder → leadDetail — the same first-match-wins order the browser worker
 * uses (src/mocks/browser.ts). They deliberately DO NOT `server.use(...commsHandlers)`:
 * that older pattern boosts comms above admin and hides the collision that only
 * bites in the real browser (the boss clicking "Enroll").
 *
 * "Stark" in the task brief is illustrative — the deterministic fixture generates
 * company names from COMPANY_PREFIX × COMPANY_SUFFIX (e.g. "Quantum Networks"), so
 * we pick a real fixture lead at runtime instead of hard-coding a name.
 */

const ONBOARDING = 'seq-onboarding';

/** Escape a fixture name for use as a substring RegExp accessible-name matcher. */
function rx(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** First whitespace-delimited token of a name (a distinctive search prefix). */
function firstToken(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/** A non-DNC lead + first non-DNC contact not already enrolled in `sequenceId`. */
function pickEnrollableContact(sequenceId: string): { leadId: string; contactId: string } {
  const taken = new Set(
    commsStore.enrollments.filter((e) => e.sequenceId === sequenceId).map((e) => e.contactId),
  );
  for (const lead of db.leads) {
    if (lead.dnc) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && !c.dnc && !taken.has(c.id),
    );
    if (contact) return { leadId: lead.id, contactId: contact.id };
  }
  throw new Error('fixture has no enrollable lead/contact');
}

/** Like above, but the lead's name must be unique so search maps to exactly it. */
function pickUniqueEnrollableLead(sequenceId: string): { lead: Lead; contact: Contact } {
  const nameCounts = new Map<string, number>();
  for (const l of db.leads) nameCounts.set(l.name, (nameCounts.get(l.name) ?? 0) + 1);
  const taken = new Set(
    commsStore.enrollments.filter((e) => e.sequenceId === sequenceId).map((e) => e.contactId),
  );
  for (const lead of db.leads) {
    if (lead.dnc || nameCounts.get(lead.name) !== 1) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && !c.dnc && !taken.has(c.id),
    );
    if (contact) return { lead, contact };
  }
  throw new Error('fixture has no unique-named enrollable lead');
}

beforeEach(() => {
  resetCommsStore();
  resetAdminStore();
  // NOTE: no server.use(...) — exercise the real default handler order.
});
afterEach(cleanup);

describe('admin ⇄ comms MSW route collisions (production handler order)', () => {
  // ── The GET /sequences dead-shadow contract (audit #5) ──────────────────────
  // Admin's GET /sequences is registered before comms', so first-match-wins
  // makes ADMIN the source of the sequence LIST while comms serves the step
  // ladders and rosters. That split stays coherent ONLY while both stores seed
  // the same sequence identities — previously enforced by a comment in
  // comms/data/store.ts (and broken once: "every sequence showed 0 steps ·
  // 0 active"). This pins the invariant as an executable contract.
  test('comms step/roster seeds align 1:1 with the sequences admin serves', () => {
    const adminSeqs = new Map(adminStore.sequences.map((s) => [s.id, s]));
    const commsSeqs = commsStore.sequences;

    // Same id set, both directions — no orphaned ladders, no stepless rows.
    expect(commsSeqs.map((s) => s.id).sort()).toEqual([...adminSeqs.keys()].sort());

    for (const seq of commsSeqs) {
      const twin = adminSeqs.get(seq.id);
      // The UI renders admin's name/status above comms' ladder — they must agree.
      expect(twin?.name).toBe(seq.name);
      expect(twin?.status).toBe(seq.status);
      // Every displayed sequence has a real ladder to serve (the 0-steps bug).
      const ladder = commsStore.steps.filter((step) => step.sequenceId === seq.id);
      expect(ladder.length).toBeGreaterThan(0);
    }
  });

  // ── Symptom 1: the enroll drawer's "Find a lead" source ─────────────────────
  test('GET /search resolves real fixture leads (the drawer + palette source)', async () => {
    const leadHit = db.searchIndex.find((h) => h.type === 'lead');
    if (!leadHit) throw new Error('search index has no lead hits');

    const byPrefix = await search(firstToken(leadHit.title));
    expect(byPrefix.items.filter((h) => h.type === 'lead').length).toBeGreaterThan(0);

    // The specific fixture lead is reachable and carries the leadId the drawer routes on.
    const byName = await search(leadHit.title);
    expect(byName.items.some((h) => h.type === 'lead' && h.leadId === leadHit.leadId)).toBe(true);
  });

  // ── Symptom 2a: single enroll (the drawer POST body) ────────────────────────
  // The drawer now POSTs the REAL bulk shape `{ targets: [one] }`; the admin bulk
  // handler falls through (no `leadIds`), so comms answers with `{ enrolled, skipped }`.
  test('POST /sequences/:id/enroll with a 1-element {targets} body succeeds', async () => {
    const { leadId, contactId } = pickEnrollableContact(ONBOARDING);
    const before = enrollmentCounts(ONBOARDING).active;

    const result = await enrollInSequence(ONBOARDING, { leadId, contactId });

    expect(result.enrolled).toHaveLength(1);
    expect(result.enrolled[0]?.contactId).toBe(contactId);
    expect(result.enrolled[0]?.enrollmentId).toBeTruthy();
    expect(result.skipped).toHaveLength(0);
    expect(enrollmentCounts(ONBOARDING).active).toBe(before + 1);
  });

  // ── Symptom 2b: bulk enroll (the leads-bulk-bar POST body) still works ───────
  test('POST /sequences/:id/enroll with a bulk {leadIds:[...]} body still succeeds', async () => {
    const leadIds = db.leads
      .filter((l) => !l.dnc)
      .slice(0, 3)
      .map((l) => l.id);
    const seq = adminStore.sequences.find((s) => s.id === ONBOARDING);
    if (!seq) throw new Error('admin seed missing onboarding sequence');
    const before = seq.activeEnrollments;

    const result = await enrollLeads(ONBOARDING, leadIds);

    expect(result.enrolled).toBe(leadIds.length);
    expect(result.skipped).toBe(0);
    expect(result.activeEnrollments).toBe(before + leadIds.length);
  });

  // ── End-to-end: the boss's actual click path, real browser handler order ─────
  test('enroll drawer: search finds a lead, single enroll succeeds and ticks the count', async () => {
    const user = userEvent.setup();
    const { lead, contact } = pickUniqueEnrollableLead(ONBOARDING);
    const before = enrollmentCounts(ONBOARDING).active;

    renderComms(<SequenceDetail sequenceId={ONBOARDING} />, '/sequences/x');
    await screen.findByRole('heading', { name: 'Onboarding', level: 1 });

    await user.click(screen.getByRole('button', { name: /Enroll/ }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Search leads'), lead.name);
    await user.click(await within(dialog).findByRole('button', { name: rx(lead.name) }));
    await user.click(await within(dialog).findByRole('radio', { name: rx(contact.name) }));
    await user.click(within(dialog).getByRole('button', { name: 'Enroll' }));

    expect(await screen.findByText(/Enrolled in Onboarding/)).toBeInTheDocument();
    await waitFor(() => expect(enrollmentCounts(ONBOARDING).active).toBe(before + 1));
  });
});
