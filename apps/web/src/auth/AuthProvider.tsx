import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { User } from '@switchboard/shared';
import { apiRequest } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import { readStoredUser, storeUser } from './auth.ts';

/*
 * MOCK auth surface (ARCHITECTURE §1: OIDC → dev-login stub under MOCK_MODE).
 * The signed-in user is a fixture User restored synchronously from localStorage,
 * so there is no auth "loading" flash on boot. Real OIDC replaces the innards of
 * `login`/`logout` without changing this context shape or any caller.
 */
interface AuthContextValue {
  /** The signed-in user, or null when logged out. */
  user: User | null;
  /** Real mode checks the server cookie before routing protected pages. */
  isLoading: boolean;
  /** A non-authentication failure while restoring the server session. */
  error: string | null;
  /** Whether a user is currently signed in (convenience for guards). */
  isAuthenticated: boolean;
  /** Adopt a picked dev user and persist the session. */
  login: (user: User) => void;
  /** Clear the session. */
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const realMode = import.meta.env.VITE_API_MODE === 'real';
  const [user, setUser] = useState<User | null>(() => (realMode ? null : readStoredUser()));
  const [isLoading, setIsLoading] = useState(realMode);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!realMode) return;
    setIsLoading(true);
    setError(null);
    try {
      setUser(await apiRequest<User>('/auth/me'));
    } catch (err) {
      setUser(null);
      if (!(err instanceof ApiError && err.code === 'UNAUTHENTICATED')) {
        setError(err instanceof Error ? err.message : 'Unable to verify your session');
      }
    } finally {
      setIsLoading(false);
    }
  }, [realMode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    (next: User) => {
      if (!realMode) storeUser(next);
      setUser(next);
    },
    [realMode],
  );

  const logout = useCallback(async () => {
    if (realMode) {
      try {
        await apiRequest<{ ok: true }>('/auth/logout', { method: 'POST' });
      } finally {
        setUser(null);
      }
      return;
    }
    storeUser(null);
    setUser(null);
  }, [realMode]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isAuthenticated: user !== null, isLoading, error, login, logout, refresh }),
    [user, isLoading, error, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
