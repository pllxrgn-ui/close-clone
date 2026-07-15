import { setupWorker } from 'msw/browser';
import { handlers } from './handlers.ts';

/** Browser MSW worker (dev runtime). Started from main.tsx before render. */
export const worker = setupWorker(...handlers);
