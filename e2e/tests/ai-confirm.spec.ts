import { expect, test } from '@playwright/test';
import { openEmailComposer, openFirstLead } from './support/app';

/*
 * AI confirm-before-commit (build guide §8 / CONTRACTS I-AI).
 *
 * As of this build there is NO AI affordance wired into the web UI. The three AI
 * paths in ARCHITECTURE §7 — call-summary draft note, email draft/rewrite, and
 * NL → Smart View — have no rendered control on any surface this suite drives
 * (composer, inbox, pipeline, reports, sequences, settings were all verified
 * free of AI/draft/rewrite/generate controls). There is therefore no AI
 * write-path to confirm end-to-end yet, so per task 5d the confirm-flow test is
 * skipped rather than fabricated.
 */

// Enable once an AI affordance (e.g. "Draft with AI" in the composer, or a
// call-summary that produces a draft note) is exposed in the UI. The assertion:
// invoking AI must NOT mutate a record or send until the rep clicks a confirm
// control (I-AI: the confirming request carries confirmedBy).
test.skip('AI output requires an explicit user confirm before it writes', async () => {
  // Intentionally empty — no AI affordance exists to exercise. See file header.
});

// Positive guard locking in the invariant today: the email composer's only
// backend write is the explicit Send button. There is no AI control to bypass
// it, and the template/snippet insert affordances are local-state only.
test('email composer exposes no AI write-path — Send is the only commit', async ({ page }) => {
  await openFirstLead(page);
  const dialog = await openEmailComposer(page);

  await expect(
    dialog.getByRole('button', { name: /\bAI\b|draft|rewrite|generate|assist|magic/i }),
  ).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
