/*
 * Public surface of the Inbox feature (task S1). The orchestrator wires these at
 * merge (see the task's routeWiring):
 *   - `InboxRoutePage` replaces the placeholder at route /inbox
 *   - `inboxHandlers` is spread into the MSW worker/server handler arrays
 *   - `useInboxCommands` is spread into the ⌘K palette's command list
 * Nothing self-registers, because the router, mocks and command palette are owned
 * by the shell / other sprint tasks.
 */
export { InboxRoutePage } from './pages/routes.tsx';
export { inboxHandlers } from './mocks/inboxHandlers.ts';
export { useInboxCommands } from './commands.ts';
