import type { JSX } from 'react';
import { Page } from './Page.tsx';
import { StatusPill } from '../ui/index.ts';

/** State legend doubling as a visual check of the semantic state tokens. */
const LEGEND = [
  { tone: 'newReply', label: 'New reply' },
  { tone: 'overdue', label: 'Overdue' },
  { tone: 'inSequence', label: 'In sequence' },
  { tone: 'dnc', label: 'Do not contact' },
  { tone: 'won', label: 'Won' },
  { tone: 'lost', label: 'Lost' },
  { tone: 'draft', label: 'Draft' },
] as const;

export function InboxPage(): JSX.Element {
  return (
    <Page
      title="Inbox"
      subtitle="Your unified communication queue — replies, tasks, and calls in one stream."
    >
      <p className="sb-placeholder">
        The live inbox lands in a later phase. Color is spent almost entirely on state, so the queue
        reads like a status board at a glance:
      </p>
      <div className="sb-legend">
        {LEGEND.map((item) => (
          <StatusPill key={item.tone} tone={item.tone} dot>
            {item.label}
          </StatusPill>
        ))}
      </div>
    </Page>
  );
}
