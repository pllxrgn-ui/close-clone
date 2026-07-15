import type { JSX } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider.tsx';

/**
 * Route guard: unauthenticated users are redirected to /login, preserving the
 * attempted location in router state so the login screen can send them back.
 * Rendered as a layout route whose children are the authenticated shell.
 */
export function RequireAuth(): JSX.Element {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }

  return <Outlet />;
}
