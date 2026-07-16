import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Composer } from '../components/Composer.tsx';
import '../comms.css';

/*
 * App-level comms context: owns the email composer's open state and mounts the
 * drawer once, above the routes, so it can be summoned from the lead page seam
 * OR the command palette and survive route changes. Enrollment lives on the
 * sequences pages themselves (scoped state), so this provider stays composer-only.
 *
 * Wire at merge by wrapping the authenticated shell subtree (see routeWiring):
 *   <CommsProvider> … TopBar/LeftRail/main/CommandPalette … </CommsProvider>
 */

interface OpenOptions {
  leadId?: string | null;
  /** Keyboard-summoned (palette) opens instantly; pointer opens animate. */
  origin?: 'keyboard' | 'pointer';
}

interface CommsContextValue {
  openComposer: (opts?: OpenOptions) => void;
  closeComposer: () => void;
}

const CommsContext = createContext<CommsContextValue | null>(null);

interface ComposerState {
  leadId: string | null;
  instant: boolean;
}

export function CommsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [composer, setComposer] = useState<ComposerState | null>(null);

  const openComposer = useCallback((opts?: OpenOptions) => {
    setComposer({ leadId: opts?.leadId ?? null, instant: opts?.origin === 'keyboard' });
  }, []);
  const closeComposer = useCallback(() => setComposer(null), []);

  const value = useMemo<CommsContextValue>(
    () => ({ openComposer, closeComposer }),
    [openComposer, closeComposer],
  );

  return (
    <CommsContext.Provider value={value}>
      {children}
      <Composer
        open={composer !== null}
        onClose={closeComposer}
        leadId={composer?.leadId ?? null}
        instant={composer?.instant ?? false}
      />
    </CommsContext.Provider>
  );
}

/** Access the composer controls. Must be used within {@link CommsProvider}. */
export function useComms(): CommsContextValue {
  const ctx = useContext(CommsContext);
  if (!ctx) throw new Error('useComms must be used within a CommsProvider');
  return ctx;
}
