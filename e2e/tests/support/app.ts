import { expect, type Locator, type Page } from '@playwright/test';

/*
 * Shared helpers + frozen-fixture constants for the Switchboard E2E suite.
 *
 * The web app runs in MOCK mode (MSW). Its dataset is byte-deterministic — every
 * timestamp anchors to REFERENCE_NOW = 2026-07-15T17:00:00Z (apps/web/src/mocks/
 * fixtures.ts) — so the ids/names/counts referenced here are stable across runs.
 */

/** The only admin fixture user; used so /settings (compliance) is reachable. */
export const ADMIN_USER = {
  name: 'Ada Okafor',
  email: 'ada@switchboard.test',
} as const;

/**
 * A lead flagged do-not-contact in the frozen fixture (Harbor Cloud). Used
 * by the composer compliance test. If the fixture ever changes, the guard
 * assertion on the "Do not contact" header pill fails loudly rather than silently
 * passing.
 */
export const DNC_LEAD_ID = 'e1834476-227f-4747-81b1-2985fef9ff8d';

/** The Onboarding sequence (deterministic id/name; roster starts at 8). */
export const ONBOARDING = { id: 'seq-onboarding', name: 'Onboarding' } as const;

/** Log in through the dev-login UI as the given fixture user, landing in /overview. */
export async function devLogin(page: Page, userName: string): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // The user list is served by MSW (GET /auth/dev-users).
  await page.getByRole('button', { name: new RegExp(userName) }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
}

/** The first data row of the leads grid (skips the columnheader row). */
export function firstLeadRow(page: Page): Locator {
  return page
    .getByRole('grid', { name: 'Leads' })
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell') })
    .first();
}

/** Navigate to /leads and open the first lead; returns its name (from the H1). */
export async function openFirstLead(page: Page): Promise<string> {
  await page.goto('/leads');
  await expect(page.getByRole('grid', { name: 'Leads' })).toBeVisible();
  await firstLeadRow(page).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}$/);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  // The lazy lead route can briefly leave the LIST heading in the tree after the
  // URL flips — wait until the h1 is the lead's actual name, not the list title.
  await expect(heading).not.toHaveText(/^(All leads|Leads)$/);
  return (await heading.textContent())?.trim() ?? '';
}

/** Open the lead-page "New email" composer; returns the dialog locator. */
export async function openEmailComposer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Email', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New email' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Read a whole-number stat value out of an inbox header tile by its label. */
export async function readInboxStat(page: Page, label: string): Promise<number> {
  const value = page
    .locator('.sb-inbox__stat', { hasText: label })
    .locator('.sb-inbox__stat-value');
  await expect(value).toBeVisible();
  const text = (await value.textContent())?.replace(/[^\d-]/g, '') ?? '';
  return Number.parseInt(text, 10);
}
