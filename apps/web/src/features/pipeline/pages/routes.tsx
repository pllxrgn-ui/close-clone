import type { JSX } from 'react';
import { PipelineBoard } from '../components/PipelineBoard.tsx';
import '../pipeline.css';

/*
 * Route entry for the pipeline surface. Exported from the feature dir so the app
 * router mounts it without importing internals — see this feature's routeWiring
 * for the exact wiring at /pipeline.
 */
export function PipelineRoutePage(): JSX.Element {
  return <PipelineBoard />;
}
