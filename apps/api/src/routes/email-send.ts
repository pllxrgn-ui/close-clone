import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import type { ActivityWebhookEmitter } from '../services/activity/index.ts';
import { InvalidActorError } from '../services/templates/index.ts';
import {
  MergeRenderError,
  SendAccountNotFoundError,
  SendAccountNotLinkedError,
  SendContactNotFoundError,
  SendLeadNotFoundError,
  SendProviderError,
  SendThreadConflictError,
  SendValidationError,
  SuppressedError,
  sendOneOff,
  type ProviderForAccount,
  type SendOneOffInput,
} from '../services/email/index.ts';
import { TemplateNotFoundError } from '../services/templates/index.ts';
import type { TokenCipher } from '../services/sync/token-cipher.ts';
import { sendError } from './http.ts';

/**
 * One-off send REST surface (CONTRACTS §C7 `POST /emails/send`, task 2d).
 *
 * The route is a thin translator: it validates the request shape, then hands off
 * to the `sendOneOff` engine, which owns EVERY compliance rail (suppression,
 * contact/lead DNC, merge-tag resolution) at execution time. The API therefore
 * cannot bypass the rails — a send to a suppressed/DNC recipient returns C8
 * SUPPRESSED (422), never an override prompt (I-RAIL-API).
 *
 * Deps are injected (per-account provider resolver + token cipher) so the module
 * never branches on MOCK_MODE — the composition root chooses the adapters.
 */

export interface EmailSendRouteDeps {
  db: Db;
  providerFor: ProviderForAccount;
  cipher: TokenCipher;
  /** Fans email_sent onto activity.recorded webhooks (passed through to sendOneOff). */
  emitter?: ActivityWebhookEmitter;
}

const addressList = z.array(z.string().min(3).max(320)).max(100);

const sendBodySchema = z.object({
  /**
   * OPTIONAL since the auth mount (review finding F3): the authenticated
   * principal is the source of truth for attribution. Kept for the pre-auth
   * seam (the embedded test server mounts no auth), but it can never be used to
   * act as someone else — see {@link resolveActorId}.
   */
  actorId: z.string().uuid().optional(),
  accountId: z.string().uuid(),
  leadId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  to: addressList.optional(),
  cc: addressList.optional(),
  subject: z.string().max(2000).optional(),
  body: z.string().max(500_000).optional(),
  templateId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  inReplyToMessageId: z.string().uuid().optional(),
});

/** Map a send-engine error to its C8 envelope; null if not a known send error. */
function mapSendError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof SuppressedError) return sendError(reply, 'SUPPRESSED', err.message);
  if (err instanceof MergeRenderError) {
    return sendError(reply, 'VALIDATION_FAILED', err.message, { unresolved: err.unresolved });
  }
  if (err instanceof SendValidationError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  if (err instanceof SendAccountNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof SendLeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof SendContactNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof TemplateNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof SendAccountNotLinkedError) return sendError(reply, 'CONFLICT', err.message);
  if (err instanceof SendThreadConflictError) return sendError(reply, 'CONFLICT', err.message);
  if (err instanceof SendProviderError) return sendError(reply, 'PROVIDER_ERROR', err.message);
  if (err instanceof InvalidActorError) return sendError(reply, 'FORBIDDEN', err.message);
  return null;
}

/** A caller tried to attribute a send to someone other than themselves. */
class ActorSpoofError extends Error {
  constructor() {
    super('actorId does not match the authenticated principal');
  }
}

/**
 * Resolve who this send is attributed to (review finding F3, deploy/WIRING.md §2).
 *
 * The authenticated principal ALWAYS wins — `request.actor` is set by the
 * session guard (a user) or the Bearer pre-handler (an api token), so neither a
 * session cookie nor a scoped token can act as another user by putting an id in
 * the payload. A body `actorId` that disagrees is refused (FORBIDDEN) rather
 * than silently rewritten: it is either a client bug or an impersonation
 * attempt, and both deserve to be seen.
 *
 * With no principal (the embedded/test server mounts no auth) the body value is
 * used — production mounts a GLOBAL requireSession over `/api/v1/*`, so that
 * path is unreachable there.
 */
export function resolveActorId(
  principalId: string | undefined,
  bodyActorId: string | undefined,
): string | null {
  if (principalId !== undefined) {
    if (bodyActorId !== undefined && bodyActorId !== principalId) throw new ActorSpoofError();
    return principalId;
  }
  return bodyActorId ?? null;
}

export function registerEmailSendRoutes(app: FastifyInstance, deps: EmailSendRouteDeps): void {
  // POST /api/v1/emails/send
  app.post('/api/v1/emails/send', async (request, reply) => {
    const parsed = sendBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid send request', parsed.error.flatten());
    }
    const d = parsed.data;
    // An Idempotency-Key header is honoured when the body omits one.
    const headerKey = request.headers['idempotency-key'];
    const idempotencyKey =
      d.idempotencyKey ??
      (typeof headerKey === 'string' && headerKey.length > 0 ? headerKey : undefined);

    // F3: attribution comes from the authenticated principal, never the payload.
    // ActorHint.id is nullable (the audit layer's system actor has none); only a
    // real id counts as a principal here.
    const principalId = request.actor?.id ?? undefined;
    let actorId: string | null;
    try {
      actorId = resolveActorId(principalId, d.actorId);
    } catch {
      return sendError(reply, 'FORBIDDEN', 'actorId does not match the authenticated principal');
    }
    if (actorId === null) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'actorId is required without an authenticated principal',
      );
    }

    const input: SendOneOffInput = {
      actorId,
      accountId: d.accountId,
      leadId: d.leadId,
      ...(d.contactId !== undefined ? { contactId: d.contactId } : {}),
      ...(d.to !== undefined ? { to: d.to } : {}),
      ...(d.cc !== undefined ? { cc: d.cc } : {}),
      ...(d.subject !== undefined ? { subject: d.subject } : {}),
      ...(d.body !== undefined ? { body: d.body } : {}),
      ...(d.templateId !== undefined ? { templateId: d.templateId } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(d.inReplyToMessageId !== undefined ? { inReplyToMessageId: d.inReplyToMessageId } : {}),
    };

    try {
      const result = await sendOneOff(deps, input);
      return reply.send(result);
    } catch (err) {
      const mapped = mapSendError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
