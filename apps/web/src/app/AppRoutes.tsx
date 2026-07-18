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
  import('../features/inbox/index.ts').then((m) => ({ default: m.InboxRoutePage })),
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
const PipelinePage = lazy(() =>
  import('../features/pipeline/index.ts').then((m) => ({ default: m.PipelineRoutePage })),
);
const SequencesPage = lazy(() =>
  import('../features/comms/index.ts').then((m) => ({ default: m.SequencesRoutePage })),
);
const SequenceDetailPage = lazy(() =>
  import('../features/comms/index.ts').then((m) => ({ default: m.SequenceDetailRoutePage })),
);
const ReportsPageReal = lazy(() =>
  import('../features/reports/index.ts').then((m) => ({ default: m.ReportsRoutePage })),
);
const SettingsPageReal = lazy(() =>
  import('../features/admin/index.ts').then((m) => ({ default: m.AdminSettingsPage })),
);
const DialerPage = lazy(() =>
  import('../features/calling/index.ts').then((m) => ({ default: m.DialerRoutePage })),
);
const ImportPage = lazy(() =>
  import('../features/import/index.ts').then((m) => ({ default: m.ImportRoutePage })),
);
const WelcomePage = lazy(() =>
  import('../features/welcome/index.ts').then((m) => ({ default: m.WelcomePage })),
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
