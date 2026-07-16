/*
 * Theme model. Three choices: 'light' | 'dark' | 'system'. 'system' removes the
 * [data-theme] attribute so the prefers-color-scheme media query in tokens.css
 * decides; 'light'/'dark' stamp the attribute and win over the media query. The
 * choice is persisted to localStorage under `sb-theme` (an inline bootstrap in
 * index.html reads the same key to avoid a flash before React mounts).
 */

export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'sb-theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readStoredChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(raw) ? raw : 'system';
  } catch {
    /* localStorage unavailable (private mode / SSR) */
    return 'system';
  }
}

export function storeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    }
  } catch {
    /* ignore persistence failures */
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') {
    return systemPrefersDark() ? 'dark' : 'light';
  }
  return choice;
}

/** Reflect the choice onto <html> so tokens.css can react. */
export function applyThemeAttribute(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
}

/** Cycle order used by the toolbar toggle: light → dark → system → light. */
export function nextChoice(choice: ThemeChoice): ThemeChoice {
  return choice === 'light' ? 'dark' : choice === 'dark' ? 'system' : 'light';
}
