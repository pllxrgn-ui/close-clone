import type { JSX } from 'react';
import type { SequenceStep } from '@switchboard/shared';
import { StatusPill } from '../../../ui/index.ts';
import { channelLabel, formatDelay } from '../lib/format.ts';
import {
  ClockIcon,
  MailIcon,
  MessageIcon,
  PhoneIcon,
  ShieldCheckIcon,
  TemplateIcon,
} from '../icons.tsx';

/*
 * The sequence step ladder — a vertical rail diagram in Operator Grid style. Each
 * step is a node on the seq-colored rail carrying its delay, channel, template,
 * and a "needs review" flag (the human-in-the-loop gate before an AI/auto step
 * sends). Semantic <ol> so the ordering is conveyed to assistive tech.
 */

function channelIcon(type: SequenceStep['type']): (p: { size?: number }) => JSX.Element {
  switch (type) {
    case 'email':
      return MailIcon;
    case 'call_task':
      return PhoneIcon;
    case 'sms':
      return MessageIcon;
  }
}

export function StepLadder({
  steps,
  templateName,
}: {
  steps: SequenceStep[];
  templateName: (templateId: string | null) => string | null;
}): JSX.Element {
  return (
    <ol className="ladder" aria-label="Sequence steps">
      {steps.map((step, i) => {
        const Icon = channelIcon(step.type);
        const tmpl = templateName(step.templateId);
        return (
          <li key={step.id} className="ladder__step">
            <div className="ladder__rail" aria-hidden="true">
              <span className="ladder__node" />
              {i < steps.length - 1 ? <span className="ladder__line" /> : null}
            </div>
            <div className="ladder__body">
              <div className="ladder__delay">
                <ClockIcon size={13} />
                <span className="ladder__delay-text">
                  {step.delayHours <= 0 ? 'Immediately' : `Wait ${formatDelay(step.delayHours)}`}
                </span>
                <span className="ladder__stepno">Step {i + 1}</span>
              </div>
              <div className="ladder__card">
                <span className="ladder__channel">
                  <Icon size={15} />
                  {channelLabel(step.type)}
                </span>
                {tmpl ? (
                  <span className="ladder__template">
                    <TemplateIcon size={13} />
                    {tmpl}
                  </span>
                ) : step.type === 'call_task' ? (
                  <span className="ladder__template ladder__template--muted">Manual call task</span>
                ) : null}
                {step.requiresReview ? (
                  <StatusPill tone="draft" dot>
                    Needs review
                  </StatusPill>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Small inline legend note used near the ladder to explain the review flag. */
export function ReviewNote(): JSX.Element {
  return (
    <p className="ladder__note">
      <ShieldCheckIcon size={13} /> Steps marked <strong>Needs review</strong> pause for a rep to
      approve before anything sends.
    </p>
  );
}
