/*
 * MOCK auth store (ARCHITECTURE §: OIDC → dev-login stub under MOCK_MODE). The
 * signed-in user is a fixture User persisted to localStorage — there is no
 * password and no token. Real OIDC replaces this behind the same AuthProvider
 * surface without touching callers.
 */
import type { User } from '@switchboard/shared';

export const AUTH_STORAGE_KEY = 'sb-auth-user';

function isUser(value: unknown): value is User {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.email === 'string' && typeof v.name === 'string';
}

export function readStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isUser(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function storeUser(user: User | null): void {
  try {
    if (user) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  } catch {
    /* ignore persistence failures */
  }
}
