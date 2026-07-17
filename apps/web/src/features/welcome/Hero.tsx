import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { StateLamp } from './StateLamp.tsx';
import { HeroFrame } from './HeroFrame.tsx';
import { HERO_LAMPS } from './fixtures.ts';
import { HERO, HERO_STATS, LOGIN_PATH } from './copy.ts';
import type { IgnitionState } from './useIgnition.ts';

/*
 * The hero board, centered: lamps → headline → sub → CTA → stats, then the
 * perspective-tilted product frame. When `ignition === 'igniting'` the CSS
 * entrance plays once: the etched grid fades in, the six lamps ignite in a
 * 30–80ms stagger, the headline sets, and the frame surfaces last — ≤800ms
 * total. When `'lit'` (reduced motion, or already ignited this session)
 * everything renders in its final state instantly. The data-ignite attribute
 * is the only switch; there is no JS timeline.
 */
export function Hero({ ignition }: { ignition: IgnitionState }): JSX.Element {
  return (
    <header className="sb-welcome__hero" data-ignite={ignition}>
      <div className="sb-welcome__hero-grid" aria-hidden="true" />
      <div className="sb-welcome__hero-inner">
        <ul className="sb-welcome__lamps" aria-label="Lead states, at a glance">
          {HERO_LAMPS.map((lamp, i) => (
            <li key={lamp.key} className="sb-welcome__lamps-item">
              <StateLamp state={lamp.key} word={lamp.word} index={i} />
            </li>
          ))}
        </ul>

        <h1 className="sb-welcome__headline">
          {HERO.headline.map((line) => (
            <span key={line} className="sb-welcome__headline-line">
              {line}
            </span>
          ))}
        </h1>

        <p className="sb-welcome__sub">{HERO.sub}</p>

        <div className="sb-welcome__cta-row">
          <Link to={LOGIN_PATH} className="sb-welcome__cta">
            {HERO.cta}
            <span className="sb-welcome__cta-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        </div>

        <ul className="sb-welcome__stats">
          {HERO_STATS.map((stat) => (
            <li key={stat.label} className="sb-welcome__stat">
              <span className="sb-welcome__stat-value">{stat.value}</span>
              <span className="sb-welcome__stat-label">{stat.label}</span>
            </li>
          ))}
        </ul>

        <HeroFrame />
      </div>
    </header>
  );
}
