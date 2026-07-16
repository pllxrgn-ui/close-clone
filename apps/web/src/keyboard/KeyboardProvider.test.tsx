import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { KeyboardProvider } from './KeyboardProvider.tsx';
import { useKeyBindings } from './useKeyBindings.ts';
import type { KeyBindingDef } from './types.ts';

afterEach(cleanup);

function Bindings({ defs }: { defs: KeyBindingDef[] }): ReactNode {
  useKeyBindings(defs);
  return null;
}

describe('KeyboardProvider dispatch', () => {
  test('fires a global binding on its combo and calls preventDefault', async () => {
    let prevented = false;
    const handler = vi.fn((e: KeyboardEvent) => {
      prevented = e.defaultPrevented;
    });
    render(
      <KeyboardProvider>
        <Bindings
          defs={[{ id: 'palette', combo: 'mod+k', scope: 'global', label: 'Palette', handler }]}
        />
      </KeyboardProvider>,
    );

    await userEvent.keyboard('{Control>}k{/Control}');
    expect(handler).toHaveBeenCalledOnce();
    expect(prevented).toBe(true);
  });

  test('does not fire an unregistered combo', async () => {
    const handler = vi.fn();
    render(
      <KeyboardProvider>
        <Bindings defs={[{ id: 'j', combo: 'j', scope: 'global', label: 'J', handler }]} />
      </KeyboardProvider>,
    );
    await userEvent.keyboard('x');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('input guard', () => {
  function InputProbe({ defs }: { defs: KeyBindingDef[] }): ReactNode {
    useKeyBindings(defs);
    return <input aria-label="field" />;
  }

  test('ignores a non-global binding while typing in a field', async () => {
    const handler = vi.fn();
    render(
      <KeyboardProvider>
        <InputProbe
          defs={[{ id: 'slash', combo: '/', scope: 'global', label: 'Search', handler }]}
        />
      </KeyboardProvider>,
    );
    await userEvent.click(screen.getByLabelText('field'));
    await userEvent.keyboard('/');
    expect(handler).not.toHaveBeenCalled();
    // still typed into the field
    expect(screen.getByLabelText('field')).toHaveValue('/');
  });

  test('fires an allowInInput binding even while typing', async () => {
    const handler = vi.fn();
    render(
      <KeyboardProvider>
        <InputProbe
          defs={[
            {
              id: 'esc',
              combo: 'escape',
              scope: 'global',
              label: 'Blur',
              allowInInput: true,
              handler,
            },
          ]}
        />
      </KeyboardProvider>,
    );
    await userEvent.click(screen.getByLabelText('field'));
    await userEvent.keyboard('{Escape}');
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('scope shadowing', () => {
  function ShadowProbe(): ReactNode {
    const [listActive, setListActive] = useState(false);
    const globalHandler = vi.fn();
    const listHandler = vi.fn();
    // expose the mocks + toggle through the DOM for the test
    return (
      <>
        <Bindings
          defs={[
            {
              id: 'g-x',
              combo: 'x',
              scope: 'global',
              label: 'global x',
              handler: () => {
                globalCalls.push('global');
                globalHandler();
              },
            },
            {
              id: 'l-x',
              combo: 'x',
              scope: 'list',
              label: 'list x',
              when: () => listActive,
              handler: () => {
                globalCalls.push('list');
                listHandler();
              },
            },
          ]}
        />
        <button type="button" onClick={() => setListActive((v) => !v)}>
          toggle
        </button>
      </>
    );
  }

  const globalCalls: string[] = [];

  test('the most specific active scope wins; the shadowed one wins when it is inert', async () => {
    globalCalls.length = 0;
    render(
      <KeyboardProvider>
        <ShadowProbe />
      </KeyboardProvider>,
    );

    // list scope inert (when=false) → global handles x
    await userEvent.keyboard('x');
    expect(globalCalls).toEqual(['global']);

    // activate the list scope → it now shadows global for x
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await userEvent.keyboard('x');
    expect(globalCalls).toEqual(['global', 'list']);
  });
});

describe('sequences (chords)', () => {
  test('completes a two-step sequence', async () => {
    const handler = vi.fn();
    render(
      <KeyboardProvider>
        <Bindings
          defs={[{ id: 'go-leads', combo: 'g l', scope: 'global', label: 'Go leads', handler }]}
        />
      </KeyboardProvider>,
    );
    await userEvent.keyboard('gl');
    expect(handler).toHaveBeenCalledOnce();
  });

  test('a wrong second key cancels the sequence without firing', async () => {
    const handler = vi.fn();
    render(
      <KeyboardProvider>
        <Bindings
          defs={[{ id: 'go-leads', combo: 'g l', scope: 'global', label: 'Go leads', handler }]}
        />
      </KeyboardProvider>,
    );
    await userEvent.keyboard('gx');
    expect(handler).not.toHaveBeenCalled();
  });

  test('the sequence expires after the timeout window', async () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    const handler = vi.fn();
    render(
      <KeyboardProvider>
        <Bindings
          defs={[{ id: 'go-leads', combo: 'g l', scope: 'global', label: 'Go leads', handler }]}
        />
      </KeyboardProvider>,
    );
    now.mockReturnValue(0);
    await userEvent.keyboard('g');
    now.mockReturnValue(5000); // well past SEQUENCE_TIMEOUT_MS
    await userEvent.keyboard('l');
    expect(handler).not.toHaveBeenCalled();
    now.mockRestore();
  });
});

describe('conflict detection', () => {
  test('warns on a duplicate combo+scope registration in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <KeyboardProvider detectConflicts>
        <Bindings
          defs={[
            { id: 'a', combo: 'mod+k', scope: 'global', label: 'A', handler: () => undefined },
            { id: 'b', combo: 'mod+k', scope: 'global', label: 'B', handler: () => undefined },
          ]}
        />
      </KeyboardProvider>,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('conflict'));
    warn.mockRestore();
  });

  test('stays silent when conflict detection is disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <KeyboardProvider detectConflicts={false}>
        <Bindings
          defs={[
            { id: 'a', combo: 'mod+k', scope: 'global', label: 'A', handler: () => undefined },
            { id: 'b', combo: 'mod+k', scope: 'global', label: 'B', handler: () => undefined },
          ]}
        />
      </KeyboardProvider>,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('unregister', () => {
  test('an unmounted binding no longer fires', async () => {
    const handler = vi.fn();

    function Toggle(): ReactNode {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          {mounted ? (
            <Bindings defs={[{ id: 'j', combo: 'j', scope: 'global', label: 'J', handler }]} />
          ) : null}
          <button type="button" onClick={() => setMounted(false)}>
            unmount
          </button>
        </>
      );
    }

    render(
      <KeyboardProvider>
        <Toggle />
      </KeyboardProvider>,
    );

    await userEvent.keyboard('j');
    expect(handler).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: 'unmount' }));
    await userEvent.keyboard('j');
    expect(handler).toHaveBeenCalledOnce(); // no further calls
  });
});
