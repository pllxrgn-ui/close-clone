/*
 * Thin typed fetch wrapper honoring CONTRACTS §C7:
 *   - base `/api/v1`, JSON, camelCase
 *   - `{error:{code,message,details?}}` → typed ApiError (C8 codes)
 *   - keyset pagination `?cursor=&limit=` → `{items, nextCursor?}`
 *
 * No response schema validation is done here — the server owns the contract and
 * shapes come straight from @switchboard/shared types. Errors ARE parsed.
 */
import { ApiError, isApiErrorCode, statusToCode, type ApiErrorBody } from './errors.ts';

export const API_BASE = '/api/v1';

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  method?: string;
  /** JSON-serialized as the request body; sets Content-Type. */
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: QueryParams): string {
  if (!query) return `${API_BASE}${path}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${API_BASE}${path}?${qs}` : `${API_BASE}${path}`;
}

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
    /* error body was not JSON — keep the status-derived defaults */
  }
  return new ApiError(code, message, res.status, details);
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
  };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (opts.signal) init.signal = opts.signal;

  const res = await fetch(buildUrl(path, opts.query), init);
  if (!res.ok) {
    throw await toApiError(res);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// ── Keyset pagination (C7) ──────────────────────────────────────────────────

/** A single keyset page: items plus an opaque cursor for the next page. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface PageParams {
  cursor?: string;
  limit?: number;
}

/** Turn keyset page params into query values (undefined keys are dropped). */
export function toPageQuery(params: PageParams): QueryParams {
  return { cursor: params.cursor, limit: params.limit };
}
