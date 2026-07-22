import { expect, test } from '@playwright/test';
import { ADMIN_USER, openEmailComposer, openFirstLead, readInboxStat } from './support/app';

/*
 * The full rep loop (build guide §8). One continuous, logged-out-to-authed
 * journey that mirrors the demo walkthrough: land on /welcome, sign in, work a
 * lead + its timeline + the composer, then work the Inbox queue. The remaining
 * surfaces (sequences, pipeline, reports, settings) are covered as focused
 * authed specs in surfaces.spec.ts.
 */

// Start logged out — this spec exercises the real welcome + dev-login flow.
test.use({ storageState: { cookies: [], origins: [] } });

test('rep loop: welcome → login → lead + composer → inbox queue', async ({ page }) => {
  test.setTimeout(120_000);
  let leadName = '';

  await test.step('land on /welcome — the board ignites', async () => {
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { name: /Pick up the line/ })).toBeVisible();
    await expect(page.locator('.sb-welcome__hero')).toHaveAttribute('data-ignite', /igniting|lit/);
  });

  await test.step('Open Switchboard → dev-login → land in the app', async () => {
    await page.getByRole('link', { name: 'Open Switchboard' }).first().click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(ADMIN_USER.name) }).click();
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  });

  await test.step('open Leads → open a lead → timeline renders', async () => {
    leadName = await openFirstLead(page);
    expect(leadName.length).toBeGreaterThan(0);
    await expect(page.getByRole('main', { name: 'Activity timeline' })).toBeVisible();
    // The spine renders at least one event row.
    await expect(
      page.locator('main[aria-label="Activity timeline"] li.tl-event').first(),
    ).toBeVisible();
  });

  await test.step('open Email on the lead → composer opens → merge-tag behavior → close', async () => {
    const dialog = await openEmailComposer(page);
    await dialog
      .getByRole('textbox', { name: 'Message body' })
      .fill('Hi {{lead.name}} — quick follow-up.');
    // The live preview resolves {{lead.name}} to this lead's name.
    await expect(dialog.getByRole('region', { name: 'Preview' })).toContainText(leadName);
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  await test.step('Inbox: a queue renders', async () => {
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { level: 2, name: 'Overdue' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Complete task for / }).first()).toBeVisible();
  });

  await test.step('completing a task removes the row and decrements the counter', async () => {
    const needsBefore = await readInboxStat(page, 'Needs you now');
    const doneBefore = await readInboxStat(page, 'Done today');
    const completeButtons = page.getByRole('button', { name: /^Complete task for / });
    const tasksBefore = await completeButtons.count();
    expect(tasksBefore).toBeGreaterThan(0);

    await completeButtons.first().click();

    await expect(completeButtons).toHaveCount(tasksBefore - 1);
    await expect.poll(() => readInboxStat(page, 'Needs you now')).toBe(needsBefore - 1);
    await expect.poll(() => readInboxStat(page, 'Done today')).toBe(doneBefore + 1);
  });

  await test.step('a reply sends and the row leaves the queue', async () => {
    const replyButtons = page.getByRole('button', { name: /^Reply to / });
    const repliesBefore = await replyButtons.count();
    expect(repliesBefore).toBeGreaterThan(0);

    await replyButtons.first().click();
    const replyDialog = page.getByRole('dialog', { name: /^Reply to / });
    await expect(replyDialog).toBeVisible();
    await replyDialog.getByLabel('Message').fill('Thanks — following up shortly.');
    await replyDialog.getByRole('button', { name: 'Send' }).click();

    await expect(replyDialog).toBeHidden();
    await expect(replyButtons).toHaveCount(repliesBefore - 1);
  });
});
