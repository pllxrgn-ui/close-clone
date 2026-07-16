/*
 * Typed API errors (CONTRACTS §C8). The server speaks `{error:{code,message,
 * details?}}`; the client turns any non-2xx response into an {@link ApiError}
 * whose `code` is one of the C8 union members. These codes are a REST-surface
 * contract (not a domain type), so they are declared here rather than imported
 * from @switchboard/shared.
 */

export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'SUPPRESSED',
  'OUTSIDE_WINDOW',
  'CAP_EXCEEDED',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'SYNC_REAUTH_REQUIRED',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

/** Shape of the JSON error body defined by C7. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/** Fallback status→code map for error bodies that omit/garble the code. */
export function statusToCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 502:
      return 'PROVIDER_ERROR';
    default:
      return 'INTERNAL';
  }
}
