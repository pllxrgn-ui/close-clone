/*
 * Data access for the admin settings + bulk surfaces. Reuses the W1 api-client
 * (`apiRequest`, C7 envelope + C8 typed errors); adds the admin/* , templates,
 * snippets, sequences, and leads-mutation calls this feature needs. Reference
 * lookups (users, lead-statuses) are reused from api/reference.ts.
 */
import type { Lead, OrgSettings, Snippet, Template } from '@switchboard/shared';
import { apiRequest } from '../../api/client.ts';
import type {
  CreateCustomFieldInput,
  CustomFieldRow,
  EnrollResult,
  SequenceWithCount,
} from './types.ts';

// ── Bulk: leads mutation + enroll ──────────────────────────────────────────────

/** Fields a bulk action can patch on a lead. DNC changes MUST carry a reason. */
export type LeadPatch =
  { ownerId: string } | { statusId: string } | { dnc: boolean; reason: string };

/** PATCH /leads/:id — one lead field mutation (leads CRUD, C7). */
export function patchLead(id: string, patch: LeadPatch): Promise<Lead> {
  return apiRequest<Lead>(`/leads/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

/** POST /sequences/:id/enroll — bulk enroll an explicit selection (C7). */
export function enrollLeads(sequenceId: string, leadIds: readonly string[]): Promise<EnrollResult> {
  return apiRequest<EnrollResult>(`/sequences/${encodeURIComponent(sequenceId)}/enroll`, {
    method: 'POST',
    body: { leadIds: [...leadIds] },
  });
}

export function listSequences(signal?: AbortSignal): Promise<SequenceWithCount[]> {
  return apiRequest<SequenceWithCount[]>('/sequences', signal ? { signal } : {});
}

// ── Settings: custom fields ─────────────────────────────────────────────────────

export function listCustomFields(signal?: AbortSignal): Promise<CustomFieldRow[]> {
  return apiRequest<CustomFieldRow[]>('/admin/custom-fields', signal ? { signal } : {});
}

export function createCustomField(input: CreateCustomFieldInput): Promise<CustomFieldRow> {
  return apiRequest<CustomFieldRow>('/admin/custom-fields', { method: 'POST', body: input });
}

// ── Settings: templates + snippets ──────────────────────────────────────────────

export function listTemplates(signal?: AbortSignal): Promise<Template[]> {
  return apiRequest<Template[]>('/templates', signal ? { signal } : {});
}

export interface TemplatePatch {
  name?: string;
  subject?: string | null;
  body?: string;
}

export function updateTemplate(id: string, patch: TemplatePatch): Promise<Template> {
  return apiRequest<Template>(`/templates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function listSnippets(signal?: AbortSignal): Promise<Snippet[]> {
  return apiRequest<Snippet[]>('/snippets', signal ? { signal } : {});
}

export interface SnippetPatch {
  shortcut?: string;
  body?: string;
}

export function updateSnippet(id: string, patch: SnippetPatch): Promise<Snippet> {
  return apiRequest<Snippet>(`/snippets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

// ── Settings: org settings singleton ────────────────────────────────────────────

export function getOrgSettings(signal?: AbortSignal): Promise<OrgSettings> {
  return apiRequest<OrgSettings>('/admin/org-settings', signal ? { signal } : {});
}

/** Only the daily send cap is editable from the app (the rest are audit-gated). */
export function updateDailySendCap(dailySendCap: number): Promise<OrgSettings> {
  return apiRequest<OrgSettings>('/admin/org-settings', {
    method: 'PATCH',
    body: { dailySendCap },
  });
}
