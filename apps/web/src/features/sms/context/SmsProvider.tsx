import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { useKeyBindings } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';
import { SmsConversationDrawer } from '../components/SmsConversationDrawer.tsx';
import '../sms.css';

/*
 * App-level SMS context: owns the conversation drawer's open state and mounts the
 * drawer once, above the routes, so it can be summoned from the lead-page seam, the
 * command palette, or the keyboard shortcut and survive route changes.
 *
 * It also registers the global `t` shortcut through the keyboard registry, so it
 * appears in the `?` cheat sheet automatically (no app-file edit needed). Wire at
 * merge by wrapping the authenticated shell subtree, INSIDE the KeyboardProvider
 * (see routeWiring):
 *   <KeyboardProvider> … <SmsProvider> … shell … </SmsProvider> … </KeyboardProvider>
 */

interface OpenOptions {
  leadId?: string | null;
  /** Keyboard-summoned (palette / shortcut) opens instantly; pointer animates. */
  origin?: 'keyboard' | 'pointer';
}

interface SmsContextValue {
  openThread: (opts?: OpenOptions) => void;
  closeThread: () => void;
}

const SmsContext = createContext<SmsContextValue | null>(null);

interface DrawerState {
  leadId: string | null;
  instant: boolean;
}

export function SmsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  const openThread = useCallback((opts?: OpenOptions) => {
    setDrawer({ leadId: opts?.leadId ?? null, instant: opts?.origin === 'keyboard' });
  }, []);
  const closeThread = useCallback(() => setDrawer(null), []);

  // Global shortcut: `t` opens the "Text lead…" picker (keyboard → instant). Not
  // active while typing (allowInInput defaults false), so it never eats a keystroke.
  const bindings = useMemo<KeyBindingDef[]>(
    () => [
      {
        id: 'sms:text-lead',
        combo: 't',
        scope: 'global',
        label: 'Text a lead',
        group: 'Actions',
        handler: () => setDrawer({ leadId: null, instant: true }),
      },
    ],
    [],
  );
  useKeyBindings(bindings);

  const value = useMemo<SmsContextValue>(
    () => ({ openThread, closeThread }),
    [openThread, closeThread],
  );

  return (
    <SmsContext.Provider value={value}>
      {children}
      <SmsConversationDrawer
        open={drawer !== null}
        onClose={closeThread}
        leadId={drawer?.leadId ?? null}
        instant={drawer?.instant ?? false}
      />
    </SmsContext.Provider>
  );
}

/** Access the SMS drawer controls. Must be used within {@link SmsProvider}. */
export function useSms(): SmsContextValue {
  const ctx = useContext(SmsContext);
  if (!ctx) throw new Error('useSms must be used within an SmsProvider');
  return ctx;
}
