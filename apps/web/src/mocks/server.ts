import { setupServer } from 'msw/node';
import { handlers } from './handlers.ts';

/** Node MSW server (tests). Lifecycle is wired in src/test/setup.ts. */
export const server = setupServer(...handlers);
