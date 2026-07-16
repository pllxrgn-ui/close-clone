import type { JSX, MouseEvent, ReactNode } from 'react';
import { Button, LampRail, StatusPill, VisuallyHidden } from '../../../ui/index.ts';
import type { InboxItem } from '../model/types.ts';
import type { InboxRowProps as RowNavProps } from '../hooks/useInboxNav.ts';
import { formatAge, formatClock, formatDay, formatDue } from '../model/time.ts';
import {
  BranchIcon,
  CheckIcon,
  MailIcon,
  MessageIcon,
  ReplyIcon,
  SkipIcon,
  SnoozeIcon,
} from '../icons.tsx';

export interface InboxRowActions {
  onReply: () => void;
  onComplete: () => void;
  onApprove: () => void;
  onSkip: () => void;
  onSnooze: () => void;
}

interface InboxRowComponentProps {
  item: InboxItem;
  active: boolean;
  rowProps: RowNavProps;
  actions: InboxRowActions;
}

/** Keep focus on the row body when an action button is clicked (no focus steal). */
function holdFocus(event: MouseEvent): void {
  event.preventDefault();
}

interface Meta {
  mono: string;
  chip: string;
  chipTone: 'reply' | 'overdue' | 'seq';
}

interface RowContent {
  icon: ReactNode;
  line2: ReactNode;
  meta: Meta;
}

function content(item: InboxItem): RowContent {
  switch (item.kind) {
    case 'reply':
      return {
        icon: item.channel === 'email' ? <MailIcon size={13} /> : <MessageIcon size={13} />,
        line2: (
          <>
            <span className="sb-inbox__who">{item.contactName}</span>
            <span className="sb-inbox__dot" aria-hidden="true">
              ·
            </span>
            <span className="sb-inbox__what">{item.subject ?? item.snippet}</span>
          </>
        ),
        meta: {
          mono: formatClock(item.receivedAt),
          chip: formatAge(item.receivedAt),
          chipTone: 'reply',
        },
      };
    case 'task':
      return {
        icon: null,
        line2: <span className="sb-inbox__what">{item.title}</span>,
        meta: { mono: formatDay(item.dueAt), chip: formatDue(item.dueAt), chipTone: 'overdue' },
      };
    case 'review':
      return {
        icon: <BranchIcon size={13} />,
        line2: (
          <>
            <span className="sb-inbox__who">{item.sequenceName}</span>
            <span className="sb-inbox__dot" aria-hidden="true">
              ·
            </span>
            <span className="sb-inbox__what">{item.stepLabel}</span>
          </>
        ),
        meta: {
          mono: formatDay(item.dueAt),
          chip: `waiting ${formatAge(item.dueAt)}`,
          chipTone: 'seq',
        },
      };
    default:
      return { icon: null, line2: null, meta: { mono: '', chip: '', chipTone: 'reply' } };
  }
}

/** State + timing for screen readers (the lamp rail + visual meta are decorative). */
function srSummary(item: InboxItem): string {
  switch (item.kind) {
    case 'reply':
      return `New reply, ${formatAge(item.receivedAt)} old`;
    case 'task':
      return `Task ${formatDue(item.dueAt)}`;
    case 'review':
      return `Sequence step awaiting review, waiting ${formatAge(item.dueAt)}`;
    default:
      return '';
  }
}

function Actions({ item, actions }: { item: InboxItem; actions: InboxRowActions }): JSX.Element {
  const lead = item.leadName;
  if (item.kind === 'reply') {
    return (
      <>
        <Button
          size="sm"
          className="sb-inbox__act sb-inbox__act--primary"
          tabIndex={-1}
          onMouseDown={holdFocus}
          onClick={actions.onReply}
          aria-label={`Reply to ${lead}`}
          title="Reply (R)"
        >
          <ReplyIcon size={13} /> Reply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="sb-inbox__act sb-inbox__act--reveal"
          tabIndex={-1}
          onMouseDown={holdFocus}
          onClick={actions.onSnooze}
          aria-label={`Snooze ${lead} until tomorrow`}
          title="Snooze (S)"
        >
          <SnoozeIcon size={13} /> Snooze
        </Button>
      </>
    );
  }
  if (item.kind === 'task') {
    return (
      <>
        <Button
          size="sm"
          className="sb-inbox__act sb-inbox__act--primary"
          tabIndex={-1}
          onMouseDown={holdFocus}
          onClick={actions.onComplete}
          aria-label={`Complete task for ${lead}`}
          title="Complete (C)"
        >
          <CheckIcon size={13} /> Complete
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="sb-inbox__act sb-inbox__act--reveal"
          tabIndex={-1}
          onMouseDown={holdFocus}
          onClick={actions.onSnooze}
          aria-label={`Snooze ${lead} until tomorrow`}
          title="Snooze (S)"
        >
          <SnoozeIcon size={13} /> Snooze
        </Button>
      </>
    );
  }
  return (
    <>
      <Button
        size="sm"
        className="sb-inbox__act sb-inbox__act--primary"
        tabIndex={-1}
        onMouseDown={holdFocus}
        onClick={actions.onApprove}
        aria-label={`Approve sequence step for ${lead}`}
        title="Approve (A)"
      >
        <CheckIcon size={13} /> Approve
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="sb-inbox__act sb-inbox__act--reveal"
        tabIndex={-1}
        onMouseDown={holdFocus}
        onClick={actions.onSkip}
        aria-label={`Skip sequence step for ${lead}`}
        title="Skip (X)"
      >
        <SkipIcon size={13} /> Skip
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="sb-inbox__act sb-inbox__act--reveal"
        tabIndex={-1}
        onMouseDown={holdFocus}
        onClick={actions.onSnooze}
        aria-label={`Snooze ${lead} until tomorrow`}
        title="Snooze (S)"
      >
        <SnoozeIcon size={13} /> Snooze
      </Button>
    </>
  );
}

export function InboxRow({ item, active, rowProps, actions }: InboxRowComponentProps): JSX.Element {
  const { icon, line2, meta } = content(item);
  const isDncTask = item.kind === 'task' && item.leadDnc;

  return (
    <li className="sb-inbox__row" data-active={active ? 'true' : undefined} data-kind={item.kind}>
      <LampRail state={item.lamp} decorative />
      <div className="sb-inbox__row-body" {...rowProps}>
        <div className="sb-inbox__row-line1">
          <span className="sb-inbox__lead">{item.leadName}</span>
          {icon ? (
            <span className="sb-inbox__kind-icon" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          {isDncTask ? (
            <StatusPill tone="dnc" dot>
              DNC
            </StatusPill>
          ) : null}
        </div>
        <div className="sb-inbox__row-line2">{line2}</div>
        <VisuallyHidden>{srSummary(item)}</VisuallyHidden>
      </div>
      <div className="sb-inbox__row-meta" aria-hidden="true">
        <time className="sb-inbox__time">{meta.mono}</time>
        <span className={`sb-inbox__chip sb-inbox__chip--${meta.chipTone}`}>{meta.chip}</span>
      </div>
      <div className="sb-inbox__row-actions">
        <Actions item={item} actions={actions} />
      </div>
    </li>
  );
}
