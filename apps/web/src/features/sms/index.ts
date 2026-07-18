/*
 * Public surface of the two-way SMS feature (U2).
 *
 * The app-mount provider + hook, the lead-page seam launcher, the palette command
 * registration, and the MSW handler array. Everything the orchestrator wires at
 * merge is exported here; the exact wiring is in the task's routeWiring. No app-owned
 * file (router/nav/shell/LeadHeader/mocks) is modified by this feature.
 */
export { SmsProvider, useSms } from './context/SmsProvider.tsx';
export { LeadSmsLauncher } from './components/LeadSmsLauncher.tsx';
export { SmsConversationDrawer } from './components/SmsConversationDrawer.tsx';
export { useSmsCommands } from './commands.ts';
export { smsHandlers } from './mocks/smsHandlers.ts';
