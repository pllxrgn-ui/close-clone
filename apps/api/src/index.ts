import { buildServer } from './server.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = buildServer();

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((address) => {
    console.log(`[api] listening on ${address} (mockMode=${config.mockMode})`);
  })
  .catch((err: unknown) => {
    console.error('[api] failed to start', err);
    process.exit(1);
  });
