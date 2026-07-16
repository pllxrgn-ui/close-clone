/*
 * Public surface of the comms feature (S3 — communication surfaces).
 *
 * Route components, the composer provider + lead-page launcher, the palette
 * command registrations, and the MSW handler array. Everything the orchestrator
 * needs to wire at merge is exported here; the exact wiring is in the task's
 * routeWiring. No app-owned file (router/nav/mocks/ui/styles) is modified by this
 * feature — mounting happens at merge.
 */
export { SequencesRoutePage, SequenceDetailRoutePage } from './pages/routes.tsx';
export { CommsProvider, useComms } from './context/CommsProvider.tsx';
export { LeadComposerLauncher } from './components/LeadComposerLauncher.tsx';
export { Composer } from './components/Composer.tsx';
export { useCommsCommands } from './commands.ts';
export { commsHandlers } from './mocks/commsHandlers.ts';
