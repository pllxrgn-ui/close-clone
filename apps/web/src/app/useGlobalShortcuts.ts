import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_CHORD_KEYS } from './nav.ts';

const CHORD_WINDOW_MS = 900;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/*
 * Keyboard-first global shortcuts (build guide: every action reachable without
 * the mouse):
 *   "/"            focus global search
 *   "g" then i/l/v/r/s   navigate to Inbox/Leads/Views/Reports/Settings
 *   Escape (while typing)  blur the field
 * Chords are ignored while the user is typing in a field.
 */
export function useGlobalShortcuts(searchRef: RefObject<HTMLInputElement | null>): void {
  const navigate = useNavigate();

  useEffect(() => {
    let lastG = 0;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (isTypingTarget(event.target)) {
        if (event.key === 'Escape' && event.target instanceof HTMLElement) {
          event.target.blur();
        }
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (event.key === 'g') {
        lastG = Date.now();
        return;
      }

      const dest = NAV_CHORD_KEYS[event.key];
      if (dest && Date.now() - lastG < CHORD_WINDOW_MS) {
        event.preventDefault();
        lastG = 0;
        navigate(dest);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, searchRef]);
}
