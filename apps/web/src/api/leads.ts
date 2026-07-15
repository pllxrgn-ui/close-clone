import type { Activity, Lead } from '@switchboard/shared';
import { apiRequest, toPageQuery, type Page, type PageParams } from './client.ts';
import type { LeadsListParams } from './types.ts';

export function listLeads(params: LeadsListParams = {}): Promise<Page<Lead>> {
  return apiRequest<Page<Lead>>('/leads', {
    query: { ...toPageQuery(params), statusId: params.statusId, ownerId: params.ownerId },
  });
}

export function getLead(id: string): Promise<Lead> {
  return apiRequest<Lead>(`/leads/${encodeURIComponent(id)}`);
}

/** GET /leads/:id/timeline — keyset page of C4 activity events (newest first). */
export function getLeadTimeline(id: string, params: PageParams = {}): Promise<Page<Activity>> {
  return apiRequest<Page<Activity>>(`/leads/${encodeURIComponent(id)}/timeline`, {
    query: toPageQuery(params),
  });
}
