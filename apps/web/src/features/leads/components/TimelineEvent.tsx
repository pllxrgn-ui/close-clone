import type { JSX } from 'react';
import type { Activity } from '@switchboard/shared';
import { cx } from '../../../lib/cx.ts';
import { EVENT_TONE_CLASS, resolveEventMeta } from '../events/eventMeta.tsx';
import { formatDateTime, formatRelativeTime } from '../lib/format.ts';

/*
 * One timeline row for a C4 activity: a type-appropriate glyph tinted with the
 * event's state tone, a verb-phrase headline, an optional payload-derived detail,
 * and actor + relative time (absolute in the title). Every C4 type resolves to a
 * dedicated meta (see eventMeta) — no unknown fallback for taxonomy members.
 */

interface TimelineEventProps {
  activity: Activity;
  userName: (id: string | null) => string;
  now: Date;
}

export function TimelineEvent({ activity, userName, now }: TimelineEventProps): JSX.Element {
  const meta = resolveEventMeta(activity.type);
  const Icon = meta.icon;
  const detail = meta.detail?.(activity.payload) ?? null;
  const actor = activity.userId ? userName(activity.userId) : null;

  return (
    <li className="tl-event">
      <span className={cx('tl-event__icon', EVENT_TONE_CLASS[meta.tone])} aria-hidden="true">
        <Icon size={15} />
      </span>
      <div className="tl-event__body">
        <p className="tl-event__headline">
          <span className="tl-event__label">{meta.label}</span>
          {detail ? <span className="tl-event__detail">{detail}</span> : null}
        </p>
        <p className="tl-event__meta">
          {actor && actor !== '—' ? <span className="tl-event__actor">{actor}</span> : null}
          <time dateTime={activity.occurredAt} title={formatDateTime(activity.occurredAt)}>
            {formatRelativeTime(activity.occurredAt, now)}
          </time>
        </p>
      </div>
    </li>
  );
}
