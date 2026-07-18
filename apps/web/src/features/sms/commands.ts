import { useMemo } from 'react';
import type { Command } from '../../command/commands.ts';
import { useSms } from './context/SmsProvider.tsx';

/*
 * Palette command registration for the SMS surface. Shaped to the existing `Command`
 * contract and reusing the existing Actions group (no new group). Wire at merge like
 * the other feature commands — fold into the palette's command pool (see routeWiring):
 *
 *   const staticCommands = [...useStaticCommands(onClose), ...useSmsCommands(onClose)];
 *
 * Must run within SmsProvider (for openThread).
 */
export function useSmsCommands(onRun: () => void): Command[] {
  const { openThread } = useSms();

  return useMemo<Command[]>(
    () => [
      {
        id: 'sms:text-lead',
        title: 'Text lead…',
        group: 'Actions',
        keywords: ['sms', 'text', 'message', 'txt', 'send text', 'two-way'],
        run: () => {
          openThread({ origin: 'keyboard' });
          onRun();
        },
      },
    ],
    [openThread, onRun],
  );
}
