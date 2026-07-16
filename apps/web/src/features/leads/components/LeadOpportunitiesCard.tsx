import type { JSX } from 'react';
import type { Opportunity } from '@switchboard/shared';
import { ErrorState, Skeleton, StatusPill } from '../../../ui/index.ts';
import type { StatusTone } from '../../../ui/index.ts';
import { formatDate, formatMoneyCents } from '../lib/format.ts';

/*
 * Read-only opportunities card for the lead's right rail. Reflects
 * GET /opportunities?leadId=; stage labels come from the opportunity-stages
 * reference list. No mutation affordances (later phase).
 */

interface LeadOpportunitiesCardProps {
  opportunities: Opportunity[];
  stageLabel: (id: string | null) => string;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

function statusTone(status: Opportunity['status']): StatusTone {
  if (status === 'won') return 'won';
  if (status === 'lost') return 'lost';
  return 'neutral';
}

export function LeadOpportunitiesCard({
  opportunities,
  stageLabel,
  isLoading,
  isError,
  onRetry,
}: LeadOpportunitiesCardProps): JSX.Element {
  return (
    <section className="rail-card" aria-label="Opportunities">
      <header className="rail-card__head">
        <h2 className="rail-card__title">Opportunities</h2>
        {!isLoading && !isError ? (
          <span className="rail-card__count">{opportunities.length}</span>
        ) : null}
      </header>

      {isLoading ? (
        <div className="rail-card__body" aria-hidden="true">
          <Skeleton height={54} />
        </div>
      ) : isError ? (
        <ErrorState
          className="rail-card__errorstate"
          title="Couldn’t load opportunities"
          onRetry={onRetry}
        />
      ) : opportunities.length === 0 ? (
        <p className="rail-card__empty">No opportunities on this lead.</p>
      ) : (
        <ul className="rail-card__list">
          {opportunities.map((opp) => (
            <li key={opp.id} className="opp-row">
              <div className="opp-row__top">
                <span className="opp-row__value">
                  {formatMoneyCents(opp.valueCents, opp.currency)}
                </span>
                <StatusPill tone={statusTone(opp.status)}>{opp.status}</StatusPill>
              </div>
              <div className="opp-row__meta">
                <span className="opp-row__stage">{stageLabel(opp.stageId)}</span>
                <span className="opp-row__dot" aria-hidden="true">
                  ·
                </span>
                <span className="opp-row__confidence">{opp.confidence}%</span>
                {opp.closeDate ? (
                  <>
                    <span className="opp-row__dot" aria-hidden="true">
                      ·
                    </span>
                    <span className="opp-row__close">{formatDate(opp.closeDate)}</span>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
