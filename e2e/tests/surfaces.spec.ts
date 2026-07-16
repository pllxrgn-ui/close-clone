import { expect, test } from '@playwright/test';
import { ONBOARDING } from './support/app';

/*
 * The key authed surfaces from the rep loop (build guide §8): sequences,
 * pipeline, reports, settings. These reuse the shared authenticated storageState
 * (admin fixture user) and navigate straight to each surface. Mock data is
 * byte-deterministic, so the asserted counts/numbers are stable.
 */

test.describe('sequences', () => {
  test('step ladder + paused-reply enrollment render; enrolling ticks the count', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.goto(`/sequences/${ONBOARDING.id}`);
    await expect(page.getByRole('heading', { level: 1, name: ONBOARDING.name })).toBeVisible();

    // Reply-safety guarantee callout.
    await expect(page.getByRole('complementary', { name: 'Reply safety guarantee' })).toBeVisible();

    // Step ladder: Onboarding has 3 steps, the last gated on review.
    const ladder = page.getByRole('list', { name: 'Sequence steps' });
    await expect(ladder).toBeVisible();
    await expect(ladder.getByRole('listitem')).toHaveCount(3);
    await expect(ladder.getByText('Needs review')).toBeVisible();

    // Exactly one enrollment paused by a reply (I-SEND-2 made visible).
    await expect(page.getByText('Paused · reply', { exact: true })).toHaveCount(1);

    // Enroll a fresh lead+contact → roster count ticks up by one.
    const roster = page.getByRole('list', { name: 'Enrolled contacts' }).getByRole('listitem');
    const before = await roster.count();
    expect(before).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Enroll' }).click();
    const dialog = page.getByRole('dialog', { name: /Enroll a contact in/ });
    await expect(dialog).toBeVisible();
    // Broad query — leads are first in the mock search index, so this returns a
    // page of lead results (company names + status subtitles nearly all match).
    await dialog.getByRole('textbox', { name: 'Search leads' }).fill('a');
    const results = dialog.getByRole('list', { name: 'Lead results' }).getByRole('button');
    await expect(results.first()).toBeVisible();

    // Only each lead's FIRST contact is pre-enrolled, so a lead's SECOND contact
    // is guaranteed fresh. Pick the first result that has >= 2 contacts and
    // enroll its second one; single-contact leads → step back and try the next.
    // (Selecting a lead swaps the results view for the contact picker, so we use
    // the drawer's back-link to return between attempts.)
    const resultCount = await results.count();
    let enrolled = false;
    for (let i = 0; i < resultCount && !enrolled; i++) {
      await results.nth(i).click();
      const radios = dialog.getByRole('radio');
      await expect(radios.first()).toBeVisible();
      if ((await radios.count()) >= 2) {
        await radios.nth(1).check();
        const confirm = dialog.getByRole('button', { name: 'Enroll' });
        if (await confirm.isEnabled()) {
          await confirm.click();
          // Success unmounts the drawer.
          enrolled = await dialog
            .waitFor({ state: 'hidden', timeout: 3000 })
            .then(() => true)
            .catch(() => false);
        }
      }
      if (!enrolled) {
        await dialog.locator('.comms-backlink').click();
        await expect(results.first()).toBeVisible();
      }
    }
    expect(enrolled).toBe(true);
    await expect(roster).toHaveCount(before + 1);
  });
});

test.describe('pipeline', () => {
  test('board renders columns with currency-separated sums', async ({ page }) => {
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Pipeline by stage' })).toBeVisible();

    for (const column of ['Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']) {
      await expect(page.getByRole('region', { name: new RegExp(column) })).toBeVisible();
    }

    // Weighted pipeline header + a deal count.
    await expect(page.getByText('Open pipeline')).toBeVisible();
    await expect(page.getByText('Weighted', { exact: true })).toBeVisible();
    await expect(page.locator('.pl-header__count')).toHaveText(/^\d+ deals?$/);

    // Currency-separated sums: USD is guaranteed by the seed; each currency is its
    // own node (currencies are never cross-summed).
    await expect(page.locator('.pl-money').filter({ hasText: '$' }).first()).toBeVisible();
  });
});

test.describe('reports', () => {
  test('tabs render numbers and the range switch re-queries', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();

    const tablist = page.getByRole('tablist', { name: 'Report families' });
    await expect(tablist).toBeVisible();
    for (const tab of ['Activity', 'Funnel', 'Sequences']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible();
    }

    // Activity is the default; org totals are exact by construction (30D).
    await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('810', { exact: true })).toBeVisible(); // Calls logged, 30D

    // Switching the range re-runs the query → the number changes (7D: 189).
    await page.getByRole('button', { name: 'Last 7 days' }).click();
    await expect(page.getByText('189', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('810', { exact: true })).toHaveCount(0);

    // Funnel tab: currency-scoped totals.
    await page.getByRole('tab', { name: 'Funnel' }).click();
    await expect(page.getByRole('tab', { name: 'Funnel' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const usd = page.getByRole('region', { name: 'USD pipeline' });
    await expect(usd).toBeVisible();
    await expect(usd.getByText('$600,500')).toBeVisible();

    // Sequences tab: per-sequence numbers.
    await page.getByRole('tab', { name: 'Sequences' }).click();
    await expect(page.getByRole('tab', { name: 'Sequences' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('Onboarding').first()).toBeVisible();
    await expect(page.getByText('17.8%')).toBeVisible(); // Onboarding reply rate
  });
});

test.describe('settings → compliance', () => {
  test('invariant-tagged rails render with their default states', async ({ page }) => {
    await page.goto('/settings?section=compliance');
    const region = page.getByRole('region', { name: 'Compliance' });
    await expect(region).toBeVisible();

    // Recording is OFF by default and has no control to turn it on (I-REC).
    const recording = region.locator('.admin-rail-row', { hasText: 'Call recording' });
    await expect(recording.locator('.admin-rail-row__value')).toHaveText('Off');

    // Unsubscribe is always ON (I-SEND-5).
    const unsubscribe = region.locator('.admin-rail-row', { hasText: 'Honor unsubscribe' });
    await expect(unsubscribe.locator('.admin-rail-row__value')).toHaveText('On');

    // Quiet-hours window (I-QUIET) + per-mailbox daily cap (I-SEND-4).
    const quietHours = region.locator('.admin-rail-row', { hasText: 'Quiet hours' });
    await expect(quietHours.locator('.admin-rail-row__value')).toContainText('08:00');
    await expect(quietHours.locator('.admin-rail-row__value')).toContainText('21:00');
    await expect(page.getByLabel('Daily send cap')).toHaveValue('200');

    // Each rail is tagged to its send-safety invariant.
    for (const invariant of ['I-REC', 'I-SEND-5', 'I-QUIET', 'I-SEND-4']) {
      await expect(region.getByText(new RegExp(invariant))).toBeVisible();
    }
  });
});
