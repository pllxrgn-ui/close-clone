import { useId, useState } from 'react';
import type { JSX } from 'react';
import type { Activity } from '@switchboard/shared';
import { cx } from '../../../lib/cx.ts';
import { EVENT_TONE_CLASS, expandedRows, resolveEventMeta } from '../events/eventMeta.tsx';
import { formatDateTime, formatRelativeTime } from '../lib/format.ts';
import { ChevronRightIcon } from '../icons.tsx';

/*
 * One timeline row for a C4 activity: a type-appropriate glyph tinted with the
 * event's state tone, a verb-phrase headline, an optional payload-derived detail,
 * and actor + relative time. The row is a disclosure — click/Enter expands an
 * in-place panel with the full payload (subject/preview, message body, outcome +
 * duration, from → to, …) plus the absolute timestamp, actor, and contact.
 * Expansion is instant (no layout animation, law §4); the revealed content rises
 * with the shared transform+opacity entrance.
 */

interface TimelineEventProps {
  activity: Activity;
  userName: (id: string | null) => string;
  contactName?: (id: string | null) => string;
  now: Date;
}

export function TimelineEvent({
  activity,
  userName,
  contactName,
  now,
}: TimelineEventProps): JSX.Element {
  const meta = resolveEventMeta(activity.type);
  const Icon = meta.icon;
  const detail = meta.detail?.(activity.payload) ?? null;
  const actor = activity.userId ? userName(activity.userId) : null;
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const rows = expandedRows(activity.payload);
  const contact = activity.contactId ? (contactName?.(activity.contactId) ?? null) : null;

  return (
    <li className={cx('tl-event', expanded && 'is-expanded')}>
      <span className={cx('tl-event__icon', EVENT_TONE_CLASS[meta.tone])} aria-hidden="true">
        <Icon size={15} />
      </span>
      <div className="tl-event__body">
        <button
          type="button"
          className="tl-event__row"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span className="tl-event__lines">
            <span className="tl-event__headline">
              <span className="tl-event__label">{meta.label}</span>
              {detail ? <span className="tl-event__detail">{detail}</span> : null}
            </span>
            <span className="tl-event__meta">
              {actor && actor !== '—' ? <span className="tl-event__actor">{actor}</span> : null}
              <time dateTime={activity.occurredAt} title={formatDateTime(activity.occurredAt)}>
                {formatRelativeTime(activity.occurredAt, now)}
              </time>
            </span>
          </span>
          <ChevronRightIcon size={14} className="tl-event__chev" />
        </button>

        {expanded ? (
          <div id={panelId} className="tl-event__panel">
            <dl className="tl-event__facts">
              {rows.map((row) => (
                <div key={row.label} className="tl-event__fact">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
              <div className="tl-event__fact">
                <dt>When</dt>
                <dd>{formatDateTime(activity.occurredAt)}</dd>
              </div>
              {actor && actor !== '—' ? (
                <div className="tl-event__fact">
                  <dt>By</dt>
                  <dd>{actor}</dd>
                </div>
              ) : null}
              {contact && contact !== '—' ? (
                <div className="tl-event__fact">
                  <dt>Contact</dt>
                  <dd>{contact}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}
      </div>
    </li>
  );
}
