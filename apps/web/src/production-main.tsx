import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './ui/primitives.css';
import './app/shell.css';
import './styles/overlays.css';
import App from './App.tsx';
import { ErrorBoundary } from './app/ErrorBoundary.tsx';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
