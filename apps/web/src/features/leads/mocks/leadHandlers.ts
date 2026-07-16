import { http, HttpResponse } from 'msw';
import { db } from '../../../mocks/fixtures.ts';

/*
 * Additive MSW handlers for the lead-detail right rail. These implement C7
 * resources the W1 mock left unimplemented (`contacts`, `opportunities`) plus the
 * `opportunity-stages` reference list, reading from the same deterministic
 * fixture `db`. Kept in this feature's directory so the shared mocks/handlers.ts
 * stays untouched; register at merge by spreading `leadDetailHandlers` into the
 * worker/server handler array (see the task's routeWiring), and via `server.use`
 * in this feature's tests.
 */

const api = (path: string): string => `*/api/v1${path}`;

function errorJson(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status });
}

export const leadDetailHandlers = [
  // GET /contacts?leadId= — a lead's contacts (soft-deleted excluded).
  http.get(api('/contacts'), ({ request }) => {
    const leadId = new URL(request.url).searchParams.get('leadId');
    if (!leadId) return errorJson(400, 'VALIDATION_FAILED', 'Query "leadId" is required');
    const items = db.contacts.filter((c) => c.leadId === leadId && c.deletedAt === null);
    return HttpResponse.json(items);
  }),

  // GET /opportunities?leadId= — a lead's opportunities.
  http.get(api('/opportunities'), ({ request }) => {
    const leadId = new URL(request.url).searchParams.get('leadId');
    if (!leadId) return errorJson(400, 'VALIDATION_FAILED', 'Query "leadId" is required');
    const items = db.opportunities.filter((o) => o.leadId === leadId);
    return HttpResponse.json(items);
  }),

  // GET /opportunity-stages — reference list for stage labels.
  http.get(api('/opportunity-stages'), () => HttpResponse.json(db.opportunityStages)),
];
