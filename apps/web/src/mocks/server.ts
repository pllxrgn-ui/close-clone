import { setupServer } from 'msw/node';
import { handlers } from './handlers.ts';
import { viewBuilderHandlers } from '../features/view-builder/index.ts';
import { leadDetailHandlers } from '../features/leads/mocks/leadHandlers.ts';
import { pipelineHandlers } from '../features/pipeline/index.ts';
import { commsHandlers } from '../features/comms/index.ts';
import { reportsHandlers } from '../features/reports/index.ts';
import { adminHandlers } from '../features/admin/index.ts';

/** Node MSW server (tests). Lifecycle is wired in src/test/setup.ts. */
export const server = setupServer(
  ...handlers,
  ...pipelineHandlers,
  ...adminHandlers,
  ...reportsHandlers,
  ...commsHandlers,
  ...viewBuilderHandlers,
  ...leadDetailHandlers,
);
