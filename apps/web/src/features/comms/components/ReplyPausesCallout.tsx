import type { JSX } from 'react';
import { ReplyIcon } from '../icons.tsx';

/*
 * The compliance story the boss should see: the I-SEND-2 guarantee stated in one
 * sentence. This is the UI face of the server-side never-event proven in Task 2e
 * — once a reply or bounce lands, no further step of that enrollment can send.
 */
export function ReplyPausesCallout(): JSX.Element {
  return (
    <aside className="callout" aria-label="Reply safety guarantee">
      <span className="callout__lamp" aria-hidden="true">
        <ReplyIcon size={16} />
      </span>
      <div className="callout__text">
        <span className="callout__title">A reply pauses everything</span>
        <p className="callout__body">
          The instant a contact replies or bounces, every remaining step for that enrollment stops —
          no message is ever sent after a reply. Guaranteed at the database level, not by timing
          <span className="callout__ref"> (I-SEND-2)</span>.
        </p>
      </div>
    </aside>
  );
}
