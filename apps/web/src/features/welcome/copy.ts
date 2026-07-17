/*
 * Every word on the landing page, in one place. Copy is design material here:
 * short declaratives, numbers over adjectives, an operator's economy. No lorem,
 * no froth. Kept as data so the page components stay presentational and the
 * voice is auditable in a single file.
 */

export const WORDMARK = 'Switchboard';

export const NAV_SIGN_IN = 'Sign in · SSO';

export interface NavMenuItem {
  name: string;
  /** In-page anchor — every target is a real section below. */
  href: `#${string}`;
}

/** Landing nav menu — anchors into the page, no dead links. */
export const NAV_MENU: readonly NavMenuItem[] = [
  { name: 'Features', href: '#welcome-acts' },
  { name: 'Shortcuts', href: '#welcome-keys' },
  { name: 'Compliance', href: '#welcome-trust' },
];

/**
 * The accounts band under the hero frame. These are the demo dataset's own
 * companies — accounts being worked in the product, not invented "partners".
 */
export const ACCOUNTS_BAND = {
  title: 'On the board this week',
  names: [
    'Northwind Labs',
    'Harbor Analytics',
    'Vertex Robotics',
    'Iron Cedar Freight',
    'Copper Systems',
    'Nova Capital',
    'Bright Networks',
    'Granite Foods',
    'Quantum Robotics',
  ],
} as const;

export const HERO = {
  headline: ['Pick up the line.', 'The rest is already dialed.'],
  sub: 'Switchboard lines up every reply, task, and call in one keyboard-driven queue — so the next move is always one keystroke away.',
  cta: 'Open Switchboard',
} as const;

export interface HeroStat {
  value: string;
  label: string;
}

export const HERO_STATS: readonly HeroStat[] = [
  { value: '0.9s', label: 'to open a lead' },
  { value: '1 key', label: 'to the next call' },
  { value: '100%', label: 'of touches on the timeline' },
];

export interface FeatureActCopy {
  id: string;
  label: string;
  title: string;
  body: readonly [string, string];
}

export const FEATURE_ACTS: readonly FeatureActCopy[] = [
  {
    id: 'triage',
    label: 'Inbox triage',
    title: 'One queue, lit by state',
    body: [
      'Replies, overdue tasks, and live sequences surface in a single lamp-lit list.',
      'Answer the one at the top, and the next is already waiting under your cursor.',
    ],
  },
  {
    id: 'calling',
    label: 'One-keystroke calling',
    title: 'Land on a lead. Press the key.',
    body: [
      'One keystroke opens the line straight from the row — no dialer, no lookup.',
      'Consent is announced and the call is on the timeline before it rings.',
    ],
  },
  {
    id: 'sequences',
    label: 'Sequences that stop themselves',
    title: 'A reply ends the cadence',
    body: [
      'The moment someone replies, the sequence pauses — before the next send is even claimed.',
      'Nobody gets a follow-up nudge while they are already talking to you.',
    ],
  },
];

export const KEYBOARD = {
  label: 'Keyboard-first',
  title: 'The whole product, from the home row',
  sub: 'Every combo below is live in the app right now — the same map the ? sheet shows.',
} as const;

export const TRUST_LINE =
  'Consent announced on every recorded call · unsubscribe honored in one click · DNC enforced at the engine';

export const FOOTER = {
  cta: 'Open Switchboard',
  note: 'Switchboard is an internal tool for the revenue team. Access is limited to staff accounts through single sign-on.',
} as const;

/** Both primary CTAs and the nav sign-in route to the dev-login gate. */
export const LOGIN_PATH = '/login';
