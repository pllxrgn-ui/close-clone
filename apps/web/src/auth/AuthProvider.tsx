import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { User } from '@switchboard/shared';
import { readStoredUser, storeUser } from './auth.ts';

/*
 * MOCK auth surface (ARCHITECTURE §1: OIDC → dev-login stub under MOCK_MODE).
 * The signed-in user is a fixture User restored synchronously from localStorage,
 * so there is no auth "loading" flash on boot. Real OIDC replaces the innards of
 * `login`/`logout` without changing this context shape or any caller.
 */
interface AuthContextValue {
  /** The signed-in fixture user, or null when logged out. */
  user: User | null;
  /** Whether a user is currently signed in (convenience for guards). */
  isAuthenticated: boolean;
  /** Adopt a picked dev user and persist the session. */
  login: (user: User) => void;
  /** Clear the session. */
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<User | null>(() => readStoredUser());

  const login = useCallback((next: User) => {
    storeUser(next);
    setUser(next);
  }, []);

  const logout = useCallback(() => {
    storeUser(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isAuthenticated: user !== null, login, logout }),
    [user, login, logout],
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
