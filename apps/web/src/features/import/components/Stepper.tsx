import type { JSX } from 'react';
import { DoneIcon } from '../icons.tsx';

/*
 * Wizard progress rail. The import is a real ordered sequence, so numbered
 * markers (01–04) are honest structure, not decoration. Completed steps are
 * buttons that step back; the current step carries aria-current; nothing
 * animates (a keyboard-reachable control seen constantly — DESIGN §4).
 */
export const WIZARD_STEPS = ['upload', 'map', 'preview', 'commit'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

const META: Record<WizardStep, { label: string; n: string }> = {
  upload: { label: 'Upload', n: '01' },
  map: { label: 'Map', n: '02' },
  preview: { label: 'Preview', n: '03' },
  commit: { label: 'Done', n: '04' },
};

export interface StepperProps {
  current: WizardStep;
  /** Jump back to an earlier, completed step. */
  onGoTo: (step: WizardStep) => void;
  /** When true (post-commit), the flow is terminal — no back navigation. */
  locked?: boolean;
}

export function Stepper({ current, onGoTo, locked = false }: StepperProps): JSX.Element {
  const currentIdx = WIZARD_STEPS.indexOf(current);
  return (
    <nav aria-label="Import steps" className="imp-stepper">
      <ol className="imp-stepper__list">
        {WIZARD_STEPS.map((step, i) => {
          const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'upcoming';
          const canGoBack = !locked && i < currentIdx;
          const inner = (
            <>
              <span className="imp-step__marker" aria-hidden="true">
                {state === 'done' ? <DoneIcon size={16} /> : META[step].n}
              </span>
              <span className="imp-step__label">{META[step].label}</span>
            </>
          );
          return (
            <li key={step} className="imp-step" data-state={state}>
              {canGoBack ? (
                <button
                  type="button"
                  className="imp-step__body imp-step__body--btn"
                  onClick={() => onGoTo(step)}
                >
                  {inner}
                </button>
              ) : (
                <span
                  className="imp-step__body"
                  {...(state === 'current' ? { 'aria-current': 'step' } : {})}
                >
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
