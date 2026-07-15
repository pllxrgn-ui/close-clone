import type { LeadStatus, User } from '@switchboard/shared';
import { apiRequest } from './client.ts';

/*
 * Reference lookups used to render owner/status labels in lists. In the real
 * API `users` is admin-gated (C7); the mock exposes these openly and W1 treats
 * them as reference data — see the task report's contract notes.
 */
export function listUsers(): Promise<User[]> {
  return apiRequest<User[]>('/users');
}

export function listLeadStatuses(): Promise<LeadStatus[]> {
  return apiRequest<LeadStatus[]>('/lead-statuses');
}
