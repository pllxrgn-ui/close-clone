import type { JSX } from 'react';
import { WORKFLOW_STORY } from './copy.ts';
import { useReveal } from './useReveal.ts';

export function WorkflowStory(): JSX.Element {
  const ref = useReveal<HTMLElement>({ itemSelector: '.sb-welcome__workflow-step' });

  return (
    <section
      ref={ref}
      id="welcome-workflow"
      className="sb-welcome__workflow"
      aria-labelledby="welcome-workflow-title"
    >
      <div className="sb-welcome__workflow-intro">
        <p className="sb-welcome__eyebrow">{WORKFLOW_STORY.label}</p>
        <h2 id="welcome-workflow-title" className="sb-welcome__workflow-title">
          {WORKFLOW_STORY.title}
        </h2>
        <p className="sb-welcome__workflow-sub">{WORKFLOW_STORY.sub}</p>
      </div>
      <ol className="sb-welcome__workflow-steps">
        {WORKFLOW_STORY.steps.map((step) => (
          <li key={step.number} className="sb-welcome__workflow-step">
            <span className="sb-welcome__workflow-number">{step.number}</span>
            <div className="sb-welcome__workflow-copy">
              <h3 className="sb-welcome__workflow-step-title">{step.title}</h3>
              <p className="sb-welcome__workflow-body">{step.body}</p>
              <p className="sb-welcome__workflow-meta sb-welcome__mono">{step.meta}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
