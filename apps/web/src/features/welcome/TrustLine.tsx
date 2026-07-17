import type { JSX } from 'react';
import { TRUST_LINE } from './copy.ts';

/*
 * The compliance trust line — small, mono, quiet. Each clause is a real rail the
 * engine enforces (CONTRACTS C6: recording consent, one-click unsubscribe, DNC).
 * Rendered as a list so the guarantees are individually legible and the dot
 * separators are decorative, not content.
 */
export function TrustLine(): JSX.Element {
  const clauses = TRUST_LINE.split(' · ');
  return (
    <aside id="welcome-trust" className="sb-welcome__trust" aria-label="Compliance guarantees">
      <ul className="sb-welcome__trust-list">
        {clauses.map((clause) => (
          <li key={clause} className="sb-welcome__trust-item">
            {clause}
          </li>
        ))}
      </ul>
    </aside>
  );
}
