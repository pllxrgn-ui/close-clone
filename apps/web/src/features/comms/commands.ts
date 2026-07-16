import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Command } from '../../command/commands.ts';
import { useComms } from './context/CommsProvider.tsx';

/*
 * Palette command registrations for the comms surface. Shaped to the existing
 * `Command` contract and reusing the existing Actions/Navigate groups (no new
 * group needed). Wire at merge exactly like the static commands — fold into the
 * palette's command pool so group filtering picks them up (see routeWiring):
 *
 *   const staticCommands = [...useStaticCommands(onClose), ...useCommsCommands(onClose)];
 *
 * Must run within CommsProvider (for openComposer) and a Router (for navigate),
 * both of which already wrap the palette once the shell is wired.
 */
export function useCommsCommands(onRun: () => void): Command[] {
  const navigate = useNavigate();
  const { openComposer } = useComms();

  return useMemo<Command[]>(
    () => [
      {
        id: 'comms:email-lead',
        title: 'Email lead…',
        group: 'Actions',
        keywords: ['email', 'compose', 'message', 'write', 'send', 'mail'],
        run: () => {
          openComposer({ origin: 'keyboard' });
          onRun();
        },
      },
      {
        id: 'comms:sequences',
        title: 'Open sequences',
        group: 'Navigate',
        keywords: ['sequence', 'sequences', 'cadence', 'outreach', 'drip'],
        run: () => {
          navigate('/sequences');
          onRun();
        },
      },
      {
        id: 'comms:enroll',
        title: 'Enroll in sequence…',
        group: 'Actions',
        keywords: ['sequence', 'enroll', 'cadence', 'outreach', 'drip'],
        run: () => {
          navigate('/sequences');
          onRun();
        },
      },
    ],
    [navigate, openComposer, onRun],
  );
}
