import { z } from 'zod';

import { parseCookies, serializeCookie, signValue, verifyValue } from './cookies.ts';

/**
 * OIDC login-transaction cookie (Task 5a). Between the `/auth/login` redirect and
 * the `/auth/callback` return, the per-login secrets (state, nonce, PKCE verifier)
 * must survive the round-trip to the IdP without server-side storage. They ride in
 * this short-lived, signed, httpOnly cookie. `SameSite=Lax` is REQUIRED (not
 * Strict): the callback is a top-level GET navigation the IdP redirects to, and
 * Lax is what lets the cookie accompany that cross-site top-level GET. It is
 * cleared the moment the callback consumes it.
 */

export const OIDC_TXN_COOKIE_NAME = 'sb_oidc_txn';

const DEFAULT_TTL_SEC = 10 * 60; // a login must complete within 10 minutes

const payloadSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
  exp: z.number(),
});

export interface OidcTxn {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcTxnCodecConfig {
  secret: string;
  ttlSec?: number;
  secure?: boolean;
  now?: () => Date;
}

export class OidcTxnCodec {
  private readonly secret: string;
  private readonly ttl: number;
  private readonly secure: boolean;
  private readonly now: () => Date;

  constructor(config: OidcTxnCodecConfig) {
    this.secret = config.secret;
    this.ttl = config.ttlSec ?? DEFAULT_TTL_SEC;
    this.secure = config.secure ?? true;
    this.now = config.now ?? (() => new Date());
  }

  private nowSec(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  /** Serialize a `Set-Cookie` carrying the login-transaction secrets. */
  issue(txn: OidcTxn): string {
    const payload = { ...txn, exp: this.nowSec() + this.ttl };
    return serializeCookie(OIDC_TXN_COOKIE_NAME, signValue(payload, this.secret), {
      path: '/',
      httpOnly: true,
      secure: this.secure,
      sameSite: 'Lax',
      maxAgeSeconds: this.ttl,
    });
  }

  /** Read + validate the transaction cookie; `null` if absent/tampered/expired. */
  read(cookieHeader: string | undefined): OidcTxn | null {
    const raw = parseCookies(cookieHeader).get(OIDC_TXN_COOKIE_NAME);
    if (raw === undefined) return null;
    const decoded = verifyValue(raw, this.secret);
    if (decoded === null) return null;
    const parsed = payloadSchema.safeParse(decoded);
    if (!parsed.success) return null;
    if (this.nowSec() >= parsed.data.exp) return null;
    return {
      state: parsed.data.state,
      nonce: parsed.data.nonce,
      codeVerifier: parsed.data.codeVerifier,
    };
  }

  /** Clear the transaction cookie (after the callback consumes it). */
  clear(): string {
    return serializeCookie(OIDC_TXN_COOKIE_NAME, '', {
      path: '/',
      httpOnly: true,
      secure: this.secure,
      sameSite: 'Lax',
      maxAgeSeconds: 0,
    });
  }
}
