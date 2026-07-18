/*
 * Typed REST wrappers for the CSV import flow (CONTRACTS §C7): the multipart
 * upload → dry-run → commit sequence the real apps/api/src/routes/imports.ts
 * serves. The upload is a raw `fetch` with a FormData body (the shared apiRequest
 * client forces JSON), but it parses the same C8 `{error:{code,message,details?}}`
 * envelope into an ApiError; dry-run + commit go through apiRequest unchanged.
 * The custom-field list is read from the admin surface (`GET /admin/custom-fields`)
 * so the Map step offers the same typed lead fields the server validates against.
 */
import { apiRequest, API_BASE } from '../../../api/client.ts';
import { ApiError, isApiErrorCode, statusToCode, type ApiErrorBody } from '../../../api/errors.ts';
import { readFileText } from '../lib/file.ts';
import type { CommitResponse, DryRunRequest, DryRunResponse, ImportResource } from '../types.ts';

/** A lead custom field offered as a mapping target (subset of admin's row). */
export interface LeadCustomField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'user';
  options: readonly string[] | null;
}

interface AdminCustomFieldRow {
  entity: 'lead' | 'contact' | 'opportunity';
  key: string;
  label: string;
  type: LeadCustomField['type'];
  options: readonly string[] | null;
}

/** Max upload the wizard accepts client-side (the server enforces its own cap). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

async function toApiError(res: Response): Promise<ApiError> {
  let code = statusToCode(res.status);
  let message = res.statusText || `Request failed with status ${res.status}`;
  let details: unknown;
  try {
    const body: unknown = await res.json();
    const err = (body as Partial<ApiErrorBody> | null)?.error;
    if (err && typeof err === 'object') {
      if (isApiErrorCode(err.code)) code = err.code;
      if (typeof err.message === 'string' && err.message.length > 0) message = err.message;
      details = err.details;
    }
  } catch {
    /* non-JSON error body — keep the status-derived defaults */
  }
  return new ApiError(code, message, res.status, details);
}

/**
 * POST /imports — upload a CSV as multipart/form-data; returns the created row.
 * The body is hand-built (a single `file` part) rather than via `FormData` so the
 * request carries a plain string body: the real server's streaming multipart
 * parser reads it identically, and it sidesteps the jsdom/undici FormData-body
 * hang MSW exhibits under test. CSV is text, so reading the File as text is safe.
 */
export async function uploadImport(file: File): Promise<ImportResource> {
  const text = await readFileText(file);
  const boundary = `----switchboard-import-${crypto.randomUUID()}`;
  const safeName = (file.name.length > 0 ? file.name : 'import.csv').replace(/["\r\n]/g, '');
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${text}\r\n` +
    `--${boundary}--\r\n`;
  const res = await fetch(`${API_BASE}/imports`, {
    method: 'POST',
    body,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as ImportResource;
}

/** POST /imports/:id/dry-run — plan the mapping against the DB, no writes. */
export function dryRunImport(id: string, body: DryRunRequest): Promise<DryRunResponse> {
  return apiRequest<DryRunResponse>(`/imports/${encodeURIComponent(id)}/dry-run`, {
    method: 'POST',
    body,
  });
}

/** POST /imports/:id/commit — transactional, idempotent apply. */
export function commitImport(id: string): Promise<CommitResponse> {
  return apiRequest<CommitResponse>(`/imports/${encodeURIComponent(id)}/commit`, {
    method: 'POST',
  });
}

/** Lead custom fields available as mapping targets (from the admin surface). */
export async function listLeadCustomFields(signal?: AbortSignal): Promise<LeadCustomField[]> {
  const rows = await apiRequest<AdminCustomFieldRow[]>(
    '/admin/custom-fields',
    signal ? { signal } : {},
  );
  return rows
    .filter((r) => r.entity === 'lead')
    .map((r) => ({ key: r.key, label: r.label, type: r.type, options: r.options }));
}
