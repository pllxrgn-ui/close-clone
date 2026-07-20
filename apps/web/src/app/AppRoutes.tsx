import { lazy, Suspense } from 'react';
import type { JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Spinner } from '../ui/index.ts';
import { RequireAuth } from '../auth/RequireAuth.tsx';
import { useAuth } from '../auth/AuthProvider.tsx';
import { AppShell } from './AppShell.tsx';

/*
 * Route-level code splitting: every page (and the login screen) is a lazy chunk.
 * The authenticated pages suspend inside AppShell's own <Suspense> (which keeps
 * the chrome visible); the login screen suspends against the boot fallback here.
 * Named exports are adapted to lazy()'s default-export contract.
 */
const LoginPage =
  import.meta.env.VITE_API_MODE === 'real'
    ? lazy(() =>
        import('../auth/ProductionLoginPage.tsx').then((m) => ({ default: m.ProductionLoginPage })),
      )
    : lazy(() => import('../auth/LoginPage.tsx').then((m) => ({ default: m.LoginPage })));
const InboxPage = lazy(() =>
  import('../features/inbox/pages/routes.tsx').then((m) => ({ default: m.InboxRoutePage })),
);
const OverviewPage = lazy(() =>
  import('../features/overview/OverviewPage.tsx').then((m) => ({ default: m.OverviewPage })),
);
const LeadsPage = lazy(() =>
  import('../features/leads/pages/routes.tsx').then((m) => ({ default: m.LeadsRoutePage })),
);
const LeadDetailPage = lazy(() =>
  import('../features/leads/pages/routes.tsx').then((m) => ({ default: m.LeadDetailRoutePage })),
);
const ViewsPage = lazy(() =>
  import('../pages/ViewsPage.tsx').then((m) => ({ default: m.ViewsPage })),
);
const ViewDetailPage = lazy(() =>
  import('../features/leads/pages/routes.tsx').then((m) => ({ default: m.ViewRoutePage })),
);
const ViewBuilderPage = lazy(() =>
  import('../features/view-builder/ViewBuilderPage.tsx').then((m) => ({
    default: m.ViewBuilderPage,
  })),
);
const PipelinePage = lazy(() =>
  import('../features/pipeline/pages/routes.tsx').then((m) => ({ default: m.PipelineRoutePage })),
);
const SequencesPage = lazy(() =>
  import('../features/comms/pages/routes.tsx').then((m) => ({ default: m.SequencesRoutePage })),
);
const SequenceDetailPage = lazy(() =>
  import('../features/comms/pages/routes.tsx').then((m) => ({
    default: m.SequenceDetailRoutePage,
  })),
);
const ReportsPageReal = lazy(() =>
  import('../features/reports/pages/routes.tsx').then((m) => ({ default: m.ReportsRoutePage })),
);
const SettingsPageReal = lazy(() =>
  import('../features/admin/settings/AdminSettingsPage.tsx').then((m) => ({
    default: m.AdminSettingsPage,
  })),
);
const DialerPage = lazy(() =>
  import('../features/calling/pages/routes.tsx').then((m) => ({ default: m.DialerRoutePage })),
);
const ImportPage = lazy(() =>
  import('../features/import/pages/routes.tsx').then((m) => ({ default: m.ImportRoutePage })),
);
const WelcomePage = lazy(() =>
  import('../features/welcome/WelcomePage.tsx').then((m) => ({ default: m.WelcomePage })),
);
const HelpPage = lazy(() => import('../pages/HelpPage.tsx').then((m) => ({ default: m.HelpPage })));
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

/**
 * Bare `/` is the front door: visitors (signed out) get the Welcome landing;
 * signed-in reps skip the marketing and land in their inbox. Deep links are
 * unaffected — RequireAuth still sends them through /login with a return path.
 */
function RootGate(): JSX.Element {
  const { user, isLoading } = useAuth();
  if (isLoading) return <BootFallback />;
  return <Navigate to={user ? '/overview' : '/welcome'} replace />;
}

export function AppRoutes(): JSX.Element {
  return (
    <Suspense fallback={<BootFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/" element={<RootGate />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route path="overview" element={<OverviewPage />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="leads" element={<LeadsPage />} />
            <Route path="leads/:id" element={<LeadDetailPage />} />
            <Route path="views" element={<ViewsPage />} />
            <Route path="pipeline" element={<PipelinePage />} />
            <Route path="sequences" element={<SequencesPage />} />
            <Route path="sequences/:id" element={<SequenceDetailPage />} />
            <Route path="views/new" element={<ViewBuilderPage />} />
            <Route path="views/:id" element={<ViewDetailPage />} />
            <Route path="views/:id/edit" element={<ViewBuilderPage />} />
            <Route path="reports" element={<ReportsPageReal />} />
            <Route path="help" element={<HelpPage />} />
            <Route path="settings" element={<SettingsPageReal />} />
            <Route path="dialer" element={<DialerPage />} />
            <Route path="import" element={<ImportPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
