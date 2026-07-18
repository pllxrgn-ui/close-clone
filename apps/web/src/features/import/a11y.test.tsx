import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import type { Activity, Contact, Lead } from '@switchboard/shared';
import type { SearchHit } from '../../api/types.ts';
import { server } from '../../mocks/server.ts';
import { db } from '../../mocks/fixtures.ts';
import { importHandlers } from './mocks/importHandlers.ts';
import { resetImportStore } from './data/store.ts';
import { ImportWizard } from './components/ImportWizard.tsx';
import { renderImport } from './test/harness.tsx';

/*
 * axe-core structural smoke for each wizard step, under both themes. Color-
 * contrast can't run in jsdom (the AA pairs are verified statically in
 * tokens.css), so we fail only on serious/critical — the W1/comms bar.
 */

const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };
const THEMES = ['light', 'dark'] as const;

async function expectNoSeriousViolations(root: HTMLElement): Promise<void> {
  const results = await axe.run(root, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n')).toBe('');
}

let savedLeads: Lead[];
let savedContacts: Contact[];
let savedSearch: SearchHit[];
let savedActivities: Map<string, Activity[]>;

/** Restore the shared db to its pre-test snapshot (commit writes into it). */
function restoreDb(): void {
  db.leads.splice(0, db.leads.length, ...savedLeads);
  db.contacts.splice(0, db.contacts.length, ...savedContacts);
  db.searchIndex.splice(0, db.searchIndex.length, ...savedSearch);
  db.activitiesByLead.clear();
  for (const [k, v] of savedActivities) db.activitiesByLead.set(k, v);
  resetImportStore();
}

beforeEach(() => {
  resetImportStore();
  server.use(...importHandlers);
  savedLeads = [...db.leads];
  savedContacts = [...db.contacts];
  savedSearch = [...db.searchIndex];
  savedActivities = new Map([...db.activitiesByLead].map(([k, v]) => [k, [...v]]));
  document.documentElement.lang = 'en';
});

afterEach(() => {
  restoreDb();
  document.documentElement.removeAttribute('data-theme');
  cleanup();
});

async function toMap(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /use a sample file/i }));
  await user.click(await screen.findByRole('button', { name: /upload & continue/i }));
  await screen.findByRole('button', { name: /run dry run/i });
}

describe('import wizard a11y', () => {
  test('upload step has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = renderImport(<ImportWizard />);
      await screen.findByText(/drag a csv here/i);
      await expectNoSeriousViolations(container);
      unmount();
    }
  });

  test('map step has no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      document.documentElement.dataset.theme = theme;
      const user = userEvent.setup();
      const { container, unmount } = renderImport(<ImportWizard />);
      await toMap(user);
      await expectNoSeriousViolations(container);
      unmount();
    }
  });

  test('preview + commit steps have no serious/critical violations (light + dark)', async () => {
    for (const theme of THEMES) {
      // Each iteration commits into the shared db; restore so the next dry-run
      // doesn't dedupe against the leads the previous iteration just created.
      restoreDb();
      document.documentElement.dataset.theme = theme;
      const user = userEvent.setup();
      const { container, unmount } = renderImport(<ImportWizard />);
      await toMap(user);
      await user.click(screen.getByRole('button', { name: /run dry run/i }));
      await screen.findByRole('group', { name: /dry-run summary/i });
      await expectNoSeriousViolations(container);

      await user.click(screen.getByRole('button', { name: /commit import/i }));
      await screen.findByText('Import complete');
      await expectNoSeriousViolations(container);
      unmount();
    }
  });
});
