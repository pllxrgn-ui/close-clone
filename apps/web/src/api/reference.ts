import type { LeadStatus, OpportunityStage, User } from '@switchboard/shared';
import { apiRequest } from './client.ts';

/*
 * Reference lookups used to render owner/status labels in lists. In the real
 * API `users` is admin-gated (C7); the mock exposes these openly and W1 treats
 * them as reference data — see the task report's contract notes.
 * Consume these through refQueries.ts so every feature shares ONE cache entry
 * per resource (audit #4: four divergent keys used to fetch /users 4×).
 */
export function listUsers(): Promise<User[]> {
  return apiRequest<User[]>('/users');
}

export function listLeadStatuses(): Promise<LeadStatus[]> {
  return apiRequest<LeadStatus[]>('/lead-statuses');
}

export function listOpportunityStages(): Promise<OpportunityStage[]> {
  return apiRequest<OpportunityStage[]>('/opportunity-stages');
}
