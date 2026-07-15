import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import {
  applyThemeAttribute,
  nextChoice,
  readStoredChoice,
  resolveTheme,
  storeChoice,
  type ResolvedTheme,
  type ThemeChoice,
} from './theme.ts';

interface ThemeContextValue {
  /** The user's selection: light, dark, or follow-system. */
  choice: ThemeChoice;
  /** The concrete theme actually rendered (system resolved against the OS). */
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
  /** Advance light → dark → system → light. */
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readStoredChoice());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(choice));

  // Reflect the choice onto <html> and recompute the resolved theme.
  useEffect(() => {
    applyThemeAttribute(choice);
    setResolved(resolveTheme(choice));
  }, [choice]);

  // While following the system, track live OS theme changes.
  useEffect(() => {
    if (choice !== 'system') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setResolved(mql.matches ? 'dark' : 'light');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    storeChoice(next);
    setChoiceState(next);
  }, []);

  const cycle = useCallback(() => {
    setChoiceState((prev) => {
      const next = nextChoice(prev);
      storeChoice(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ choice, resolved, setChoice, cycle }),
    [choice, resolved, setChoice, cycle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
