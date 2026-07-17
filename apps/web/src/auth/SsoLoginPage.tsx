import type { JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../ui/index.ts';
import { BoardMark } from '../ui/BoardMark.tsx';
import { browserNav, SSO_LOGIN_PATH } from './browserNav.ts';

/**
 * Real-mode sign-in (VITE_API_MODE=real). Switchboard has no password store —
 * the IdP assertion is the only credential (CONTRACTS/guide §4.1) — so the whole
 * screen is one action: hand the browser to the API's OIDC login route, which
 * 302s on to the company IdP and comes back to /api/v1/auth/callback with the
 * session cookie. This MUST be a document navigation, not fetch.
 */

/**
 * Coarse denial reasons the API's callback bounces back as `/login?error=…`
 * (`failRedirect` in apps/api/src/auth/routes.ts). Anything unlisted collapses
 * to the generic message — the reason string is never rendered verbatim.
 */
const ERROR_COPY: Record<string, string> = {
  no_access: 'Your directory groups don’t grant you access to Switchboard. Ask an admin.',
  inactive: 'That account is deactivated in Switchboard. Ask an admin to re-enable it.',
  no_email: 'Your identity provider didn’t release an email address for this account.',
  idp_unavailable: 'The identity provider could not be reached. Try again in a moment.',
  idp_error: 'The identity provider rejected the sign-in attempt.',
  expired: 'That sign-in attempt expired. Start again.',
};

const GENERIC_ERROR = 'Sign-in couldn’t be completed. Try again.';

export function SsoLoginPage(): JSX.Element {
  const [params] = useSearchParams();
  const reason = params.get('error');
  const error = reason === null ? null : (ERROR_COPY[reason] ?? GENERIC_ERROR);

  return (
    <main className="sb-login">
      <div className="sb-login__card">
        <div className="sb-login__brand">
          <BoardMark size={20} />
          <span>Switchboard</span>
        </div>
        <h1 className="sb-login__title">Sign in</h1>
        <p className="sb-login__hint">
          Switchboard is an internal tool. Sign in with your company account — access and role come
          from your directory groups, and every sign-in is recorded in the audit log.
        </p>

        {error === null ? null : (
          <p role="alert" className="sb-login__error">
            {error}
          </p>
        )}

        <Button
          variant="primary"
          size="lg"
          className="sb-login__sso"
          onClick={() => browserNav.assign(SSO_LOGIN_PATH)}
        >
          Sign in with SSO
        </Button>

        <p className="sb-login__note">
          You’ll be redirected to your identity provider. Switchboard never sees or stores a
          password.
        </p>
      </div>
    </main>
  );
}
