import type { JSX } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Button, Spinner } from '../ui/index.ts';
import { useAuth } from './AuthProvider.tsx';

/**
 * Route guard: unauthenticated users are redirected to /login, preserving the
 * attempted location in router state so the login screen can send them back.
 * Rendered as a layout route whose children are the authenticated shell.
 */
export function RequireAuth(): JSX.Element {
  const { isAuthenticated, isLoading, error, refresh } = useAuth();
  const location = useLocation();

  if (isLoading) return <Spinner size="lg" label="Checking your session" />;

  if (error !== null) {
    return (
      <main className="sb-login">
        <div className="sb-login__card">
          <h1 className="sb-login__title">Session check failed</h1>
          <p role="alert" className="sb-login__error">
            {error}
          </p>
          <Button onClick={() => void refresh()}>Try again</Button>
        </div>
      </main>
    );
  }

  if (!isAuthenticated) {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }

  return <Outlet />;
}
