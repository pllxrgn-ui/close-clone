import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Kbd } from '../ui/index.ts';

export interface HelpItem {
  question: string;
  answer: ReactNode;
}

export interface HelpGroup {
  id: string;
  title: string;
  intro: string;
  items: readonly HelpItem[];
}

export const HELP_GROUPS: readonly HelpGroup[] = [
  {
    id: 'accounts',
    title: 'Account and inboxes',
    intro: 'Connect and maintain the mailboxes that bring customer conversations into Switchboard.',
    items: [
      {
        question: 'How do I connect my Gmail inbox?',
        answer: (
          <>
            Open <Link to="/settings?section=inboxes">Settings → Inboxes</Link>, then approve Google
            consent. You never supply API keys.
          </>
        ),
      },
      {
        question: 'What do the inbox statuses mean?',
        answer: (
          <>
            <strong>Not connected</strong> means no authorization yet;{' '}
            <strong>Awaiting Google</strong> means approval is pending;{' '}
            <strong>Importing mail</strong> and <strong>Resyncing mail</strong> mean sync work is
            running; <strong>Connected</strong> means sync is live; <strong>Sync delayed</strong>{' '}
            means Switchboard is retrying; and <strong>Needs reconnect</strong> means Google
            approval is required again.
          </>
        ),
      },
      {
        question: 'What happens when I disconnect or reconnect?',
        answer:
          "Disconnecting clears Switchboard's Gmail authorization and sync cursors but keeps imported mail. Reconnect Gmail starts Google approval again and resumes sync on the same inbox.",
      },
    ],
  },
  {
    id: 'workflow',
    title: 'Daily workflow',
    intro: 'Use a shared lead record to keep every customer touch and next action in one place.',
    items: [
      {
        question: 'Where do emails, calls, texts, and notes appear?',
        answer: 'They appear in the shared append-only lead timeline.',
      },
      {
        question: 'What is a Smart View?',
        answer: (
          <>
            A Smart View is a live saved query. Open <Link to="/views">Smart Views</Link> to use or
            create one.
          </>
        ),
      },
      {
        question: 'How do keyboard shortcuts work?',
        answer: (
          <>
            Press <Kbd>?</Kbd> for shortcuts, <Kbd>Ctrl K</Kbd> for the command palette, or{' '}
            <Kbd>g</Kbd> then a rail letter to navigate.
          </>
        ),
      },
    ],
  },
  {
    id: 'messaging',
    title: 'Calling and messaging',
    intro: 'Calls, texts, and sequences stay tied to the same lead history as email.',
    items: [
      {
        question: 'How do calls and SMS work?',
        answer: (
          <>
            Use the <Link to="/dialer">Dialer</Link> for calls. To send SMS,{' '}
            <Link to="/leads">open a lead</Link> and use its SMS action. Each touch is added to the
            shared timeline.
          </>
        ),
      },
      {
        question: 'Why did my sequence stop?',
        answer:
          'Replies and unsubscribes pause active sequences. DNC, suppression, and bounce safeguards block eligible sends before delivery.',
      },
      {
        question: 'Where do I manage sequences?',
        answer: (
          <>
            Manage them in <Link to="/sequences">Sequences</Link>.
          </>
        ),
      },
    ],
  },
  {
    id: 'compliance',
    title: 'Compliance',
    intro:
      'Delivery safeguards are enforced at the point of outbound activity, not left to memory.',
    items: [
      {
        question: 'Why can I not email or call this lead?',
        answer:
          'DNC and active email or phone suppressions can block outbound email or calling at delivery.',
      },
      {
        question: 'Why is scheduled outbound waiting?',
        answer:
          'Quiet hours and daily caps can hold scheduled outbound until its next allowed window.',
      },
      {
        question: 'Are calls recorded?',
        answer: 'Recording is off by default, admin-controlled, audited, and consent-announced.',
      },
    ],
  },
  {
    id: 'admin',
    title: 'Admin support',
    intro:
      'Workspace administration stays with the people accountable for settings and audit history.',
    items: [
      {
        question: 'Who can change workspace settings?',
        answer: 'Admins can change workspace settings, and those changes are audited.',
      },
      {
        question: 'Where are build and workspace details?',
        answer: (
          <>
            Find them in <Link to="/settings?section=about">Settings → About</Link>.
          </>
        ),
      },
      {
        question: 'What if I am still blocked?',
        answer: 'Ask a workspace admin; Switchboard has no external help desk.',
      },
    ],
  },
];
