import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-sans-condensed/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './welcome-tokens.css';
import './welcome.css';

import type { JSX } from 'react';
import { WelcomeNav } from './WelcomeNav.tsx';
import { Hero } from './Hero.tsx';
import { FeatureActs } from './FeatureActs.tsx';
import { KeyboardStrip } from './KeyboardStrip.tsx';
import { TrustLine } from './TrustLine.tsx';
import { FooterCta } from './FooterCta.tsx';
import { useIgnition } from './useIgnition.ts';

/*
 * Switchboard's front door at /welcome (unauthenticated). Both CTAs and the nav
 * sign-in route to the dev-login gate. The page is all live DOM — no images, no
 * screenshots — and its only choreography is the hero board-ignition, which
 * plays once per session and collapses to instant under reduced motion.
 */
export function WelcomePage(): JSX.Element {
  const ignition = useIgnition();
  return (
    <div className="sb-welcome">
      <a className="sb-welcome__skip" href="#welcome-main">
        Skip to content
      </a>
      <WelcomeNav />
      <main id="welcome-main" className="sb-welcome__main">
        <Hero ignition={ignition} />
        <FeatureActs />
        <KeyboardStrip />
      </main>
      <TrustLine />
      <FooterCta />
    </div>
  );
}
