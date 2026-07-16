import { setupWorker } from 'msw/browser';
import { handlers } from './handlers.ts';
import { viewBuilderHandlers } from '../features/view-builder/index.ts';

/** Browser MSW worker (dev runtime). Started from main.tsx before render. */
export const worker = setupWorker(...handlers, ...viewBuilderHandlers);
