import { beforeEach, describe, expect, test } from 'vitest';
import type { JSX } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  applyThemeAttribute,
  isThemeChoice,
  nextChoice,
  readStoredChoice,
  resolveTheme,
  storeChoice,
  THEME_STORAGE_KEY,
} from './theme.ts';
import { ThemeProvider, useTheme } from './ThemeProvider.tsx';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme logic', () => {
  test('defaults to system when unset', () => {
    expect(readStoredChoice()).toBe('system');
  });

  test('persists a concrete choice and clears for system', () => {
    storeChoice('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredChoice()).toBe('dark');
    storeChoice('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readStoredChoice()).toBe('system');
  });

  test('ignores a corrupt stored value (failure path)', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse');
    expect(readStoredChoice()).toBe('system');
    expect(isThemeChoice('chartreuse')).toBe(false);
  });

  test('applyThemeAttribute stamps or removes data-theme', () => {
    applyThemeAttribute('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyThemeAttribute('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('resolveTheme maps system via matchMedia (stub: light)', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('system')).toBe('light');
  });

  test('nextChoice cycles light -> dark -> system -> light', () => {
    expect(nextChoice('light')).toBe('dark');
    expect(nextChoice('dark')).toBe('system');
    expect(nextChoice('system')).toBe('light');
  });
});

function Probe(): JSX.Element {
  const { choice, resolved, cycle } = useTheme();
  return (
    <button type="button" onClick={cycle}>
      {choice}:{resolved}
    </button>
  );
}

describe('ThemeProvider', () => {
  test('cycles the choice and reflects it onto <html>', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    // starts at system (no attribute)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    const btn = screen.getByRole('button');
    expect(btn).toHaveTextContent('system:light');

    await userEvent.click(btn); // system -> light
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(btn).toHaveTextContent('light:light');

    await userEvent.click(btn); // light -> dark
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn).toHaveTextContent('dark:dark');
  });

  // failure path: the hook must guard against use outside the provider
  test('useTheme throws outside a provider', () => {
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
  });
});
