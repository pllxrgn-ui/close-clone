/*
 * Public surface of the AI feature (U3 — AI affordances).
 *
 * Everything the orchestrator wires at merge is exported here; no app-owned file
 * (router/nav/mocks/ui/composer) is modified by this feature — mounting happens at
 * merge (see the task's routeWiring):
 *   - AiProvider / useAi: app-shell mount for the NL→Smart View modal + its opener
 *   - useAiCommands: palette command ("AI Smart View…")
 *   - AiDraftControl: composer seam ("Draft with AI" / "Rewrite")
 *   - LeadCallSummaries: lead-page seam (Summarize → confirm → timeline)
 *   - AiSmartViewModal: the modal itself (also usable from a builder button)
 *   - aiHandlers: MSW handler array (spread into the worker/server list)
 */
export { AiProvider, useAi } from './context/AiProvider.tsx';
export { useAiCommands } from './commands.ts';
export { AiDraftControl, type AiDraftControlProps } from './components/AiDraftControl.tsx';
export { LeadCallSummaries } from './components/LeadCallSummaries.tsx';
export { AiSmartViewModal, type AiSmartViewModalProps } from './components/AiSmartViewModal.tsx';
export { aiHandlers } from './mocks/aiHandlers.ts';
