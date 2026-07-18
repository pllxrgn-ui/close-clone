import { expect, test } from '@playwright/test';
import { openEmailComposer, openFirstLead } from './support/app';

/*
 * AI confirm-before-commit (build guide §8 / CONTRACTS I-AI).
 *
 * The composer now ships the "Draft with AI" affordance (features/ai
 * AiDraftControl — D-047/D-048). The invariant this locks in: the AI can DRAFT,
 * but only the rep can COMMIT. Generating a draft and inserting it into the
 * composer must never send — the composer's explicit Send button remains the
 * sole send path, and nothing inside the AI panel is send-capable.
 *
 * "Nothing sent" is asserted structurally: a successful send CLOSES the
 * composer (sendMutation.onSuccess) and toasts "Email sent to …" — so the
 * dialog staying open plus an empty send-toast is the no-send proof. (The
 * timeline legitimately contains "Email sent" history rows, so the toast check
 * pins the "to" phrasing only a real send produces.)
 */

test('AI draft requires the rep: generate + insert never sends — Send stays the only commit', async ({
  page,
}) => {
  await openFirstLead(page);
  const dialog = await openEmailComposer(page);
  const sentToast = page.locator('[role="status"]').getByText(/Email sent to/);

  // The AI affordance exists…
  await dialog.getByRole('button', { name: 'Draft with AI' }).click();
  const panel = dialog.getByRole('region', { name: 'AI email assistant' });
  await expect(panel).toBeVisible();

  // …but nothing inside it can send.
  await expect(panel.getByRole('button', { name: /send/i })).toHaveCount(0);

  // Generate a draft — the review note renders; nothing was sent.
  await panel.getByRole('textbox').fill('friendly first-touch intro about saving reps time');
  await panel.getByRole('button', { name: 'Generate draft' }).click();
  await expect(panel.getByText(/never sends for you/i)).toBeVisible();
  await expect(panel.getByRole('button', { name: /send/i })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(sentToast).toHaveCount(0);

  // Insert fills the composer fields — still no send; the human owns Send.
  await panel.getByRole('button', { name: 'Insert into email' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Message body' })).toHaveValue(/Hi there/);
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(sentToast).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
