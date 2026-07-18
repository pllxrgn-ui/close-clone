/*
 * Public surface of the calling feature (U1 — built-in calling).
 *
 * The app-wide call provider (mounts the global call strip once), the lead-page
 * "Call" seam that replaces the disabled stub, the list-dialer route, the palette
 * command registrations, and the MSW handler array. Everything the orchestrator
 * wires at merge is exported here; the exact wiring is in the task's routeWiring.
 * No app-owned file (router / nav / shell / mocks / LeadHeader) is modified by
 * this feature — mounting happens at merge.
 */
export { CallProvider, useCall } from './context/CallProvider.tsx';
export type {
  CallSession,
  CallTarget,
  CallProviderProps,
  CallClock,
} from './context/CallProvider.tsx';
export { LeadCallLauncher } from './components/LeadCallLauncher.tsx';
export { DialerRoutePage } from './pages/routes.tsx';
export { useCallingCommands } from './commands.ts';
export { callingHandlers } from './mocks/callingHandlers.ts';
