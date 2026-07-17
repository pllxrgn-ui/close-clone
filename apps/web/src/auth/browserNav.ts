import { API_BASE } from '../api/client.ts';

/**
 * The API's OIDC login route — `registerOidcAuthRoutes` in
 * `apps/api/src/auth/routes.ts` (GET /api/v1/auth/login): it begins the PKCE
 * flow, sets the txn cookie and 302s to the IdP. It is NOT a JSON endpoint —
 * it must be entered by a real browser navigation, never fetch/XHR.
 */
export const SSO_LOGIN_PATH = `${API_BASE}/auth/login`;

/**
 * Full-page navigation seam. A cross-origin OIDC redirect chain cannot go
 * through the router or the fetch client, so this is the one place that touches
 * `window.location`; keeping it behind an object makes it spyable in jsdom,
 * which does not implement navigation.
 */
export const browserNav = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
