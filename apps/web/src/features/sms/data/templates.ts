import type { Template } from '@switchboard/shared';

/*
 * Built-in SMS-channel quick-reply templates for the composer's template picker.
 * Kept feature-local (like the comms feature seeds its own email templates) so the
 * demo has real SMS presets without depending on cross-feature template stores — no
 * seeded SMS templates exist elsewhere. They are C1 `Template` rows (channel:'sms',
 * no subject), so the picker code is unchanged if these are later sourced from a
 * real `GET /templates?channel=sms`.
 *
 * Bodies are short, plain, and human — no merge tags to keep the demo self-contained
 * (the send engine appends the §4.5 opt-out line on first contact automatically).
 */

const TS = '2026-07-01T00:00:00.000Z';

function tmpl(id: string, name: string, body: string): Template {
  return {
    id,
    name,
    channel: 'sms',
    subject: null,
    body,
    ownerId: null,
    shared: true,
    createdAt: TS,
    updatedAt: TS,
  };
}

export const SMS_TEMPLATES: readonly Template[] = [
  tmpl(
    'sms-intro',
    'Intro — first touch',
    'Hi, it’s Ben from Switchboard. You booked a demo — still a good time this week?',
  ),
  tmpl(
    'sms-nudge',
    'Nudge — no reply',
    'Just following up on my last note — happy to keep it to a quick 10 minutes if easier.',
  ),
  tmpl(
    'sms-confirm',
    'Confirm meeting',
    'Confirming we’re on for tomorrow. I’ll send a calendar link now — reply here if anything shifts.',
  ),
  tmpl(
    'sms-recap',
    'Recap + next step',
    'Thanks for the time today. I sent a short recap to your email — anything you’d add?',
  ),
  tmpl(
    'sms-checkin',
    'Renewal check-in',
    'Your renewal is coming up — want to grab 15 minutes to make sure the plan still fits?',
  ),
] as const;
