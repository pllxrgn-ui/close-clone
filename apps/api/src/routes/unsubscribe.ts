import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { applyUnsubscribe, verifyUnsubscribeToken } from '../services/sequences/index.ts';
import { sendError } from './http.ts';

/**
 * Public one-click unsubscribe (CONTRACTS §C6 I-SEND-5). Reachable WITHOUT auth —
 * the opaque HMAC token IS the authorization (it binds the recipient address). Both
 * verbs are served:
 *   - `POST` — the RFC 8058 List-Unsubscribe-Post one-click path (mail clients);
 *   - `GET`  — a human clicking the link in the message.
 * Either lands in `applyUnsubscribe`, which suppresses globally + emits the
 * timeline events. An invalid/tampered token is a 404 (no oracle, no PII leak).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface UnsubscribeRouteDeps {
  db: Db;
  /** Same secret used to mint the List-Unsubscribe token in the send path. */
  secret: string;
}

const paramsSchema = z.object({ token: z.string().min(1).max(2000) });

export function registerUnsubscribeRoutes(app: FastifyInstance, deps: UnsubscribeRouteDeps): void {
  const handle = async (token: string, reply: FastifyReply): Promise<unknown> => {
    const email = verifyUnsubscribeToken(deps.secret, token);
    if (email === null) return sendError(reply, 'NOT_FOUND', 'invalid unsubscribe token');
    const result = await applyUnsubscribe(deps.db, { email });
    return reply.send({ ok: true, unsubscribed: email, changed: result.changed });
  };

  app.post('/api/v1/unsubscribe/:token', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid token', params.error.flatten());
    }
    return handle(params.data.token, reply);
  });

  app.get('/api/v1/unsubscribe/:token', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid token', params.error.flatten());
    }
    return handle(params.data.token, reply);
  });
}
