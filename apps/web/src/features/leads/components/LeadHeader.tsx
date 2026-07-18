import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { Lead } from '@switchboard/shared';
import { StatusPill } from '../../../ui/index.ts';
import { Suspense, lazy } from 'react';

// Lazy: keeps the comms/calling/sms features out of the leads chunk (audit #6);
// the launchers are single controls in the actions row and hydrate in the same
// paint in practice (chunks are shared with their feature routes).
const LeadComposerLauncher = lazy(() =>
  import('../../comms/index.ts').then((m) => ({ default: m.LeadComposerLauncher })),
);
const LeadCallLauncher = lazy(() =>
  import('../../calling/index.ts').then((m) => ({ default: m.LeadCallLauncher })),
);
const LeadSmsLauncher = lazy(() =>
  import('../../sms/index.ts').then((m) => ({ default: m.LeadSmsLauncher })),
);
const LeadEnrollLauncher = lazy(() =>
  import('../../comms/index.ts').then((m) => ({ default: m.LeadEnrollLauncher })),
);
import type { StatusTone } from '../../../ui/index.ts';
import { initials } from '../../../lib/format.ts';
import { LeadTaskLauncher } from './LeadTaskLauncher.tsx';
import { ArrowLeftIcon, ExternalLinkIcon } from '../icons.tsx';

/*
 * Lead-page header: identity + status + owner + a prominent DNC indicator, then
 * the next-action bar — Call / SMS / Email / Task / Enroll, all live. Nothing
 * here can send, dial, or bypass a compliance rail: every launcher's engine path
 * enforces DNC/suppression/quiet-hours inside the send/dial transaction, and
 * sequence enrollment re-checks the §4.3 rails at each send.
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
          <LeadTaskLauncher lead={lead} />
          <LeadEnrollLauncher lead={lead} />
        </Suspense>
      </div>
    </header>
  );
}
