import { Fragment, useEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import type { SmsMessage } from '@switchboard/shared';
import { EmptyState, ErrorState, Spinner } from '../../../ui/index.ts';
import { groupMessagesByDay } from '../lib/sms.ts';
import { MessageIcon } from '../icons.tsx';
import { SmsBubble } from './SmsBubble.tsx';

/*
 * The SMS conversation, oldest → newest, grouped by day with sticky dividers and
 * newest pinned at the bottom (auto-scrolled). Presentational: the drawer owns the
 * `GET /leads/:id/sms` query and passes state down. All four async states are
 * covered (loading / error+retry / empty / data). The scroll region is a `log` so a
 * screen reader announces a freshly-appended outbound bubble.
 */

interface SmsThreadProps {
  messages: SmsMessage[];
  now: Date;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
}

export function SmsThread({
  messages,
  now,
  isLoading,
  isError,
  errorMessage,
  onRetry,
}: SmsThreadProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const groups = useMemo(() => groupMessagesByDay(messages, now), [messages, now]);

  // Pin to newest whenever the message count changes (mount + on send). Instant, not
  // animated — it is a data/keyboard-driven jump, per the motion law.
  const count = messages.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  if (isLoading) {
    return (
      <div className="sms-thread sms-thread--status" aria-busy="true">
        <Spinner label="Loading conversation" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="sms-thread sms-thread--status">
        <ErrorState
          title="Couldn’t load the conversation"
          description={errorMessage ?? 'The request failed.'}
          onRetry={onRetry}
        />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="sms-thread sms-thread--status">
        <EmptyState
          icon={<MessageIcon size={22} />}
          title="No messages yet"
          description="Send the first text to start the conversation."
        />
      </div>
    );
  }

  return (
    <div
      className="sms-thread"
      ref={scrollRef}
      role="log"
      aria-label="SMS conversation"
      aria-live="polite"
      aria-relevant="additions"
    >
      <ol className="sms-thread__list">
        {groups.map((group) => (
          <Fragment key={group.key}>
            <li className="sms-thread__divider">
              <span className="sms-thread__divider-label">{group.label}</span>
            </li>
            {group.messages.map((message) => (
              <SmsBubble key={message.id} message={message} />
            ))}
          </Fragment>
        ))}
      </ol>
    </div>
  );
}
