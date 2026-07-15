/*
 * Request/response DTOs specific to the web client's REST calls (C7). Domain
 * entity shapes come from @switchboard/shared and are never redeclared here.
 */
import type { Lead } from '@switchboard/shared';
import type { PageParams } from './client.ts';

export interface LeadsListParams extends PageParams {
  statusId?: string;
  ownerId?: string;
}

// ── Global search (GET /search?q=) ──────────────────────────────────────────
export const SEARCH_HIT_KINDS = ['lead', 'contact', 'opportunity'] as const;
export type SearchHitKind = (typeof SEARCH_HIT_KINDS)[number];

export interface SearchHit {
  kind: SearchHitKind;
  id: string;
  /** The lead this hit routes to (a contact/opportunity resolves to its lead). */
  leadId: string;
  title: string;
  subtitle?: string;
}

export interface SearchResponse {
  items: SearchHit[];
}

// ── Smart views (POST /smart-views/preview, CRUD) ───────────────────────────
export interface SmartViewPreviewRequest {
  dsl?: string;
  ast?: unknown;
  cursor?: string;
  limit?: number;
}

export interface SmartViewPreviewResponse {
  items: Lead[];
  nextCursor?: string;
  /** Approximate total matching the view (C7: "count-estimate"). */
  countEstimate: number;
}

export interface SmartViewCreate {
  name: string;
  dsl: string;
  shared?: boolean;
  sort?: unknown;
  columns?: unknown;
}

export interface SmartViewUpdate {
  name?: string;
  dsl?: string;
  shared?: boolean;
  sort?: unknown;
  columns?: unknown;
}
