import type { FastifyInstance } from 'fastify';

/**
 * Minimal CORS + preflight for the dev server (no dependency on @fastify/cors).
 *
 * The intended demo topology is the Vite dev proxy (`/api` → localhost:3000),
 * which makes the browser see one origin — so cookies "just work" and CORS is
 * moot. This handler is the belt-and-suspenders path for hitting the API cross
 * origin straight from http://localhost:5173: it echoes an allow-listed Origin
 * (never `*`, which is illegal with credentials) and answers preflight.
 */

const DEFAULT_ALLOWED = ['http://localhost:5173', 'http://127.0.0.1:5173'] as const;

const ALLOW_METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'content-type,authorization,idempotency-key,accept';

export interface DevCorsOptions {
  /** Extra origins to allow beyond the Vite dev defaults. */
  origins?: readonly string[];
}

export function registerDevCors(app: FastifyInstance, opts: DevCorsOptions = {}): void {
  const allowed = new Set<string>([...DEFAULT_ALLOWED, ...(opts.origins ?? [])]);

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers['origin'];
    if (typeof origin === 'string' && allowed.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      return reply
        .header('access-control-allow-methods', ALLOW_METHODS)
        .header('access-control-allow-headers', ALLOW_HEADERS)
        .header('access-control-max-age', '86400')
        .status(204)
        .send();
    }
    return undefined;
  });
}
