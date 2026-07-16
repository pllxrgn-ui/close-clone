/*
 * Public surface of the pipeline feature (S2). The app router mounts
 * `PipelineRoutePage` at /pipeline; `pipelineHandlers` extends the MSW mock with
 * the C7 opportunities list + PATCH (register BEFORE leadDetailHandlers);
 * `usePipelineCommands` feeds the command palette; `PipelineNavIcon` is the nav
 * glyph. Exact wiring is in the task's routeWiring.
 */
export { PipelineRoutePage } from './pages/routes.tsx';
export { pipelineHandlers } from './mocks/pipelineHandlers.ts';
export { usePipelineCommands } from './commands/commands.ts';
export { KanbanIcon as PipelineNavIcon } from './icons.tsx';
