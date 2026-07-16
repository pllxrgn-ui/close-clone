/*
 * Public surface of the Smart View builder feature (task W4).
 *
 * The orchestrator wires `ViewBuilderPage` into the router and spreads
 * `viewBuilderHandlers` into the MSW handler list at merge (see routeWiring);
 * nothing here self-registers, because the router config and mocks/ directory
 * are owned by other sprint tasks.
 */
export { ViewBuilderPage } from './ViewBuilderPage.tsx';
export { viewBuilderHandlers, MOCK_CUSTOM_FIELDS } from './mockHandlers.ts';
export type { AdminCustomField } from './api.ts';
