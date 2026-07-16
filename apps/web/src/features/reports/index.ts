/*
 * Public surface of the reports feature (S4). The app router mounts
 * `ReportsRoutePage` at /reports; the mocks layer spreads `reportsHandlers` into
 * the MSW worker/server; the command palette composes `useReportsCommands`.
 * See the task's routeWiring for the exact merge wiring.
 */
export { ReportsRoutePage } from './pages/routes.tsx';
export { ReportsSurface } from './components/ReportsSurface.tsx';
export { reportsHandlers } from './mocks/reportsHandlers.ts';
export { useReportsCommands } from './commands.ts';
