import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import {
  SmsContactNotFoundError,
  SmsLeadNotFoundError,
  SmsProviderError,
  SmsQuietHoursError,
  SmsSuppressedError,
  SmsValidationError,
  sendSms,
  type SmsSendDeps,
  type SmsSendInput,
} from '../services/sms/index.ts';
import { sendError } from './http.ts';

/**
 * Two-way SMS send REST surface (CONTRACTS §C7 `POST /sms/send`, task 3f).
 *
 * The route is a thin translator: it validates the request shape, then hands off
 * to the `sendSms` engine, which owns EVERY compliance rail (I-DNC / suppression,
 * I-QUIET quiet hours, first-contact opt-out language) at execution time. The API
 * therefore cannot bypass the rails — a send to a suppressed/DNC number returns C8
 * SUPPRESSED (422) and a send outside 8am–9pm recipient-local returns C8
 * OUTSIDE_WINDOW (422), never an override prompt (I-RAIL-API).
 *
 * Deps are injected (the telephony provider + default sender number) so the module
 * never branches on MOCK_MODE — the composition root binds the mock (3a) or the
 * real Twilio adapter (3b).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface SmsRouteDeps {
  db: Db;
  provider: SmsSendDeps['provider'];
  now: () => Date;
  /** Default outbound sender number (org Twilio number) when a send omits `from`. */
  fromNumber?: string;
  /** Override the appended first-contact opt-out sentence (§4.5). */
  optOutLanguage?: string;
}

const sendBodySchema = z.object({
  userId: z.string().uuid(),
  leadId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  to: z.string().min(3).max(40).optional(),
  from: z.string().min(3).max(40).optional(),
  body: z.string().min(1).max(1600),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

/** Map an sms-engine error to its C8 envelope; null if not a known send error. */
function mapSmsError(reply: FastifyReply, err: unknown): FastifyReply | null {
  // I-DNC/suppression is a hard block — C8 SUPPRESSED (422), never an override prompt.
  if (err instanceof SmsSuppressedError) return sendError(reply, 'SUPPRESSED', err.message);
  // I-QUIET — outside 8am–9pm recipient-local.
  if (err instanceof SmsQuietHoursError) return sendError(reply, 'OUTSIDE_WINDOW', err.message);
  if (err instanceof SmsLeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof SmsContactNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof SmsValidationError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  if (err instanceof SmsProviderError) return sendError(reply, 'PROVIDER_ERROR', err.message);
  return null;
}

export function registerSmsRoutes(app: FastifyInstance, deps: SmsRouteDeps): void {
  // POST /api/v1/sms/send
  app.post('/api/v1/sms/send', async (request, reply) => {
    const parsed = sendBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid sms send request',
        parsed.error.flatten(),
      );
    }
    const d = parsed.data;
    // An Idempotency-Key header is honoured when the body omits one.
    const headerKey = request.headers['idempotency-key'];
    const idempotencyKey =
      d.idempotencyKey ??
      (typeof headerKey === 'string' && headerKey.length > 0 ? headerKey : undefined);

    const input: SmsSendInput = {
      userId: d.userId,
      leadId: d.leadId,
      body: d.body,
      ...(d.contactId !== undefined ? { contactId: d.contactId } : {}),
      ...(d.to !== undefined ? { to: d.to } : {}),
      ...(d.from !== undefined ? { from: d.from } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    try {
      const result = await sendSms(
        {
          db: deps.db,
          provider: deps.provider,
          now: deps.now,
          ...(deps.fromNumber !== undefined ? { fromNumber: deps.fromNumber } : {}),
          ...(deps.optOutLanguage !== undefined ? { optOutLanguage: deps.optOutLanguage } : {}),
        },
        input,
      );
      return reply.send(result);
    } catch (err) {
      const mapped = mapSmsError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });
}
