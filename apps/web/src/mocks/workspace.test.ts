import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Lead } from '@switchboard/shared';
import {
  clearBlankWorkspace,
  hasBlankSnapshot,
  loadBlankSnapshot,
  saveBlankSnapshot,
  setWorkspaceMode,
  workspaceMode,
  WORKSPACE_KEY,
} from './workspace.ts';
import { makeLead } from '../features/leads/test/factories.ts';

/*
 * Workspace mode + blank-db persistence. The fixture-integration tests use
 * vi.resetModules() + dynamic import so fixtures.ts re-evaluates under the
 * localStorage state THIS test controls (vitest isolates modules per file, so
 * nothing here leaks into other suites).
 */

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('workspace mode + snapshot primitives', () => {
  test('defaults to sample; set/clear round-trips', () => {
    expect(workspaceMode()).toBe('sample');
    setWorkspaceMode('blank');
    expect(workspaceMode()).toBe('blank');
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe('blank');
    setWorkspaceMode('sample');
    expect(workspaceMode()).toBe('sample');
    expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull();
  });

  test('snapshot save/load/clear round-trips; junk never parses', () => {
    expect(loadBlankSnapshot()).toBeNull();
    const lead: Lead = makeLead({ name: 'Boss Test Co' });
    saveBlankSnapshot({
      v: 1,
      leads: [lead],
      contacts: [],
      opportunities: [],
      activities: [[lead.id, []]],
      smartViews: [],
    });
    expect(hasBlankSnapshot()).toBe(true);
    expect(loadBlankSnapshot()?.leads[0]?.name).toBe('Boss Test Co');

    localStorage.setItem('sb-blank-db-v1', '{not json');
    expect(loadBlankSnapshot()).toBeNull();

    clearBlankWorkspace();
    expect(hasBlankSnapshot()).toBe(false);
  });
});

describe('fixtures under workspace modes', () => {
  test('blank mode boots EMPTY but keeps the org scaffolding', async () => {
    setWorkspaceMode('blank');
    vi.resetModules();
    const { db } = await import('./fixtures.ts');
    expect(db.leads).toHaveLength(0);
    expect(db.contacts).toHaveLength(0);
    expect(db.opportunities).toHaveLength(0);
    expect(db.activitiesByLead.size).toBe(0);
    expect(db.searchIndex).toHaveLength(0);
    // The org itself is intact: users to sign in as, statuses, stages, views.
    expect(db.users.length).toBeGreaterThan(0);
    expect(db.leadStatuses.length).toBeGreaterThan(0);
    expect(db.opportunityStages.length).toBeGreaterThan(0);
    expect(db.smartViews.length).toBeGreaterThan(0);
  });

  test('a persisted snapshot hydrates the blank workspace (data survives reload)', async () => {
    const lead = makeLead({ name: 'Willowbrook Dental' });
    setWorkspaceMode('blank');
    saveBlankSnapshot({
      v: 1,
      leads: [lead],
      contacts: [],
      opportunities: [],
      activities: [
        [
          lead.id,
          [
            {
              id: '11111111-1111-4111-8111-111111111111',
              leadId: lead.id,
              contactId: null,
              userId: null,
              type: 'lead_created',
              occurredAt: lead.createdAt,
              payload: {},
              createdAt: lead.createdAt,
              updatedAt: lead.createdAt,
            },
          ],
        ],
      ],
      smartViews: [],
    });
    vi.resetModules();
    const { db, snapshotDb } = await import('./fixtures.ts');
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0]?.name).toBe('Willowbrook Dental');
    expect(db.activitiesByLead.get(lead.id)).toHaveLength(1);
    // And the outgoing snapshot round-trips what the db now holds.
    const snap = snapshotDb();
    expect(snap.leads[0]?.name).toBe('Willowbrook Dental');
    expect(snap.activities).toHaveLength(1);
  });

  test('sample mode is untouched by a lingering blank snapshot', async () => {
    saveBlankSnapshot({
      v: 1,
      leads: [makeLead({ name: 'Should not appear' })],
      contacts: [],
      opportunities: [],
      activities: [],
      smartViews: [],
    });
    vi.resetModules();
    const { db } = await import('./fixtures.ts');
    expect(db.leads.length).toBeGreaterThanOrEqual(200);
    expect(db.leads.some((l) => l.name === 'Should not appear')).toBe(false);
  });
});

describe('personal-account workspace owners', () => {
  test('an owner forces blank mode and isolates snapshots per account', async () => {
    const { setWorkspaceOwner, clearWorkspaceOwner, getWorkspaceOwner } =
      await import('./workspace.ts');
    const userA = { id: 'a', name: 'A' } as never;

    setWorkspaceOwner({ username: 'alice', user: userA });
    expect(getWorkspaceOwner()?.username).toBe('alice');
    expect(workspaceMode()).toBe('blank');
    saveBlankSnapshot({
      v: 1,
      leads: [makeLead({ name: 'Alice Lead' })],
      contacts: [],
      opportunities: [],
      activities: [],
      smartViews: [],
    });
    expect(loadBlankSnapshot()?.leads[0]?.name).toBe('Alice Lead');

    // Switch owner: bob sees NOTHING of alice's workspace.
    setWorkspaceOwner({ username: 'bob', user: userA });
    expect(loadBlankSnapshot()).toBeNull();

    // Anonymous blank picker is a third, separate space.
    clearWorkspaceOwner();
    expect(loadBlankSnapshot()).toBeNull();

    // Alice's data is still there when she signs back in.
    setWorkspaceOwner({ username: 'alice', user: userA });
    expect(loadBlankSnapshot()?.leads[0]?.name).toBe('Alice Lead');
  });

  test('fixtures under an owner: solo org — the user list is just the owner', async () => {
    const { setWorkspaceOwner } = await import('./workspace.ts');
    setWorkspaceOwner({
      username: 'pol',
      user: {
        id: '99999999-9999-4999-8999-999999999999',
        email: 'pol@switchboard.local',
        name: 'Pol V',
        role: 'admin',
        idpSubject: 'demo:pol',
        isActive: true,
        timezone: 'America/Los_Angeles',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      },
    });
    vi.resetModules();
    const { db } = await import('./fixtures.ts');
    expect(db.leads).toHaveLength(0);
    expect(db.users).toHaveLength(1);
    expect(db.users[0]?.name).toBe('Pol V');
    expect(db.leadStatuses.length).toBeGreaterThan(0);
  });
});
