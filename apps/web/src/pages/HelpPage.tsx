import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { Kbd } from '../ui/index.ts';
import { Page } from './Page.tsx';

/*
 * Support & FAQs — the rail's about-the-tool entry.
 *
 * Every answer here describes REAL enforced behavior (the compliance rails live
 * in the engine, not the UI), so this page stays true as the product grows. No
 * invented help-desk URLs: Switchboard is internal, so the escalation path is a
 * workspace admin, and the keyboard map is the live registry behind `?`.
 */

interface Faq {
  q: string;
  a: JSX.Element;
}

const RAILS: readonly Faq[] = [
  {
    q: 'Why can’t I email or call this lead?',
    a: (
      <>
        The lead is marked <strong>do not contact</strong>, the address is suppressed (unsubscribed
        or bounced), or there is no consent on file. Compliance rails are checked inside the send
        itself — not just in the UI — so a blocked contact stays blocked everywhere, including
        sequences and bulk actions.
      </>
    ),
  },
  {
    q: 'Why did my sequence stop on its own?',
    a: (
      <>
        Someone replied. A reply pauses that enrollment before the next step can be claimed, so
        nobody gets a follow-up nudge while they are already talking to you. Enrollments also stop
        on unsubscribe, DNC, and bounces.
      </>
    ),
  },
  {
    q: 'My outbound is scheduled but hasn’t sent — why?',
    a: (
      <>
        Quiet hours. Automated outbound only goes out inside the contact’s allowed window; steps
        that come due outside it wait rather than fire. Daily caps can also hold a step until the
        next window.
      </>
    ),
  },
  {
    q: 'Are my calls recorded?',
    a: (
      <>
        Only if an admin turned recording on for the workspace — it is <strong>off</strong> by
        default, the change is audited, and when it is on, consent is announced on the call before
        recording starts.
      </>
    ),
  },
];

const WORKING: readonly Faq[] = [
  {
    q: 'Where do my emails and calls come from?',
    a: (
      <>
        Your connected mailbox and phone number sync into the lead’s timeline automatically. Every
        touch — call, email, SMS, note — lands on the same append-only timeline, so the history is
        the same one your teammates see.
      </>
    ),
  },
  {
    q: 'What is a Smart View?',
    a: (
      <>
        A saved query over your leads that re-runs every time you open it — so “my overdue
        follow-ups” is always current, never a stale list. Build one under{' '}
        <Link to="/views">Views</Link>.
      </>
    ),
  },
  {
    q: 'Who can change workspace settings?',
    a: (
      <>
        Admins. Reps can read reference data (owners, statuses, stages) but user management, custom
        fields, templates, and compliance settings are admin-only, and changes are written to an
        append-only audit log.
      </>
    ),
  },
];

function FaqList({ items }: { items: readonly Faq[] }): JSX.Element {
  return (
    <dl className="sb-help__faq">
      {items.map((item) => (
        <div key={item.q} className="sb-help__faq-item">
          <dt className="sb-help__q">{item.q}</dt>
          <dd className="sb-help__a">{item.a}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HelpPage(): JSX.Element {
  return (
    <Page
      title="Support & FAQs"
      subtitle="How Switchboard behaves, why it sometimes says no, and where to get help."
    >
      <div className="sb-help">
        <section className="sb-help__section" aria-labelledby="help-rails">
          <h2 id="help-rails" className="sb-help__section-title">
            Compliance rails
          </h2>
          <p className="sb-help__lede">
            Switchboard refuses unsafe outbound rather than asking you to remember the rules. When
            something is blocked, it is one of these.
          </p>
          <FaqList items={RAILS} />
        </section>

        <section className="sb-help__section" aria-labelledby="help-working">
          <h2 id="help-working" className="sb-help__section-title">
            Working in Switchboard
          </h2>
          <FaqList items={WORKING} />
        </section>

        <section className="sb-help__section" aria-labelledby="help-keys">
          <h2 id="help-keys" className="sb-help__section-title">
            Keyboard
          </h2>
          <p className="sb-help__lede">
            Switchboard is keyboard-first. Press <Kbd>?</Kbd> anywhere for the full, live shortcut
            map, <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> for the command palette, and <Kbd>g</Kbd> then a
            letter to jump between surfaces (the letters are shown beside each rail item).
          </p>
        </section>

        <section className="sb-help__section" aria-labelledby="help-stuck">
          <h2 id="help-stuck" className="sb-help__section-title">
            Still stuck?
          </h2>
          <p className="sb-help__lede">
            Switchboard is an internal tool — there is no outside help desk. Ask a workspace admin:
            they can fix access, roles, custom fields, templates, and compliance settings, and they
            can see the audit log behind any change. Version and workspace details live in{' '}
            <Link to="/settings">Settings → About</Link>.
          </p>
        </section>
      </div>
    </Page>
  );
}
