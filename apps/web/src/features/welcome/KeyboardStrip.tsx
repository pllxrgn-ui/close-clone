import type { JSX } from 'react';
import { KbdCombo } from '../../keyboard/KbdCombo.tsx';
import { readableCombo } from '../../keyboard/combo.ts';
import { VisuallyHidden } from '../../ui/index.ts';
import { WELCOME_SHORTCUT_GROUPS } from './shortcuts.ts';
import { KEYBOARD } from './copy.ts';

/*
 * The app's real keyboard map, rendered as a design object. Combos come from
 * shortcuts.ts (derived from the live keymap + NAV_ITEMS) and render through the
 * SAME KbdCombo the ? cheat sheet uses, so the caps are identical to the running
 * app — key for key. Each row pairs a visible label + caps with a screen-reader
 * reading of the combo (readableCombo), matching the cheat sheet's a11y shape.
 */
export function KeyboardStrip(): JSX.Element {
  return (
    <section className="sb-welcome__keys" aria-label="Keyboard shortcuts">
      <div className="sb-welcome__keys-intro">
        <p className="sb-welcome__eyebrow">{KEYBOARD.label}</p>
        <h2 className="sb-welcome__keys-title">{KEYBOARD.title}</h2>
        <p className="sb-welcome__keys-sub">{KEYBOARD.sub}</p>
      </div>
      <div className="sb-welcome__keys-grid">
        {WELCOME_SHORTCUT_GROUPS.map((group) => (
          <section key={group.name} className="sb-welcome__keys-group">
            <h3 className="sb-welcome__keys-group-title">{group.name}</h3>
            <ul className="sb-welcome__keys-list">
              {group.items.map((item) => (
                <li key={item.combo} className="sb-welcome__keys-row">
                  <span className="sb-welcome__keys-label">{item.label}</span>
                  <span className="sb-welcome__keys-caps">
                    <VisuallyHidden>{readableCombo(item.combo)}</VisuallyHidden>
                    <KbdCombo combo={item.combo} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
