import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { JSX } from 'react';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../mocks/server.ts';
import { aiHandlers } from './mocks/aiHandlers.ts';
import { AiProvider } from './context/AiProvider.tsx';
import { useAiCommands } from './commands.ts';
import { renderAi } from './test/harness.tsx';

/*
 * The palette command surfaces the NL→Smart View modal. It must run within
 * AiProvider (which owns the modal) — the wiring the orchestrator performs at merge.
 */

function CommandRunner(): JSX.Element {
  const commands = useAiCommands(() => {});
  return (
    <>
      {commands.map((c) => (
        <button key={c.id} type="button" onClick={c.run}>
          {c.title}
        </button>
      ))}
    </>
  );
}

beforeEach(() => server.use(...aiHandlers));
afterEach(() => cleanup());

describe('useAiCommands', () => {
  test('exposes an "AI Smart View…" command that opens the modal', async () => {
    const user = userEvent.setup();
    renderAi(
      <AiProvider>
        <CommandRunner />
      </AiProvider>,
    );

    // The modal is not open until the command runs.
    expect(screen.queryByRole('dialog', { name: /ask ai for a smart view/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /ai smart view/i }));

    expect(
      await screen.findByRole('dialog', { name: /ask ai for a smart view/i }),
    ).toBeInTheDocument();
  });
});
