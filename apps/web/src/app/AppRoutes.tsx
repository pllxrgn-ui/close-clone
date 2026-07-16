import { lazy, Suspense } from 'react';
import type { JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spinner } from '../ui/index.ts';
import { RequireAuth } from '../auth/RequireAuth.tsx';
import { AppShell } from './AppShell.tsx';

/*
 * Route-level code splitting: every page (and the login screen) is a lazy chunk.
 * The authenticated pages suspend inside AppShell's own <Suspense> (which keeps
 * the chrome visible); the login screen suspends against the boot fallback here.
 * Named exports are adapted to lazy()'s default-export contract.
 */
const LoginPage = lazy(() =>
  import('../auth/LoginPage.tsx').then((m) => ({ default: m.LoginPage })),
);
const InboxPage = lazy(() =>
  import('../pages/InboxPage.tsx').then((m) => ({ default: m.InboxPage })),
);
const LeadsPage = lazy(() =>
  import('../features/leads/index.ts').then((m) => ({ default: m.LeadsRoutePage })),
);
const LeadDetailPage = lazy(() =>
  import('../features/leads/index.ts').then((m) => ({ default: m.LeadDetailRoutePage })),
);
const ViewsPage = lazy(() =>
  import('../pages/ViewsPage.tsx').then((m) => ({ default: m.ViewsPage })),
);
const ViewDetailPage = lazy(() =>
  import('../features/leads/index.ts').then((m) => ({ default: m.ViewRoutePage })),
);
const ViewBuilderPage = lazy(() =>
  import('../features/view-builder/index.ts').then((m) => ({ default: m.ViewBuilderPage })),
);
const WelcomePage = lazy(() =>
  import('../features/welcome/index.ts').then((m) => ({ default: m.WelcomePage })),
);
const ReportsPage = lazy(() =>
  import('../pages/ReportsPage.tsx').then((m) => ({ default: m.ReportsPage })),
);
const SettingsPage = lazy(() =>
  import('../pages/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage })),
);
const NotFoundPage = lazy(() =>
  import('../pages/NotFoundPage.tsx').then((m) => ({ default: m.NotFoundPage })),
);

function BootFallback(): JSX.Element {
  return (
    <div className="sb-boot">
      <Spinner size="lg" label="Loading Switchboard" />
    </div>
  );
}

export function AppRoutes(): JSX.Element {
  return (
    <Suspense fallback={<BootFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/" element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/inbox" replace />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="leads" element={<LeadsPage />} />
            <Route path="leads/:id" element={<LeadDetailPage />} />
            <Route path="views" element={<ViewsPage />} />
            <Route path="views/new" element={<ViewBuilderPage />} />
            <Route path="views/:id" element={<ViewDetailPage />} />
            <Route path="views/:id/edit" element={<ViewBuilderPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
