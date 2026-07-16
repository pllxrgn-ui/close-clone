import type { FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';

import { leadStatuses, opportunityStages, users, type Db } from '../db/index.ts';
import { toIsoRequired } from './util.ts';

/**
 * Reference reads (CONTRACTS §C7, added v1.2.0 / D-023) — rep-accessible label
 * lookups the web needs to render owner/status/stage labels in lists.
 *
 * `GET /users` returns the **minimal** shape only (id, name, email, isActive):
 * C7 is explicit that this endpoint is "label resolution only, never tokens/idp
 * fields", so `idp_subject`, `oauth`-adjacent data, role and timezone are NOT
 * exposed here (the fuller current-user shape lives behind dev-login). This
 * mirrors W1's MSW `/users` handler, which the web treats as reference data.
 */

export interface ReferenceRouteDeps {
  db: Db;
}

export function registerDevReferenceRoutes(app: FastifyInstance, deps: ReferenceRouteDeps): void {
  // GET /api/v1/users — minimal shape, ordered by name for a stable picker.
  app.get('/api/v1/users', async () => {
    const rows = await deps.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        isActive: users.isActive,
      })
      .from(users)
      .orderBy(asc(users.name));
    return rows;
  });

  // GET /api/v1/lead-statuses — full LeadStatus DTO, ordered by sort_order.
  app.get('/api/v1/lead-statuses', async () => {
    const rows = await deps.db
      .select({
        id: leadStatuses.id,
        label: leadStatuses.label,
        sortOrder: leadStatuses.sortOrder,
        createdAt: leadStatuses.createdAt,
        updatedAt: leadStatuses.updatedAt,
      })
      .from(leadStatuses)
      .orderBy(asc(leadStatuses.sortOrder));
    return rows.map((r) => ({
      ...r,
      createdAt: toIsoRequired(r.createdAt),
      updatedAt: toIsoRequired(r.updatedAt),
    }));
  });

  // GET /api/v1/opportunity-stages — full OpportunityStage DTO, by sort_order.
  app.get('/api/v1/opportunity-stages', async () => {
    const rows = await deps.db
      .select({
        id: opportunityStages.id,
        label: opportunityStages.label,
        sortOrder: opportunityStages.sortOrder,
        createdAt: opportunityStages.createdAt,
        updatedAt: opportunityStages.updatedAt,
      })
      .from(opportunityStages)
      .orderBy(asc(opportunityStages.sortOrder));
    return rows.map((r) => ({
      ...r,
      createdAt: toIsoRequired(r.createdAt),
      updatedAt: toIsoRequired(r.updatedAt),
    }));
  });
}
