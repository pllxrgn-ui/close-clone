import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { KeyboardProvider } from './KeyboardProvider.tsx';
import { useKeyBindings } from './useKeyBindings.ts';
import { CheatSheet } from './CheatSheet.tsx';
import type { KeyBindingDef } from './types.ts';

afterEach(cleanup);

function Harness({ showExtra }: { showExtra: boolean }): ReactNode {
  const defs: KeyBindingDef[] = [
    {
      id: 'nav-leads',
      combo: 'g l',
      scope: 'global',
      label: 'Go to Leads',
      group: 'Navigate',
      handler: () => undefined,
    },
    { id: 'route-compose', combo: 'c', scope: 'route', label: 'Compose', handler: () => undefined },
    {
      id: 'hidden-down',
      combo: 'arrowdown',
      scope: 'list',
      label: 'Down',
      hidden: true,
      handler: () => undefined,
    },
    {
      id: 'inactive',
      combo: 'z',
      scope: 'route',
      label: 'Inactive here',
      when: () => false,
      handler: () => undefined,
    },
    ...(showExtra
      ? [
          {
            id: 'extra',
            combo: 'x',
            scope: 'route' as const,
            label: 'Extra action',
            handler: () => undefined,
          },
        ]
      : []),
  ];
  useKeyBindings(defs);
  return null;
}

function renderSheet(showExtra: boolean) {
  return render(
    <KeyboardProvider detectConflicts={false}>
      <Harness showExtra={showExtra} />
      <CheatSheet open onClose={() => undefined} />
    </KeyboardProvider>,
  );
}

describe('CheatSheet', () => {
  test('lists active bindings, grouped, with their key hints', async () => {
    renderSheet(false);
    expect(await screen.findByText('Go to Leads')).toBeInTheDocument();
    expect(screen.getByText('Compose')).toBeInTheDocument();

    // grouped by group/scope
    expect(screen.getByRole('heading', { name: 'Navigate' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'This page' })).toBeInTheDocument();

    // the sequence hint is rendered (screen-reader form)
    expect(screen.getByText('G then L')).toBeInTheDocument();
  });

  test('excludes hidden and guarded-inactive bindings', async () => {
    renderSheet(false);
    await screen.findByText('Go to Leads');
    expect(screen.queryByText('Down')).not.toBeInTheDocument();
    expect(screen.queryByText('Inactive here')).not.toBeInTheDocument();
  });

  test('reflects newly registered bindings dynamically', async () => {
    const { rerender } = renderSheet(false);
    await screen.findByText('Go to Leads');
    expect(screen.queryByText('Extra action')).not.toBeInTheDocument();

    rerender(
      <KeyboardProvider detectConflicts={false}>
        <Harness showExtra />
        <CheatSheet open onClose={() => undefined} />
      </KeyboardProvider>,
    );
    expect(await screen.findByText('Extra action')).toBeInTheDocument();
  });

  test('is a labelled modal dialog', async () => {
    renderSheet(false);
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});
