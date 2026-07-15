import { useMemo } from 'react';
import type { RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useKeyBindings } from '../keyboard/index.ts';
import type { KeyBindingDef } from '../keyboard/index.ts';
import { NAV_ITEMS } from './nav.ts';

interface ShellKeymapOptions {
  searchRef: RefObject<HTMLInputElement | null>;
  togglePalette: () => void;
  toggleCheatSheet: () => void;
}

/**
 * The shell's global keymap, registered through the keyboard registry so the
 * cheat sheet and inline hints stay in sync:
 *   - Cmd/Ctrl+K   command palette (works while typing)
 *   - ?            keyboard cheat sheet
 *   - /            focus global search
 *   - g <key>      jump to a route (chords derived from NAV_ITEMS)
 *   - Escape       clear focus from a field (while typing)
 */
export function useShellKeymap({
  searchRef,
  togglePalette,
  toggleCheatSheet,
}: ShellKeymapOptions): void {
  const navigate = useNavigate();

  const defs = useMemo<KeyBindingDef[]>(() => {
    const globals: KeyBindingDef[] = [
      {
        id: 'global:palette',
        combo: 'mod+k',
        scope: 'global',
        label: 'Command palette',
        group: 'Global',
        allowInInput: true,
        handler: togglePalette,
      },
      {
        id: 'global:cheatsheet',
        combo: '?',
        scope: 'global',
        label: 'Keyboard shortcuts',
        group: 'Global',
        handler: toggleCheatSheet,
      },
      {
        id: 'global:search',
        combo: '/',
        scope: 'global',
        label: 'Focus search',
        group: 'Global',
        handler: () => searchRef.current?.focus(),
      },
      {
        id: 'global:blur',
        combo: 'escape',
        scope: 'global',
        label: 'Clear focus',
        group: 'Global',
        allowInInput: true,
        hidden: true,
        preventDefault: false,
        handler: () => {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
        },
      },
    ];
    const chords: KeyBindingDef[] = NAV_ITEMS.map((item) => ({
      id: `nav-chord:${item.to}`,
      combo: `g ${item.key}`,
      scope: 'global',
      label: `Go to ${item.label}`,
      group: 'Navigate',
      handler: () => navigate(item.to),
    }));
    return [...globals, ...chords];
  }, [navigate, searchRef, togglePalette, toggleCheatSheet]);

  useKeyBindings(defs);
}
