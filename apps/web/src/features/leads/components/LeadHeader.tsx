import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { Lead } from '@switchboard/shared';
import { Button, StatusPill } from '../../../ui/index.ts';
import { Suspense, lazy } from 'react';

// Lazy: keeps the comms feature out of the leads chunk (audit #6); the
// launcher is one control in the actions row and hydrates in the same paint
// in practice (chunk is shared with the comms routes).
const LeadComposerLauncher = lazy(() =>
  import('../../comms/index.ts').then((m) => ({ default: m.LeadComposerLauncher })),
);
const LeadCallLauncher = lazy(() =>
  import('../../calling/index.ts').then((m) => ({ default: m.LeadCallLauncher })),
);
const LeadSmsLauncher = lazy(() =>
  import('../../sms/index.ts').then((m) => ({ default: m.LeadSmsLauncher })),
);
import type { StatusTone } from '../../../ui/index.ts';
import { initials } from '../../../lib/format.ts';
import { ArrowLeftIcon, BranchIcon, CircleDashedIcon, ExternalLinkIcon } from '../icons.tsx';

/*
 * Lead-page header: identity + status + owner + a prominent DNC indicator, then a
 * next-action bar. Call / SMS / Email are live (each opens its compliance-gated
 * surface); Task / Enroll remain disabled stubs until their lead-scoped launchers
 * land (enrollment lives on /sequences today). Nothing here can send, dial, or
 * bypass a compliance rail — the launchers enforce DNC/suppression/quiet-hours
 * at send/dial inside the engine layer.
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

      <div className="lead-header__actions" role="group" aria-label="Lead actions">
        <Suspense fallback={null}>
          <LeadCallLauncher lead={lead} />
          <LeadSmsLauncher leadId={lead.id} />
          <LeadComposerLauncher leadId={lead.id} />
        </Suspense>
        {NEXT_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <Button
              key={action.id}
              size="sm"
              disabled
              title={`${action.label} — not yet available`}
              aria-label={`${action.label} (not yet available)`}
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
