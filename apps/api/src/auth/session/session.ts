import { z } from 'zod';

import { parseCookies, serializeCookie, signValue, verifyValue, type SameSite } from './cookies.ts';

/**
 * Session codec (Task 5a) — the signed, httpOnly, Secure, SameSite=Lax session
 * cookie. State lives entirely in the signed payload (no server session table;
 * see the task report's "why stateless" note), so this is the whole session
 * lifecycle:
 *
 *  - **iat** anchors the ABSOLUTE cap (a session can never outlive `iat + absolute`
 *    no matter how much it is refreshed).
 *  - **exp** is the SLIDING idle deadline; each active request past `renewAfter`
 *    re-issues the cookie with a fresh `exp` (bounded by the absolute cap), so an
 *    in-use session stays alive and an idle one dies at `exp`.
 *  - **logout** clears the cookie ({@link SessionCodec.clear}) — the credential is
 *    gone from the only place it lived (an httpOnly cookie the SPA cannot read).
 *
 * Deactivation (`is_active=false`) is enforced separately and immediately by the
 * guard, which reloads the user every request — so revocation does not depend on
 * session lifetime. The residual risk of a stateless cookie (a captured token
 * stays valid until `exp`) is bounded by the idle window and documented.
 */

export const SESSION_COOKIE_NAME = 'sb_session';

const DEFAULT_IDLE_TTL_SEC = 8 * 60 * 60; // 8h sliding idle window
const DEFAULT_ABSOLUTE_TTL_SEC = 30 * 24 * 60 * 60; // 30d hard cap
const DEFAULT_RENEW_AFTER_SEC = 5 * 60; // re-issue at most every 5 min

const payloadSchema = z.object({
  sub: z.string().min(1), // the Switchboard users.id (app identity, not idp_subject)
  iat: z.number(),
  exp: z.number(),
});

type SessionPayload = z.infer<typeof payloadSchema>;

export interface SessionCodecConfig {
  secret: string;
  idleTtlSec?: number;
  absoluteTtlSec?: number;
  renewAfterSec?: number;
  /** Cookie `Secure` attribute; default true (behind TLS per ARCHITECTURE §8). */
  secure?: boolean;
  now?: () => Date;
}

export interface SessionReadResult {
  userId: string;
  /** Present when the sliding window advanced — caller sets this `Set-Cookie`. */
  refreshedSetCookie?: string;
}

export class SessionCodec {
  private readonly secret: string;
  private readonly idleTtl: number;
  private readonly absoluteTtl: number;
  private readonly renewAfter: number;
  private readonly secure: boolean;
  private readonly now: () => Date;

  constructor(config: SessionCodecConfig) {
    this.secret = config.secret;
    this.idleTtl = config.idleTtlSec ?? DEFAULT_IDLE_TTL_SEC;
    this.absoluteTtl = config.absoluteTtlSec ?? DEFAULT_ABSOLUTE_TTL_SEC;
    this.renewAfter = config.renewAfterSec ?? DEFAULT_RENEW_AFTER_SEC;
    this.secure = config.secure ?? true;
    this.now = config.now ?? (() => new Date());
  }

  private nowSec(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  private cookieAttrs(maxAgeSeconds: number): {
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: SameSite;
    maxAgeSeconds: number;
  } {
    return {
      path: '/',
      httpOnly: true,
      secure: this.secure,
      sameSite: 'Lax',
      maxAgeSeconds,
    };
  }

  private serialize(payload: SessionPayload): string {
    return serializeCookie(
      SESSION_COOKIE_NAME,
      signValue(payload, this.secret),
      this.cookieAttrs(this.idleTtl),
    );
  }

  /** Issue a fresh session cookie for `userId`. Returns the `Set-Cookie` value. */
  issue(userId: string): string {
    const iat = this.nowSec();
    return this.serialize({ sub: userId, iat, exp: iat + this.idleTtl });
  }

  /** Clear the session cookie (logout). */
  clear(): string {
    return serializeCookie(SESSION_COOKIE_NAME, '', this.cookieAttrs(0));
  }

  /**
   * Validate the session cookie from a request `Cookie` header. Returns `null`
   * when there is no valid, unexpired session (tamper, idle expiry, or absolute
   * cap). On success, may include a refreshed `Set-Cookie` (sliding renewal).
   */
  read(cookieHeader: string | undefined): SessionReadResult | null {
    const raw = parseCookies(cookieHeader).get(SESSION_COOKIE_NAME);
    if (raw === undefined) return null;
    const decoded = verifyValue(raw, this.secret);
    if (decoded === null) return null; // tampered / bad signature
    const parsed = payloadSchema.safeParse(decoded);
    if (!parsed.success) return null;

    const { sub, iat, exp } = parsed.data;
    const now = this.nowSec();
    const absoluteDeadline = iat + this.absoluteTtl;

    if (now >= exp) return null; // idle timeout
    if (now >= absoluteDeadline) return null; // absolute cap

    // Sliding renewal, clamped to the absolute deadline.
    const lastIssuedAt = exp - this.idleTtl;
    if (now - lastIssuedAt >= this.renewAfter) {
      const newExp = Math.min(now + this.idleTtl, absoluteDeadline);
      if (newExp > exp) {
        return { userId: sub, refreshedSetCookie: this.serialize({ sub, iat, exp: newExp }) };
      }
    }
    return { userId: sub };
  }
}
