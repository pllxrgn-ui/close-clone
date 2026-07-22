import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  smartViewFieldCatalogSchema,
  type AIProvider,
  type ASRProvider,
  type SmartViewFieldCatalog,
} from '@switchboard/shared/providers';
import { BUILTIN_FIELD_NAMES, astToDsl } from '@switchboard/shared';
import type { Db } from '../db/index.ts';
import { LeadNotFoundError, type ActivityWebhookEmitter } from '../services/activity/index.ts';
import {
  CallNotFoundError,
  EmailDraftError,
  NlToSmartViewError,
  NoTranscriptSourceError,
  NotAiNoteError,
  SummaryAlreadyFinalError,
  SummaryNoteNotFoundError,
  confirmCallSummary,
  draftEmailForComposer,
  generateCallSummaryDraft,
  nlToSmartView,
} from '../services/ai/index.ts';
import { AIRefusalError } from '../providers/ai/index.ts';
import { sendError } from './http.ts';

/**
 * AI feature HTTP surface (tasks 3e/3g). Confirm-before-commit is the through-line
 * (CONTRACTS §I-AI, ARCHITECTURE §7):
 *
 *  - `POST /api/v1/ai/call-summaries` runs ASR→AI and writes a DRAFT note only; it
 *    emits no timeline event.
 *  - `POST /api/v1/ai/call-summaries/:noteId/confirm` is the ONLY route that flips a
 *    draft to final + emits `note_added`; it REQUIRES `confirmedBy` (a uuid) in the
 *    body — the recorded user action (§I-AI). In production the composition root
 *    binds `confirmedBy` from the session; accepting it in the body is the same
 *    actor-from-body deploy seam documented for the other write routes (D-032).
 *  - `POST /api/v1/ai/email-drafts` returns a composer draft — no send (§I-AI); the
 *    2d send route still carries every send rail.
 *  - `POST /api/v1/ai/smart-view` returns the AI's DSL RE-PARSED by the shared parser;
 *    invalid DSL is a visible VALIDATION_FAILED with position, never a saved guess.
 *
 * Deps are injected; the module never branches on MOCK_MODE (the registry binds the
 * mock or real ASR/AI adapters). C7 does not enumerate `ai/*` routes — see the task
 * report's contract-friction note; ARCHITECTURE §7 blesses the behavior.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface AiRouteDeps {
  db: Db;
  /** Optional because drafting and NL-to-Smart-View need only the AI provider. */
  asr?: ASRProvider;
  ai: AIProvider;
  now?: () => Date;
  /** Default NL→Smart View field catalog when a request omits one. */
  fieldCatalog?: SmartViewFieldCatalog;
  /** Fans the confirmed AI note onto activity.recorded webhooks. */
  activityEmitter?: ActivityWebhookEmitter;
}

const generateBodySchema = z.object({
  callId: z.string().uuid(),
  audioRef: z.string().min(1).max(2048).optional(),
});

const confirmBodySchema = z.object({
  confirmedBy: z.string().uuid(),
});

const draftBodySchema = z.object({
  instruction: z.string().min(1).max(10_000),
  threadCtx: z
    .object({
      subject: z.string().max(2000).optional(),
      recentMessages: z
        .array(z.object({ from: z.string().max(320), body: z.string().max(20_000) }))
        .max(20)
        .optional(),
    })
    .optional(),
});

const smartViewBodySchema = z.object({
  query: z.string().min(1).max(2000),
  catalog: smartViewFieldCatalogSchema.optional(),
});

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const now = deps.now ?? ((): Date => new Date());

  // POST /api/v1/ai/call-summaries — ASR→AI → DRAFT note (no timeline event).
  app.post('/api/v1/ai/call-summaries', async (request, reply) => {
    const parsed = generateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid call summary request',
        parsed.error.flatten(),
      );
    }
    if (deps.asr === undefined) {
      return sendError(
        reply,
        'PROVIDER_ERROR',
        'Call transcription is unavailable until Deepgram is configured',
      );
    }
    try {
      const draft = await generateCallSummaryDraft(
        { db: deps.db, asr: deps.asr, ai: deps.ai, now },
        {
          callId: parsed.data.callId,
          ...(parsed.data.audioRef !== undefined ? { audioRef: parsed.data.audioRef } : {}),
        },
      );
      return reply.send(draft);
    } catch (err) {
      if (err instanceof CallNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
      if (err instanceof NoTranscriptSourceError)
        return sendError(reply, 'VALIDATION_FAILED', err.message);
      const refusal = mapRefusal(reply, err);
      if (refusal !== null) return refusal;
      throw err;
    }
  });

  // POST /api/v1/ai/call-summaries/:noteId/confirm — draft → final + note_added.
  app.post('/api/v1/ai/call-summaries/:noteId/confirm', async (request, reply) => {
    const idResult = z
      .string()
      .uuid()
      .safeParse((request.params as { noteId?: unknown }).noteId);
    if (!idResult.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid note id');
    const parsed = confirmBodySchema.safeParse(request.body);
    if (!parsed.success) {
      // A missing/blank confirmedBy is rejected here — §I-AI: no final without a
      // recorded confirming user.
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'confirmedBy is required',
        parsed.error.flatten(),
      );
    }
    try {
      const result = await confirmCallSummary(
        {
          db: deps.db,
          now,
          ...(deps.activityEmitter !== undefined ? { emitter: deps.activityEmitter } : {}),
        },
        { noteId: idResult.data, confirmedBy: parsed.data.confirmedBy },
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof SummaryNoteNotFoundError)
        return sendError(reply, 'NOT_FOUND', err.message);
      if (err instanceof LeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
      if (err instanceof NotAiNoteError) return sendError(reply, 'VALIDATION_FAILED', err.message);
      if (err instanceof SummaryAlreadyFinalError) return sendError(reply, 'CONFLICT', err.message);
      throw err;
    }
  });

  // POST /api/v1/ai/email-drafts — draft for composer (never auto-sent).
  app.post('/api/v1/ai/email-drafts', async (request, reply) => {
    const parsed = draftBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid email draft request',
        parsed.error.flatten(),
      );
    }
    try {
      const draft = await draftEmailForComposer(
        { ai: deps.ai },
        {
          instruction: parsed.data.instruction,
          ...(parsed.data.threadCtx !== undefined ? { threadCtx: parsed.data.threadCtx } : {}),
        },
      );
      return reply.send(draft);
    } catch (err) {
      if (err instanceof EmailDraftError) return sendError(reply, 'VALIDATION_FAILED', err.message);
      const refusal = mapRefusal(reply, err);
      if (refusal !== null) return refusal;
      throw err;
    }
  });

  // POST /api/v1/ai/smart-view — NL → DSL (re-parsed) → AST for the builder.
  app.post('/api/v1/ai/smart-view', async (request, reply) => {
    const parsed = smartViewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid smart view request',
        parsed.error.flatten(),
      );
    }
    const catalog: SmartViewFieldCatalog = parsed.data.catalog ??
      deps.fieldCatalog ?? { builtins: [...BUILTIN_FIELD_NAMES], custom: [] };
    try {
      const result = await nlToSmartView({ ai: deps.ai }, { query: parsed.data.query, catalog });
      if (!result.ok) {
        // Invalid DSL is surfaced as a visible error, never a silent guess (§7).
        return sendError(reply, 'VALIDATION_FAILED', 'AI produced invalid DSL', {
          rawDsl: result.rawDsl,
          parseError: result.error,
          ...(result.position !== undefined ? { position: result.position } : {}),
        });
      }
      // Return the canonicalized DSL (round-tripped from the AST) + the AST for the
      // builder to confirm and save via POST /smart-views.
      return reply.send({ dsl: astToDsl(result.ast), ast: result.ast });
    } catch (err) {
      if (err instanceof NlToSmartViewError)
        return sendError(reply, 'VALIDATION_FAILED', err.message);
      const refusal = mapRefusal(reply, err);
      if (refusal !== null) return refusal;
      throw err;
    }
  });
}

/** Map a Claude decline to C8 PROVIDER_ERROR; null if not a refusal. */
function mapRefusal(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof AIRefusalError) return sendError(reply, 'PROVIDER_ERROR', err.message);
  return null;
}
