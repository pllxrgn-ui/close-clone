import type { JSX } from 'react';
import { cx } from '../../lib/cx.ts';
import { Kbd, VisuallyHidden } from '../../ui/index.ts';
import { InboxIcon } from '../../ui/icons.tsx';
import { StateLamp } from './StateLamp.tsx';
import { CheckIcon, PhoneIcon, RepeatIcon } from './icons.tsx';
import { useReveal } from './useReveal.ts';
import { CALLING, SEQUENCE, TRIAGE_ROWS } from './fixtures.ts';
import { FEATURE_ACTS } from './copy.ts';
import type { FeatureActCopy } from './copy.ts';

/*
 * The three feature acts. Each is a wide-caps label + two sentences + a LIVE
 * board vignette built from real primitives and fixture data (no screenshots,
 * no stock, no invented metrics). Each act rises 8px and fades in once when it
 * scrolls into view (useReveal / IntersectionObserver); with reduced motion or
 * no observer it is revealed from the start.
 */

function TriageVignette(): JSX.Element {
  return (
    <figure className="sb-welcome__panel">
      <figcaption className="sb-welcome__panel-head">
        <span className="sb-welcome__panel-eyebrow">
          <InboxIcon size={14} /> Inbox
        </span>
        <span className="sb-welcome__panel-meta">5 open · 2 replies</span>
      </figcaption>
      <ul className="sb-welcome__triage">
        {TRIAGE_ROWS.map((row, i) => (
          <li
            key={row.id}
            className={cx('sb-welcome__trow', i === 0 && 'is-active')}
            data-state={row.state}
          >
            <StateLamp state={row.state} word={row.stateWord} dotOnly />
            <span className="sb-welcome__trow-main">
              <span className="sb-welcome__trow-top">
                <span className="sb-welcome__trow-co">{row.company}</span>
                <span className="sb-welcome__trow-word">{row.stateWord}</span>
              </span>
              <span className="sb-welcome__trow-line">
                {row.person}: “{row.line}”
              </span>
            </span>
            <span className="sb-welcome__trow-aside">
              {i === 0 ? (
                <span className="sb-welcome__khint">
                  <Kbd>R</Kbd> reply
                </span>
              ) : (
                <time className="sb-welcome__trow-time">{row.time}</time>
              )}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function CallingVignette(): JSX.Element {
  return (
    <figure className="sb-welcome__panel">
      <figcaption className="sb-welcome__panel-head">
        <span className="sb-welcome__panel-eyebrow">
          <PhoneIcon size={14} /> Lead · {CALLING.company}
        </span>
      </figcaption>
      <div className="sb-welcome__call">
        <div className="sb-welcome__call-lead">
          <span className="sb-welcome__call-who">
            <span className="sb-welcome__call-name">{CALLING.contact}</span>
            <span className="sb-welcome__call-role">
              {CALLING.role} · <span className="sb-welcome__mono">{CALLING.phone}</span>
            </span>
          </span>
          <span className="sb-welcome__khint">
            <Kbd>C</Kbd> call
          </span>
        </div>
        <div className="sb-welcome__call-strip" role="group" aria-label="Live call">
          <StateLamp state="live" word="Live" />
          <span className="sb-welcome__call-timer sb-welcome__mono">{CALLING.timer}</span>
          <span className="sb-welcome__call-consent">
            <CheckIcon size={13} /> {CALLING.consentLine}
          </span>
          <span className="sb-welcome__call-rec">REC</span>
        </div>
      </div>
    </figure>
  );
}

function SequenceVignette(): JSX.Element {
  const steps = Array.from({ length: SEQUENCE.steps }, (_, i) => i + 1);
  return (
    <figure className="sb-welcome__panel">
      <figcaption className="sb-welcome__panel-head">
        <span className="sb-welcome__panel-eyebrow">
          <RepeatIcon size={14} /> Sequence · {SEQUENCE.sequence}
        </span>
      </figcaption>
      <div className="sb-welcome__seq">
        <div className="sb-welcome__seq-enroll">
          <span className="sb-welcome__seq-who">
            {SEQUENCE.contact} · {SEQUENCE.company}
          </span>
          <ol className="sb-welcome__seq-steps" aria-hidden="true">
            {steps.map((n) => (
              <li
                key={n}
                className={cx(
                  'sb-welcome__seq-step',
                  n < SEQUENCE.step && 'is-done',
                  n === SEQUENCE.step && 'is-here',
                )}
              />
            ))}
          </ol>
          <span className="sb-welcome__seq-count sb-welcome__mono">
            step {SEQUENCE.step}/{SEQUENCE.steps}
          </span>
        </div>

        <div className="sb-welcome__seq-reply">
          <StateLamp state="reply" word="Reply" dotOnly />
          <p className="sb-welcome__seq-quote">“{SEQUENCE.reply}”</p>
        </div>

        <div className="sb-welcome__seq-result">
          <span className="sb-welcome__state-chip">
            <span className="sb-welcome__state-chip-word">Paused</span>
            <span className="sb-welcome__state-chip-cause">reply</span>
          </span>
          <p className="sb-welcome__seq-note">Cadence paused before the next send was claimed.</p>
        </div>
      </div>
    </figure>
  );
}

function actParts(id: string): { icon: JSX.Element; vignette: JSX.Element } | null {
  switch (id) {
    case 'triage':
      return { icon: <InboxIcon size={15} />, vignette: <TriageVignette /> };
    case 'calling':
      return { icon: <PhoneIcon size={15} />, vignette: <CallingVignette /> };
    case 'sequences':
      return { icon: <RepeatIcon size={15} />, vignette: <SequenceVignette /> };
    default:
      return null;
  }
}

function FeatureAct({ act, flip }: { act: FeatureActCopy; flip: boolean }): JSX.Element | null {
  const parts = actParts(act.id);
  const { ref, revealed } = useReveal<HTMLElement>();
  if (!parts) return null;
  return (
    <article
      ref={ref}
      className={cx('sb-welcome__act', flip && 'is-flip')}
      data-reveal={revealed ? 'in' : 'out'}
    >
      <div className="sb-welcome__act-copy">
        <p className="sb-welcome__act-label">
          <span className="sb-welcome__act-icon">{parts.icon}</span>
          {act.label}
        </p>
        <h2 className="sb-welcome__act-title">{act.title}</h2>
        <p className="sb-welcome__act-body">
          {act.body[0]} {act.body[1]}
        </p>
      </div>
      <div className="sb-welcome__act-visual">
        <VisuallyHidden>{act.label} — example board</VisuallyHidden>
        {parts.vignette}
      </div>
    </article>
  );
}

export function FeatureActs(): JSX.Element {
  return (
    <section className="sb-welcome__acts" aria-label="What Switchboard does">
      {FEATURE_ACTS.map((act, i) => (
        <FeatureAct key={act.id} act={act} flip={i % 2 === 1} />
      ))}
    </section>
  );
}
