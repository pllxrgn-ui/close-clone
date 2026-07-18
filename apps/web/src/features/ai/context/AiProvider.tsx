import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { AiSmartViewModal } from '../components/AiSmartViewModal.tsx';
import '../ai.css';

/*
 * App-level AI context: owns the NL→Smart View modal's open state and mounts it once,
 * above the routes, so it can be summoned from the command palette (or a builder
 * button) and survive route changes. Mirrors features/comms CommsProvider.
 *
 * Wire at merge by wrapping the authenticated shell subtree (see routeWiring):
 *   <AiProvider> … TopBar/LeftRail/main/CommandPalette … </AiProvider>
 */

interface AiContextValue {
  /** Open the "Ask AI for a Smart View" modal. */
  openSmartView: () => void;
  /** Close it. */
  closeSmartView: () => void;
}

const AiContext = createContext<AiContextValue | null>(null);

export function AiProvider({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const openSmartView = useCallback(() => setOpen(true), []);
  const closeSmartView = useCallback(() => setOpen(false), []);

  const value = useMemo<AiContextValue>(
    () => ({ openSmartView, closeSmartView }),
    [openSmartView, closeSmartView],
  );

  return (
    <AiContext.Provider value={value}>
      {children}
      <AiSmartViewModal open={open} onClose={closeSmartView} />
    </AiContext.Provider>
  );
}

/** Access the AI modal controls. Must be used within {@link AiProvider}. */
export function useAi(): AiContextValue {
  const ctx = useContext(AiContext);
  if (!ctx) throw new Error('useAi must be used within an AiProvider');
  return ctx;
}
