import { expect, test } from '@playwright/test';

/*
 * Keyboard-first surfaces (build guide §8 / DEMO step 10): the command palette
 * (Ctrl/Cmd+K) and the shortcut cheat sheet (?). Uses the shared authed
 * storageState — both live in the authenticated shell.
 */

test('Ctrl/Cmd+K opens the palette immediately, filters, and Enter navigates', async ({ page }) => {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');

  // Opens fast — the palette is always mounted, so it appears immediately.
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible({ timeout: 1000 });

  const input = page.getByRole('combobox', { name: 'Command palette' });
  await expect(input).toBeFocused();

  // Typing filters the command list.
  await input.fill('Pipeline');
  await expect(page.getByRole('option', { name: 'Pipeline' })).toBeVisible();

  // Enter runs the top match → navigates.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/pipeline$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
});

test('? opens the keyboard shortcut sheet', async ({ page }) => {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();

  // Ensure focus is not in an input (the ? binding is suppressed while typing).
  await page.locator('#main-content').click();
  await page.keyboard.press('?');

  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});
