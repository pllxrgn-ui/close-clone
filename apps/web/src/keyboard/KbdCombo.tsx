import type { JSX } from 'react';
import { cx } from '../lib/cx.ts';
import { Kbd } from '../ui/Kbd.tsx';
import { comboToCapSteps } from './combo.ts';

/**
 * Renders a combo as key caps — the single hint renderer used by nav items,
 * palette rows, and the cheat sheet, so every shortcut hint derives from the
 * same canonical combo string. Decorative by default (aria-hidden); pair with a
 * screen-reader label at the call site where the shortcut needs to be announced.
 */
export function KbdCombo({ combo, className }: { combo: string; className?: string }): JSX.Element {
  const steps = comboToCapSteps(combo);
  return (
    <span className={cx('sb-kbdcombo', className)} aria-hidden="true">
      {steps.map((caps, stepIndex) => (
        <span className="sb-kbdcombo__step" key={stepIndex}>
          {stepIndex > 0 ? <span className="sb-kbdcombo__then">then</span> : null}
          {caps.map((cap, capIndex) => (
            <Kbd key={capIndex}>{cap}</Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
