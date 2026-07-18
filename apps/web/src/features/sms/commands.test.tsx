import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { JSX } from 'react';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../mocks/server.ts';
import { resetSmsStore } from './data/store.ts';
import { smsHandlers } from './mocks/smsHandlers.ts';
import { SmsProvider } from './context/SmsProvider.tsx';
import { useSmsCommands } from './commands.ts';
import { renderSms } from './test/harness.tsx';

/*
 * The keyboard paths into the SMS surface: the palette "Text lead…" command and the
 * global `t` shortcut both open the conversation drawer on its lead-picker step.
 */

function CommandRunner(): JSX.Element {
  const commands = useSmsCommands(() => {});
  return (
    <button type="button" onClick={() => commands[0]?.run()}>
      run-text-command
    </button>
  );
}

beforeEach(() => {
  resetSmsStore();
  server.use(...smsHandlers);
});
afterEach(cleanup);

describe('SMS keyboard entry points', () => {
  test('the palette "Text lead…" command opens the picker', async () => {
    const user = userEvent.setup();
    renderSms(
      <SmsProvider>
        <CommandRunner />
      </SmsProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'run-text-command' }));
    expect(await screen.findByLabelText('Search leads')).toBeInTheDocument();
  });

  test('the global "t" shortcut opens the picker', async () => {
    const user = userEvent.setup();
    renderSms(
      <SmsProvider>
        <div>shell</div>
      </SmsProvider>,
    );

    await user.keyboard('t');
    expect(await screen.findByLabelText('Search leads')).toBeInTheDocument();
  });
});
