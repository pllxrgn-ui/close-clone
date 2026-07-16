import { NAV_ITEMS } from '../../app/nav.ts';

/*
 * The landing page renders the app's REAL keyboard map as a design object — no
 * invented shortcuts. Every combo here is the exact canonical token dispatched
 * by the running app:
 *   - the globals mirror useShellKeymap ('mod+k', '?', '/')
 *   - the Navigate chords are DERIVED from NAV_ITEMS (`g <key>`), the same source
 *     useShellKeymap builds its `g <key>` chords from — so this strip can never
 *     drift from the nav
 *   - the list moves mirror useListNav ('j' / 'k' / 'enter')
 * The combo strings feed the same comboToCapSteps/readableCombo renderers the
 * live cheat sheet uses (KbdCombo), so the caps match key-for-key.
 */

export interface WelcomeShortcut {
  label: string;
  /** Canonical combo token (see keyboard/combo.ts). */
  combo: string;
}

export interface WelcomeShortcutGroup {
  name: string;
  items: readonly WelcomeShortcut[];
}

const COMMAND_GROUP: WelcomeShortcutGroup = {
  name: 'Command',
  items: [
    { label: 'Command palette', combo: 'mod+k' },
    { label: 'Keyboard shortcuts', combo: '?' },
    { label: 'Jump to search', combo: '/' },
  ],
};

const NAVIGATE_GROUP: WelcomeShortcutGroup = {
  name: 'Navigate',
  items: NAV_ITEMS.map((item) => ({ label: item.label, combo: `g ${item.key}` })),
};

const LIST_GROUP: WelcomeShortcutGroup = {
  name: 'Work the list',
  items: [
    { label: 'Next item', combo: 'j' },
    { label: 'Previous item', combo: 'k' },
    { label: 'Open item', combo: 'enter' },
  ],
};

export const WELCOME_SHORTCUT_GROUPS: readonly WelcomeShortcutGroup[] = [
  COMMAND_GROUP,
  NAVIGATE_GROUP,
  LIST_GROUP,
];
