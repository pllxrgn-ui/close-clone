import type { z } from 'zod';
import {
  emailDraftSchema,
  emailThreadContextSchema,
  type AIProvider,
  type EmailDraft,
} from '@switchboard/shared/providers';

/**
 * AI email drafting (task 3g). ARCHITECTURE §7 / §I-AI: the draft is RETURNED to the
 * composer, NEVER auto-sent. This service therefore performs no writes and no sends
 * of any kind — it validates the request, calls the provider, and returns the draft.
 * The rep still triggers the real send through the 2d `POST /emails/send` path, which
 * carries every send rail (I-DNC / suppression / window / cap). There is deliberately
 * no dependency here on the send engine: a draft cannot become a send in this module.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface DraftEmailDeps {
  ai: AIProvider;
}

export interface DraftEmailInput {
  instruction: string;
  /**
   * Minimal thread context (subject + recent messages); optional for a cold draft.
   * Accepts the schema INPUT shape (`recentMessages` optional) — it is parsed here,
   * so the caller can pass the raw request body without pre-defaulting.
   */
  threadCtx?: z.input<typeof emailThreadContextSchema>;
}

export class EmailDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDraftError';
  }
}

/**
 * Produce an email draft for the composer. Returns `{subject?, body}` and writes
 * nothing. The caller renders it into the composer for the rep to edit and send.
 */
export async function draftEmailForComposer(
  deps: DraftEmailDeps,
  input: DraftEmailInput,
): Promise<EmailDraft> {
  if (input.instruction.trim().length === 0) {
    throw new EmailDraftError('instruction is required');
  }
  const threadCtx = emailThreadContextSchema.parse(input.threadCtx ?? {});
  const draft = await deps.ai.draftEmail(input.instruction, threadCtx);
  // Re-validate the provider output shape before it reaches the composer.
  return emailDraftSchema.parse(draft);
}
