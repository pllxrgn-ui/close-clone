import { setupServer } from 'msw/node';
import { handlers } from './handlers.ts';
import { inboxHandlers } from '../features/inbox/index.ts';
import { viewBuilderHandlers } from '../features/view-builder/index.ts';
import { leadDetailHandlers } from '../features/leads/mocks/leadHandlers.ts';
import { pipelineHandlers } from '../features/pipeline/index.ts';
import { commsHandlers } from '../features/comms/index.ts';
import { callingHandlers } from '../features/calling/index.ts';
import { smsHandlers } from '../features/sms/index.ts';
import { aiHandlers } from '../features/ai/index.ts';
import { importHandlers } from '../features/import/index.ts';
import { reportsHandlers } from '../features/reports/index.ts';
import { adminHandlers } from '../features/admin/index.ts';

/**
 * Node MSW server (tests). Lifecycle is wired in src/test/setup.ts. Mirrors the
 * browser worker's registration order exactly (browser.ts) so tests exercise the
 * production first-match-wins order. `inboxHandlers` sits right after the core
 * `handlers` and before comms: it gets first look at its shared send/task routes
 * and falls through cooperatively (return undefined) for non-inbox requests. The
 * admin-before-comms order is preserved (the enroll collision fix depends on it).
 */
export const server = setupServer(
  ...handlers,
  ...inboxHandlers,
  ...pipelineHandlers,
  ...adminHandlers,
  ...reportsHandlers,
  ...commsHandlers,
  ...callingHandlers,
  ...smsHandlers,
  ...aiHandlers,
  ...importHandlers,
  ...viewBuilderHandlers,
  ...leadDetailHandlers,
);
