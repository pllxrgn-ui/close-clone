import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './ui/primitives.css';
import './app/shell.css';
import App from './App.tsx';

/*
 * This is a communication-first CRM running fully in MOCK_MODE for now: there is
 * no real backend, so the MSW worker always backs the REST surface (C7 shapes).
 * When a real API lands, gate this on an env flag.
 */
async function enableMocking(): Promise<void> {
  const { worker } = await import('./mocks/browser.ts');
  await worker.start({ onUnhandledRequest: 'bypass' });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

void enableMocking().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
