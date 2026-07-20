import type { JSX } from 'react';
import { Navigate } from 'react-router-dom';
import { Spinner } from '../ui/index.ts';
import { useAuth } from './AuthProvider.tsx';
import { SsoLoginPage } from './SsoLoginPage.tsx';

/** Production-only login route. It never imports the local demo account picker. */
export function ProductionLoginPage(): JSX.Element {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <Spinner size="lg" label="Checking your session" />;
  if (isAuthenticated) return <Navigate to="/overview" replace />;
  return <SsoLoginPage />;
}
