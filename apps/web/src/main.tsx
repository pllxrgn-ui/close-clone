import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './ui/primitives.css';
import './app/shell.css';
import './styles/overlays.css';
import App from './App.tsx';

/*
 * API mode (VITE_API_MODE): "real" talks to the local API through the Vite /api
 * proxy (see vite.config.ts) and never loads the MSW chunk; anything else (the
 * default) backs the REST surface with the MSW worker + fixtures (C7 shapes).
 */
async function enableMocking(): Promise<void> {
  if (import.meta.env.VITE_API_MODE === 'real') return;
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
