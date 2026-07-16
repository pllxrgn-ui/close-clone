import { loadConfig } from '../config.ts';
import { buildDevServer } from './boot.ts';

/**
 * One-command MOCK_MODE dev server entrypoint (DEV-ONLY).
 *
 *   pnpm --filter @switchboard/api run dev:mock
 *
 * Boots Fastify on PORT (default 3000) against embedded PGlite with the C1
 * migrations applied and the 5k golden fixture loaded, MOCK_MODE providers bound,
 * serving every existing route plugin plus dev-login and the D-023 reference
 * reads. Zero external accounts, zero Docker/Postgres/Redis.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  console.log('[dev] booting MOCK_MODE dev server (embedded PGlite + golden fixture)…');

  const server = await buildDevServer({ config });
  const { timings, counts } = server;
  console.log(
    `[dev] ready in ${timings.totalMs}ms ` +
      `(migrate ${timings.migrateMs}ms · fixtures ${timings.loadMs}ms · seed ${timings.seedMs}ms)`,
  );
  if (counts !== null) {
    console.log(
      `[dev] fixtures: leads=${counts.leads} contacts=${counts.contacts} ` +
        `opportunities=${counts.opportunities} tasks=${counts.tasks} activities=${counts.activities}`,
    );
  }

  await server.app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[dev] listening on http://localhost:${config.port} (mockMode=${config.mockMode})`);
  console.log('[dev] web (real mode): VITE_API_MODE=real, Vite proxy /api → this server');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dev] ${signal} received — shutting down…`);
    server
      .close()
      .then(() => {
        console.log('[dev] shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error('[dev] error during shutdown', err);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[dev] failed to start', err);
  process.exit(1);
});
