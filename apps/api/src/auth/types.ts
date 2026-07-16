import type { FastifyRequest } from 'fastify';

import type { userRoleValues } from '@switchboard/shared';
import type { ActorHint } from '../services/audit/index.ts';

/**
 * Auth request context (Task 5a). The guards attach the authenticated user and an
 * audit {@link ActorHint} to the Fastify request; downstream handlers and the
 * audit/export routes read them. Kept in one module so the `declare module`
 * augmentation has a single home.
 */

export type Role = (typeof userRoleValues)[number];

/** The minimal identity the guards resolve per request (never tokens/idp fields). */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  timezone: string;
}

/** Result of reading a session from a request (the guard's SessionReader seam). */
export interface SessionResolution {
  userId: string;
  /** A sliding-renewal `Set-Cookie` the guard should echo, if the codec refreshed it. */
  refreshedSetCookie?: string;
}

/**
 * The issuer-agnostic session seam (ARCHITECTURE §1 "bind at the adapter line").
 * The guards depend only on this; the composition root injects the real-mode
 * reader (OIDC session cookie) or the MOCK_MODE reader (dev-login) — no code above
 * the seam branches on MOCK_MODE.
 */
export type SessionReader = (request: FastifyRequest) => SessionResolution | null;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireSession/requireAdmin once the session resolves to an active user. */
    user?: AuthenticatedUser;
    /** Audit actor derived from the session (`{ id, type: 'user' }`). */
    actor?: ActorHint;
  }
}
