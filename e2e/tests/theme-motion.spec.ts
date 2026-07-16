import { expect, test } from '@playwright/test';

/*
 * Theme + reduced-motion smoke (build guide §8): both color schemes render, the
 * theme choice persists across reload, and the app still renders with
 * prefers-reduced-motion. Uses the shared authed storageState.
 */

test.describe('theme', () => {
  test('toggling theme persists across reload', async ({ page }) => {
    await page.goto('/inbox');
    const toggle = page.getByRole('button', { name: /^Theme:/ });
    await expect(toggle).toBeVisible();

    // Default choice is "system" (no [data-theme]); one cycle → light, which
    // stamps <html data-theme="light"> and writes localStorage 'sb-theme'.
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // The index.html bootstrap re-stamps the persisted choice before first paint.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
  });
});

test.describe('dark color scheme', () => {
  test.use({ colorScheme: 'dark' });

  test('app renders in dark mode without crashing', async ({ page }) => {
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    // 'system' resolves to dark under prefers-color-scheme: dark.
    await expect(page.getByRole('button', { name: /^Theme: system/ })).toBeVisible();
  });
});

test.describe('reduced motion', () => {
  // reducedMotion is set via contextOptions (not a hoisted `use` option).
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('app renders under prefers-reduced-motion without crashing', async ({ page }) => {
    // Public landing renders (the hero ignition collapses to instant).
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { name: /Pick up the line/ })).toBeVisible();

    // The authed leads surface reflects the reduced-motion hook and still renders.
    await page.goto('/leads');
    await expect(page.getByRole('grid', { name: 'Leads' })).toBeVisible();
    await expect(page.locator('.leads-surface')).toHaveAttribute('data-reduced-motion', 'true');
  });
});
