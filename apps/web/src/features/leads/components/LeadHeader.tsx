import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { Lead } from '@switchboard/shared';
import { Button, StatusPill } from '../../../ui/index.ts';
import type { StatusTone } from '../../../ui/index.ts';
import { initials } from '../../../lib/format.ts';
import {
  ArrowLeftIcon,
  BranchIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  MailIcon,
  MessageIcon,
  PhoneIcon,
} from '../icons.tsx';

/*
 * Lead-page header: identity + status + owner + a prominent DNC indicator, then a
 * next-action bar. The action bar is a placeholder — every button is a disabled
 * Phase-4 stub (the call/email/sms/task/sequence rails, all C6-gated, land later);
 * nothing here can send, dial, or bypass a compliance rail.
 */

interface LeadHeaderProps {
  lead: Lead;
  statusLabel: string;
  ownerName: string;
}

function statusTone(label: string): StatusTone {
  if (label === 'Won') return 'won';
  if (label === 'Lost') return 'lost';
  return 'neutral';
}

const NEXT_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  icon: (p: { size?: number }) => JSX.Element;
}> = [
  { id: 'call', label: 'Call', icon: PhoneIcon },
  { id: 'email', label: 'Email', icon: MailIcon },
  { id: 'sms', label: 'SMS', icon: MessageIcon },
  { id: 'task', label: 'Task', icon: CircleDashedIcon },
  { id: 'sequence', label: 'Enroll', icon: BranchIcon },
];

export function LeadHeader({ lead, statusLabel, ownerName }: LeadHeaderProps): JSX.Element {
  return (
    <header className="lead-header">
      <div className="lead-header__top">
        <Link to="/leads" className="lead-header__back" aria-label="Back to leads">
          <ArrowLeftIcon size={16} />
        </Link>
        <div className="lead-header__identity">
          <div className="lead-header__name-line">
            <h1 className="lead-header__name">{lead.name}</h1>
            {statusLabel !== '—' ? (
              <StatusPill tone={statusTone(statusLabel)}>{statusLabel}</StatusPill>
            ) : null}
            {lead.dnc ? (
              <StatusPill tone="dnc" dot className="lead-header__dnc">
                Do not contact
              </StatusPill>
            ) : null}
          </div>
          <div className="lead-header__meta">
            {ownerName !== '—' ? (
              <span className="lead-header__owner">
                <span className="lead-header__owner-avatar" aria-hidden="true">
                  {initials(ownerName)}
                </span>
                {ownerName}
              </span>
            ) : (
              <span className="lead-header__owner lead-header__owner--none">Unassigned</span>
            )}
            {lead.url ? (
              <a
                className="lead-header__url"
                href={lead.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {lead.url.replace(/^https?:\/\//, '')}
                <ExternalLinkIcon size={12} />
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className="lead-header__actions"
        role="group"
        aria-label="Lead actions (available in Phase 4)"
      >
        {NEXT_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <Button
              key={action.id}
              size="sm"
              disabled
              title={`${action.label} — available in Phase 4`}
              aria-label={`${action.label} (available in Phase 4)`}
            >
              <Icon size={14} />
              {action.label}
            </Button>
          );
        })}
      </div>
    </header>
  );
}
