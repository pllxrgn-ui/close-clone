import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './ui/primitives.css';
import './app/shell.css';
import './styles/overlays.css';
import App from './App.tsx';
import { ErrorBoundary } from './app/ErrorBoundary.tsx';

/*
 * API mode (VITE_API_MODE): "real" talks to the local API through the Vite /api
 * proxy (see vite.config.ts) and never loads the MSW chunk; anything else (the
 * default) backs the REST surface with the MSW worker + fixtures (C7 shapes).
 */
async function enableMocking(): Promise<void> {
  if (import.meta.env.VITE_API_MODE === 'real') return;
  const { worker } = await import('./mocks/browser.ts');
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
  // Blank workspace: persist the user-owned core on a heartbeat + tab-hide so
  // typed-in leads and CSV imports survive reloads on this device. No-op in
  // sample mode; started here (never at module scope — tests import the mocks).
  const [{ startWorkspacePersistence }, { snapshotDb }] = await Promise.all([
    import('./mocks/workspace.ts'),
    import('./mocks/fixtures.ts'),
  ]);
  startWorkspacePersistence(snapshotDb);
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

// A failed mock-worker start (stale service worker mid-deploy, private mode)
// must not leave a blank page: render anyway — the C8 error states cover a dead
// API far better than nothing at all.
function renderApp(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

if (import.meta.env.VITE_API_MODE === 'real') {
  renderApp(rootElement);
} else {
  void enableMocking()
    .catch((err: unknown) => console.error('[sb] mock worker failed to start', err))
    .then(() => renderApp(rootElement));
}
