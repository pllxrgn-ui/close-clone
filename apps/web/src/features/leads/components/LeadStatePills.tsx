import type { JSX } from 'react';
import type { Lead } from '@switchboard/shared';
import { StatusPill } from '../../../ui/index.ts';
import { LEAD_STATE, deriveLeadStates } from '../lib/leadState.ts';
import type { LeadStateInput } from '../lib/leadState.ts';

/*
 * The board-state pills for a lead (new reply / overdue / DNC …), in precedence
 * order. Color is the message: each pill uses its state token via StatusPill.
 * The reply pill's dot is the lamp (glow handled in CSS, dark-theme only).
 */

interface LeadStatePillsProps {
  lead: LeadStateInput & Pick<Lead, 'id'>;
  now: Date;
  /** Cap the number of pills shown; extras collapse into a +N chip. */
  max?: number;
  className?: string;
}

export function LeadStatePills({ lead, now, max = 3, className }: LeadStatePillsProps): JSX.Element | null {
  const states = deriveLeadStates(lead, now);
  if (states.length === 0) return null;
  const shown = states.slice(0, max);
  const overflow = states.length - shown.length;
  return (
    <span className={className}>
      {shown.map((key) => {
        const meta = LEAD_STATE[key];
        return (
          <StatusPill key={key} tone={meta.tone} dot {...(meta.lamp ? { className: 'lead-pill--lamp' } : {})}>
            {meta.label}
          </StatusPill>
        );
      })}
      {overflow > 0 ? <span className="lead-statepills__more">+{overflow}</span> : null}
    </span>
  );
}
