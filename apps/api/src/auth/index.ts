/**
 * Auth module barrel (Task 5a) — OIDC SSO + group-based RBAC. The public surface
 * the composition root wires:
 *
 *  - Guards: {@link requireSession}, {@link requireAdmin} (the real `adminGuard`).
 *  - Session: {@link SessionCodec}, {@link OidcTxnCodec}.
 *  - OIDC: {@link OidcClient} + {@link createFetchTransport} (real network) — tests
 *    inject the LocalOidcIssuer transport (imported directly, not from here).
 *  - RBAC/provisioning: {@link groupsToRole}, {@link provisionUser}.
 *  - Routes: {@link registerOidcAuthRoutes} (real-mode login/callback/logout/me).
 *  - CSRF: {@link CSRF_HEADER}, {@link isMutatingMethod}.
 *
 * Importing this barrel also applies the `FastifyRequest` augmentation from
 * `types.ts` (adds `request.user` / `request.actor`).
 */
export * from './types.ts';
export * from './rbac.ts';
export * from './csrf.ts';
export * from './guards.ts';
export * from './provisioning.ts';
export * from './auth-audit.ts';
export * from './session/cookies.ts';
export * from './session/session.ts';
export * from './session/txn.ts';
export * from './oidc/index.ts';
export { registerOidcAuthRoutes, type OidcAuthRouteDeps } from './routes.ts';
