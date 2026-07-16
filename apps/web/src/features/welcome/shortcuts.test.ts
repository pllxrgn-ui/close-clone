import { describe, expect, test } from 'vitest';
import { NAV_ITEMS } from '../../app/nav.tsx';
import { comboToCapSteps } from '../../keyboard/combo.ts';
import { WELCOME_SHORTCUT_GROUPS } from './shortcuts.ts';

describe('welcome shortcut map', () => {
  test('exposes the real global combos', () => {
    const combos = WELCOME_SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.combo));
    expect(combos).toContain('mod+k');
    expect(combos).toContain('?');
    expect(combos).toContain('/');
    expect(combos).toContain('j');
    expect(combos).toContain('k');
    expect(combos).toContain('enter');
  });

  test('the Navigate group is derived from NAV_ITEMS and cannot drift', () => {
    const navigate = WELCOME_SHORTCUT_GROUPS.find((g) => g.name === 'Navigate');
    expect(navigate).toBeDefined();
    expect(navigate?.items).toEqual(
      NAV_ITEMS.map((item) => ({ label: item.label, combo: `g ${item.key}` })),
    );
  });

  test('every combo renders to at least one key cap', () => {
    for (const group of WELCOME_SHORTCUT_GROUPS) {
      for (const item of group.items) {
        const steps = comboToCapSteps(item.combo);
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.every((step) => step.length > 0)).toBe(true);
      }
    }
  });
});
