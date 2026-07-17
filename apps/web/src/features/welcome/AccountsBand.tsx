import type { JSX } from 'react';
import { ACCOUNTS_BAND } from './copy.ts';

/*
 * The wordmark band under the hero — the logo-cloud slot, kept honest: these
 * are the demo dataset's own accounts set in the display face, not partner
 * logos we don't have. Typographic only (no images; the page law is all-live
 * DOM), achromatic, quiet.
 */
export function AccountsBand(): JSX.Element {
  return (
    <section className="sb-welcome__accounts" aria-label={ACCOUNTS_BAND.title}>
      <h2 className="sb-welcome__accounts-title">{ACCOUNTS_BAND.title}</h2>
      <ul className="sb-welcome__accounts-list">
        {ACCOUNTS_BAND.names.map((name) => (
          <li key={name} className="sb-welcome__accounts-item">
            {name}
          </li>
        ))}
      </ul>
    </section>
  );
}
