import { main } from './main.ts';

/**
 * Container entrypoint (`APP_ROLE=server|worker`). All assembly lives in
 * `main.ts` — the production composition root — so this file stays a launcher.
 *
 * It used to call `buildServer()` directly, which is the test/embedded helper:
 * no auth, a stub `/healthz`, no migrations, no workers. That meant the
 * deployed image served the entire API unauthenticated and ignored the
 * MIGRATE_ON_BOOT/APP_ROLE config the compose file sets. Boot through `main()`.
 */
main().catch((err: unknown) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
