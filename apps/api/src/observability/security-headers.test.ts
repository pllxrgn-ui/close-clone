import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import { registerSecurityHeaders, type SecurityHeadersOptions } from './security-headers.ts';

/**
 * Task 5e — security headers plugin. Verifies the four headers, that no-store is
 * scoped to /api, that they survive 404s, and that the defaults are overridable.
 */

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

function build(options?: SecurityHeadersOptions): FastifyInstance {
  const instance = Fastify({ logger: false });
  registerSecurityHeaders(instance, options);
  instance.get('/api/v1/leads', async () => ({ items: [] }));
  instance.get('/health', async () => ({ ok: true }));
  app = instance;
  return instance;
}

describe('registerSecurityHeaders', () => {
  test('sets nosniff / DENY / referrer-policy on every response', async () => {
    const res = await build().inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  test('applies cache-control no-store on /api routes', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/v1/leads' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('does NOT force no-store outside /api', async () => {
    const res = await build().inject({ method: 'GET', url: '/health' });
    expect(res.headers['cache-control']).toBeUndefined();
  });

  test('still emits the headers on a 404', async () => {
    const res = await build().inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  test('does not match a look-alike prefix like /apidocs', async () => {
    const instance = build();
    instance.get('/apidocs', async () => ({ ok: true }));
    const res = await instance.inject({ method: 'GET', url: '/apidocs' });
    expect(res.headers['cache-control']).toBeUndefined();
  });

  test('honors overridden frame-options / referrer-policy / api prefix', async () => {
    const res = await build({
      frameOptions: 'SAMEORIGIN',
      referrerPolicy: 'strict-origin-when-cross-origin',
      apiPathPrefix: '/rest',
    }).inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // /health is not under the custom /rest prefix → no no-store.
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
