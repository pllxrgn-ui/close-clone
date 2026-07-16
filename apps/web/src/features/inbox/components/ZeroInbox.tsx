import type { JSX } from 'react';
import { EmptyState } from '../../../ui/index.ts';
import { InboxZeroIcon } from '../icons.tsx';

/*
 * The "Am I done?" moment. Emptying the queue reveals this deliberately calm zero
 * state — one line of copy, a single quiet mark, no confetti. The lamp rail goes
 * dark because there is genuinely nothing lit.
 */
export function ZeroInbox({ doneToday }: { doneToday: number }): JSX.Element {
  return (
    <div className="sb-inbox__zero">
      <EmptyState
        icon={<InboxZeroIcon size={40} />}
        title="You’re all caught up"
        description={
          doneToday > 0
            ? `Nothing needs you right now — ${doneToday.toLocaleString('en-US')} cleared today.`
            : 'Nothing needs you right now.'
        }
      />
    </div>
  );
}
