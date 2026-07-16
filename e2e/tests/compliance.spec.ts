import { expect, test } from '@playwright/test';
import { DNC_LEAD_ID, openEmailComposer } from './support/app';

/*
 * A live compliance rail: opening the email composer on a do-not-contact lead
 * must show the DNC block and disable Send (CONTRACTS I-DNC / SUPPRESSED). The
 * engine enforces this; here we assert the UI never offers a bypass. Uses the
 * shared authed storageState.
 */

test('composer on a DNC lead shows the block and disables Send', async ({ page }) => {
  // Navigate straight to the frozen-fixture DNC lead.
  await page.goto(`/leads/${DNC_LEAD_ID}`);

  // Guard: confirm this really is the DNC lead (fails loudly if the fixture moved).
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.lead-header').getByText('Do not contact')).toBeVisible();

  const dialog = await openEmailComposer(page);

  // The pre-send compliance banner is present…
  const banner = dialog.getByRole('alert');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/do-not-contact/i);

  // …and Send is disabled — there is no override control.
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
