import type { Contact, Opportunity } from '@switchboard/shared';
import { apiRequest } from '../../../api/client.ts';

/*
 * Lead-detail read endpoints (CONTRACTS §C7 resources `contacts`,
 * `opportunities`, plus the `opportunity-stages` reference list). These back the
 * read-only right-rail cards on the lead page. Returned as plain arrays — the
 * per-lead set is small and bounded — matching the reference-data style of
 * api/reference.ts rather than the keyset list envelope.
 *
 * NOTE (reported upward): the W1 MSW handler set does not implement these; the
 * matching mock handlers live in ../mocks/leadHandlers.ts and are registered per
 * the task's routeWiring (and via server.use in this feature's tests).
 */

export function listLeadContacts(leadId: string, signal?: AbortSignal): Promise<Contact[]> {
  return apiRequest<Contact[]>(
    '/contacts',
    signal ? { query: { leadId }, signal } : { query: { leadId } },
  );
}

export function listLeadOpportunities(
  leadId: string,
  signal?: AbortSignal,
): Promise<Opportunity[]> {
  return apiRequest<Opportunity[]>(
    '/opportunities',
    signal ? { query: { leadId }, signal } : { query: { leadId } },
  );
}
