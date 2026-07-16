/*
 * Public surface of the admin feature (S5 — bulk actions + settings).
 *
 * The orchestrator wires these at merge (see the task report's routeWiring):
 *   - `AdminSettingsPage` replaces the `/settings` placeholder (swap the lazy
 *     import in app/AppRoutes.tsx; the existing `path="settings"` is unchanged —
 *     sections are addressed by `?section=`),
 *   - `adminHandlers` is spread into the MSW handler lists (browser.ts + server.ts)
 *     BEFORE `viewBuilderHandlers` so the create-aware GET /admin/custom-fields
 *     supersedes the static one,
 *   - `useAdminCommands` is composed into the command palette's static commands,
 *   - `LeadBulkActions` replaces the leads bulk bar's Phase-4 disabled placeholders
 *     (the leads feature threads its current selection in as `selectedLeads`).
 *
 * Nothing here self-registers — the router, mocks/ directory, and command palette
 * are owned by other tasks and edited only at merge.
 */
export { AdminSettingsPage } from './settings/AdminSettingsPage.tsx';
export { SETTINGS_SECTIONS } from './settings/SettingsNav.tsx';
export { adminHandlers } from './mocks/adminHandlers.ts';
export { resetAdminStore } from './mocks/adminStore.ts';
export { useAdminCommands } from './commands.ts';

// Bulk-action seam for the leads board's multi-select bar.
export { LeadBulkActions, type LeadBulkActionsProps } from './bulk/LeadBulkActions.tsx';
export { useBulkActions, type BulkActionsApi } from './bulk/useBulkActions.ts';
export { leadsToCsv, downloadCsv, csvFilename, type CsvLabelCtx } from './bulk/csv.ts';
