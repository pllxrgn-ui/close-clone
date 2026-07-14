import type { FastifyReply } from 'fastify';

/**
 * REST error envelope (CONTRACTS §C8). Every engine/route error serialises to
 * `{ error: { code, message, details? } }` with the fixed status mapping below.
 * Kept in `routes/` as the first shared HTTP helper; later route modules reuse it.
 */

export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SUPPRESSED: 422,
  OUTSIDE_WINDOW: 422,
  CAP_EXCEEDED: 429,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  SYNC_REAUTH_REQUIRED: 409,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/** Send a C8 error envelope with the code's fixed HTTP status. */
export function sendError(
  reply: FastifyReply,
  code: ErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  const envelope: ErrorEnvelope =
    details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return reply.status(ERROR_STATUS[code]).send(envelope);
}
