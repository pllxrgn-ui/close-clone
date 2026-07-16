import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent } from 'react';
import type { Opportunity } from '@switchboard/shared';
import { cx } from '../../../lib/cx.ts';
import { StatusPill } from '../../../ui/index.ts';
import { formatCloseDate, isPastDate, monogram } from '../lib/format.ts';
import { formatMoney } from '../lib/money.ts';
import type { TerminalKind } from '../lib/stages.ts';
import { ClockIcon, GripIcon } from '../icons.tsx';

/*
 * One opportunity card: lead name, value as a display numeral, confidence, owner
 * monogram, and a mono close date that turns amber when it's past due. The whole
 * card is the drag handle (pointer) and a roving-tabindex focus target (keyboard
 * bracket/arrow moves act on the focused card). Won/lost cards carry a state
 * pill and, briefly after a close, a color-only flash.
 */

interface OpportunityCardProps {
  opp: Opportunity;
  leadName: string;
  ownerName: string | null;
  stageLabel: string;
  now: Date;
  active: boolean;
  dragging: boolean;
  flash: TerminalKind | null;
  registerRef: (el: HTMLLIElement | null) => void;
  onFocus: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLLIElement>) => void;
  style?: CSSProperties;
}

const PILL_TONE = { won: 'won', lost: 'lost' } as const;

export function OpportunityCard({
  opp,
  leadName,
  ownerName,
  stageLabel,
  now,
  active,
  dragging,
  flash,
  registerRef,
  onFocus,
  onPointerDown,
  style,
}: OpportunityCardProps): JSX.Element {
  const overdue = opp.status === 'active' && isPastDate(opp.closeDate, now);
  const value = formatMoney(opp.valueCents, opp.currency);
  const fullValue = `${formatMoney(opp.valueCents, opp.currency, { compact: false })} ${opp.currency}`;
  const terminal = opp.status === 'won' || opp.status === 'lost' ? opp.status : null;

  const ariaLabel =
    `${leadName}, ${fullValue}, ${opp.confidence}% confidence, ` +
    `${opp.closeDate ? `closes ${formatCloseDate(opp.closeDate)}` : 'no close date'}` +
    `${overdue ? ' (overdue)' : ''}, stage ${stageLabel}` +
    `${ownerName ? `, owner ${ownerName}` : ''}`;

  return (
    <li
      ref={registerRef}
      className={cx(
        'pl-card',
        active && 'is-active',
        dragging && 'is-dragging',
        terminal && `pl-card--${terminal}`,
        flash && `pl-card--flash-${flash}`,
      )}
      tabIndex={active ? 0 : -1}
      aria-label={ariaLabel}
      aria-roledescription="Opportunity card. Use left and right arrows or the bracket keys to move it between stages."
      data-opp-id={opp.id}
      data-stage-id={opp.stageId ?? ''}
      onFocus={onFocus}
      onPointerDown={onPointerDown}
      {...(style ? { style } : {})}
    >
      <span className="pl-card__grip" aria-hidden="true">
        <GripIcon size={14} />
      </span>

      <div className="pl-card__head">
        <span className="pl-card__name">{leadName}</span>
        {terminal ? (
          <StatusPill tone={PILL_TONE[terminal]} className="pl-card__pill">
            {terminal === 'won' ? 'Won' : 'Lost'}
          </StatusPill>
        ) : null}
      </div>

      <div className="pl-card__value" title={fullValue}>
        {value}
      </div>

      <div className="pl-card__meta">
        <span className="pl-card__conf" title={`${opp.confidence}% confidence`}>
          <span className="pl-card__conf-bar" aria-hidden="true">
            <span className="pl-card__conf-fill" style={{ width: `${opp.confidence}%` }} />
          </span>
          <span className="pl-card__conf-num">{opp.confidence}%</span>
        </span>

        <span
          className={cx('pl-card__date', overdue && 'is-overdue')}
          title={opp.closeDate ?? 'No close date'}
        >
          <ClockIcon size={12} />
          {formatCloseDate(opp.closeDate)}
        </span>

        <span className="pl-card__owner" title={ownerName ?? 'Unassigned'} aria-hidden="true">
          {ownerName ? monogram(ownerName) : '—'}
        </span>
      </div>
    </li>
  );
}
