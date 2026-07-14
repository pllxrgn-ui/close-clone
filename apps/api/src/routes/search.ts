import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/index.ts';
import { InvalidCursorError, SearchService, type SearchOptions } from '../services/search/index.ts';
import { sendError } from './http.ts';

/**
 * `GET /api/v1/search?q=&limit=&cursor=` (CONTRACTS §C7). Zod-validates the query
 * string, delegates ranking + keyset pagination to `SearchService`, and returns
 * the `{ items, nextCursor? }` envelope. Bad input → `VALIDATION_FAILED` (§C8).
 */

const querySchema = z.object({
  q: z.string().optional().default(''),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

export interface SearchRouteDeps {
  db: Db;
}

export function registerSearchRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  const service = new SearchService(deps.db);

  app.get('/api/v1/search', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid search query', parsed.error.flatten());
    }

    const { q, limit, cursor } = parsed.data;
    const options: SearchOptions = {
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };

    try {
      const page = await service.search(q, options);
      return reply.send(page);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return sendError(reply, 'VALIDATION_FAILED', err.message);
      }
      throw err;
    }
  });
}
