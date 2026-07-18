import type { JSX } from 'react';
import type { SmsMessage } from '@switchboard/shared';
import { cx } from '../../../lib/cx.ts';
import { formatClockTime, isInboundOptOut } from '../lib/sms.ts';
import {
  AlertTriangleIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  PhoneOffIcon,
} from '../icons.tsx';

/*
 * One SMS message in the conversation thread. Inbound sits left, outbound right;
 * the timestamp is mono/tabular and the outbound delivery status rides in the meta
 * line. An inbound STOP-family reply is not a chat bubble — it renders as a centered
 * system divider (the sms_opt_out moment), so the suppression is legible in the
 * thread itself.
 */

function DeliveryStatus({ status }: { status: string }): JSX.Element {
  switch (status) {
    case 'delivered':
      return (
        <span className="sms-status">
          <CheckCheckIcon size={12} /> Delivered
        </span>
      );
    case 'failed':
      return (
        <span className="sms-status sms-status--failed">
          <AlertTriangleIcon size={12} /> Failed
        </span>
      );
    case 'queued':
      return (
        <span className="sms-status">
          <ClockIcon size={12} /> Sending…
        </span>
      );
    default:
      return (
        <span className="sms-status">
          <CheckIcon size={12} /> Sent
        </span>
      );
  }
}

export function SmsBubble({ message }: { message: SmsMessage }): JSX.Element {
  const iso = message.sentAt ?? message.createdAt;
  const time = formatClockTime(iso);

  if (message.direction === 'inbound' && isInboundOptOut(message.body)) {
    return (
      <li className="sms-sys">
        <PhoneOffIcon size={14} />
        <span className="sms-sys__text">
          Contact replied <b>{message.body.trim().toUpperCase()}</b> — number opted out and
          suppressed
        </span>
        <time className="sms-sys__time" dateTime={iso}>
          {time}
        </time>
      </li>
    );
  }

  const outbound = message.direction === 'outbound';
  return (
    <li className={cx('sms-bubble', outbound ? 'sms-bubble--out' : 'sms-bubble--in')}>
      <div className="sms-bubble__body">{message.body}</div>
      <div className="sms-bubble__meta">
        <time className="sms-bubble__time" dateTime={iso}>
          {time}
        </time>
        {outbound ? <DeliveryStatus status={message.status} /> : null}
      </div>
    </li>
  );
}
