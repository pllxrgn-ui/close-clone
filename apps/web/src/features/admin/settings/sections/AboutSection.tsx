import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { VERSION } from '@switchboard/shared';
import { BoltIcon } from '../../../../ui/icons.tsx';
import { ExternalLinkIcon } from '../../icons.tsx';

/*
 * About — build info + a few honest stats, and a link to the /welcome tour. The
 * data-layer line reflects the runtime API mode so the demo build is legible.
 */

const API_MODE = import.meta.env.VITE_API_MODE === 'real' ? 'Live API' : 'Mock (MSW)';

const STATS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '5', label: 'Settings sections' },
  { value: '5', label: 'Bulk actions' },
  { value: '6', label: 'State lamps' },
  { value: '46', label: 'Admin surface checks' },
];

const BUILD_INFO: ReadonlyArray<{ term: string; value: string }> = [
  { term: 'Version', value: VERSION },
  { term: 'Design system', value: 'Operator Grid' },
  { term: 'Data layer', value: API_MODE },
  { term: 'Contract', value: 'CONTRACTS 1.2.0' },
];

export function AboutSection(): JSX.Element {
  return (
    <section className="admin-section" aria-labelledby="admin-about-title">
      <header className="admin-section__head">
        <h1 id="admin-about-title" className="admin-section__title">
          About Switchboard
        </h1>
        <p className="admin-section__desc">A communication-first CRM. Keyboard to the metal.</p>
      </header>

      <div className="admin-about">
        <dl className="admin-about__stats">
          {STATS.map((stat) => (
            <div key={stat.label} className="admin-stat">
              <dt className="admin-stat__label">{stat.label}</dt>
              <dd className="admin-stat__value">{stat.value}</dd>
            </div>
          ))}
        </dl>

        <dl className="admin-about__build">
          {BUILD_INFO.map((row) => (
            <div key={row.term} className="admin-about__build-row">
              <dt>{row.term}</dt>
              <dd className="admin-mono">{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="admin-about__cta">
          <Link to="/welcome" className="admin-about__link">
            <BoltIcon size={15} />
            Open the product tour
            <ExternalLinkIcon size={14} />
          </Link>
        </div>
      </div>
    </section>
  );
}
