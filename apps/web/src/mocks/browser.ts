import { setupWorker } from 'msw/browser';
import { handlers } from './handlers.ts';
import { viewBuilderHandlers } from '../features/view-builder/index.ts';
import { leadDetailHandlers } from '../features/leads/mocks/leadHandlers.ts';
import { pipelineHandlers } from '../features/pipeline/index.ts';
import { commsHandlers } from '../features/comms/index.ts';
import { reportsHandlers } from '../features/reports/index.ts';
import { adminHandlers } from '../features/admin/index.ts';

/** Browser MSW worker (dev runtime). Started from main.tsx before render. */
export const worker = setupWorker(
  ...handlers,
  ...pipelineHandlers,
  ...adminHandlers,
  ...reportsHandlers,
  ...commsHandlers,
  ...viewBuilderHandlers,
  ...leadDetailHandlers,
);
