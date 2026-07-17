import type { JSX } from 'react';
import { BoardMark } from './icons.tsx';
import { TRIAGE_ROWS } from './fixtures.ts';
import { WORDMARK } from './copy.ts';

/*
 * The hero product frame: the triage queue rendered as live DOM inside a
 * perspective-tilted panel (rotateX + skew at desktop widths, flat on mobile),
 * fading out at its base like a photographed screen — except it's not a
 * screenshot: no <img>, both themes, crisp at any DPI. Decorative (the same
 * rows are narrated for AT inside the feature acts), so the whole frame is
 * aria-hidden.
 */
export function HeroFrame(): JSX.Element {
  return (
    <div className="sb-welcome__frame-wrap" aria-hidden="true">
      <div className="sb-welcome__frame-tilt">
        <div className="sb-welcome__frame">
          <div className="sb-welcome__frame-bar">
            <span className="sb-welcome__frame-brand">
              <BoardMark size={13} />
              {WORDMARK}
            </span>
            <span className="sb-welcome__frame-crumb">Inbox · 17 waiting</span>
            <span className="sb-welcome__frame-kbd">J / K</span>
          </div>
          <ul className="sb-welcome__frame-rows">
            {TRIAGE_ROWS.map((row) => (
              <li key={row.id} className="sb-welcome__frame-row">
                <span className={`sb-welcome__frame-dot sb-welcome__frame-dot--${row.state}`} />
                <span className="sb-welcome__frame-company">{row.company}</span>
                <span className="sb-welcome__frame-line">
                  {row.person} — {row.line}
                </span>
                <span className={`sb-welcome__frame-state sb-welcome__frame-state--${row.state}`}>
                  {row.stateWord}
                </span>
                <span className="sb-welcome__frame-time">{row.time}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
