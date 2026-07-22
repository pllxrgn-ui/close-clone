import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as setup } from '@playwright/test';
import { ADMIN_USER } from './support/app';

/*
 * Setup project: logs in once through the real dev-login UI and saves the
 * authenticated localStorage as storageState for the authed specs to reuse.
 * Doubles as a smoke of the /welcome → Open Switchboard → dev-login → overview path.
 * Logs in as the admin fixture user so admin-only surfaces (Settings) work.
 */

const STORAGE_STATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.auth', 'user.json');

setup('authenticate as the admin fixture user', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { name: /Pick up the line/ })).toBeVisible();

  // Primary CTA routes to the dev-login gate.
  await page.getByRole('link', { name: 'Open Switchboard' }).first().click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByRole('button', { name: new RegExp(ADMIN_USER.name) }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
