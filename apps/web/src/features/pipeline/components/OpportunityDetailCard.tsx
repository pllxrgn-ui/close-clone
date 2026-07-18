import type { JSX } from 'react';
import type { Opportunity } from '@switchboard/shared';
import { cx } from '../../../lib/cx.ts';
import { Button, CloseIcon, IconButton, StatusPill } from '../../../ui/index.ts';
import { formatCloseDate, isPastDate, monogram } from '../lib/format.ts';
import { formatMoney } from '../lib/money.ts';
import { ClockIcon } from '../icons.tsx';

/*
 * Opportunity detail — the pop-up card shown when a board card is clicked (not
 * dragged). Presentational: the board owns open state + navigation. Renders the
 * deal's full, uncompacted value plus every field the compact card can't fit
 * (stage, owner, note, created/updated), and routes to the lead on demand.
 */

interface OpportunityDetailCardProps {
  opp: Opportunity;
  leadName: string;
  ownerName: string | null;
  stageLabel: string;
  now: Date;
  titleId: string;
  onClose: () => void;
  onViewLead: () => void;
}

const PILL = { won: 'won', lost: 'lost', active: undefined } as const;

function fullDate(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function OpportunityDetailCard({
  opp,
  leadName,
  ownerName,
  stageLabel,
  now,
  titleId,
  onClose,
  onViewLead,
}: OpportunityDetailCardProps): JSX.Element {
  const overdue = opp.status === 'active' && isPastDate(opp.closeDate, now);
  const terminal = opp.status === 'won' || opp.status === 'lost' ? opp.status : null;

  return (
    <div className="pl-detail">
      <header className="pl-detail__head">
        <div className="pl-detail__title">
          <h2 id={titleId} className="pl-detail__name">
            {leadName}
          </h2>
          {terminal ? (
            <StatusPill tone={PILL[terminal]}>{terminal === 'won' ? 'Won' : 'Lost'}</StatusPill>
          ) : null}
        </div>
        <IconButton label="Close details" size="sm" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </header>

      <div className="pl-detail__value">
        {formatMoney(opp.valueCents, opp.currency, { compact: false })}
        <span className="pl-detail__ccy">{opp.currency}</span>
      </div>

      <div className="pl-detail__conf">
        <span className="pl-detail__conf-bar" aria-hidden="true">
          <span className="pl-detail__conf-fill" style={{ width: `${opp.confidence}%` }} />
        </span>
        <span className="pl-detail__conf-num">{opp.confidence}% confidence</span>
      </div>

      <dl className="pl-detail__grid">
        <div className="pl-detail__row">
          <dt>Stage</dt>
          <dd>{stageLabel}</dd>
        </div>
        <div className="pl-detail__row">
          <dt>Close date</dt>
          <dd className={cx('pl-detail__date', overdue && 'is-overdue')}>
            <ClockIcon size={13} />
            {formatCloseDate(opp.closeDate)}
            {overdue ? <span className="pl-detail__overdue">overdue</span> : null}
          </dd>
        </div>
        <div className="pl-detail__row">
          <dt>Owner</dt>
          <dd className="pl-detail__owner">
            {ownerName ? (
              <>
                <span className="pl-detail__mono" aria-hidden="true">
                  {monogram(ownerName)}
                </span>
                {ownerName}
              </>
            ) : (
              'Unassigned'
            )}
          </dd>
        </div>
        <div className="pl-detail__row">
          <dt>Created</dt>
          <dd>{fullDate(opp.createdAt)}</dd>
        </div>
        <div className="pl-detail__row">
          <dt>Updated</dt>
          <dd>{fullDate(opp.updatedAt)}</dd>
        </div>
      </dl>

      {opp.note ? (
        <div className="pl-detail__note">
          <span className="pl-detail__note-label">Note</span>
          <p className="pl-detail__note-body">{opp.note}</p>
        </div>
      ) : null}

      <footer className="pl-detail__foot">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" onClick={onViewLead}>
          View lead →
        </Button>
      </footer>
    </div>
  );
}
