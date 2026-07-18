import { setupWorker } from 'msw/browser';
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
 * Browser MSW worker (dev runtime). Started from main.tsx before render.
 *
 * Order is first-match-wins. `inboxHandlers` is spread early — right after the
 * core `handlers` and before comms — so the inbox gets first look at the routes
 * it shares with the comms composer (POST /emails/send, /sms/send) and core
 * (PATCH /tasks/:id). Its handlers are cooperative: they own a request only when
 * it targets an inbox-store item and otherwise return undefined to fall through,
 * so the comms composer + core still answer their own sends. The admin-before-comms
 * order is preserved (the enroll collision fix depends on it).
 */
export const worker = setupWorker(
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
