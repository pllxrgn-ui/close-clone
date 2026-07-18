import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Command } from '../../command/commands.ts';
import { useToast } from '../../feedback/ToastProvider.tsx';
import { useCall } from './context/CallProvider.tsx';

/*
 * Palette command registrations for the calling surface. Shaped to the existing
 * `Command` contract, reusing the Actions/Navigate groups. Wire at merge exactly
 * like the comms commands — fold into the palette's command pool (see routeWiring):
 *
 *   const staticCommands = [...useStaticCommands(onClose), ..., ...useCallingCommands(onClose)];
 *
 * Must run within CallProvider (for the call controls) and a Router (navigate),
 * both of which already wrap the palette once the shell is wired.
 */
export function useCallingCommands(onRun: () => void): Command[] {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { focusTarget, startCall } = useCall();

  return useMemo<Command[]>(
    () => [
      {
        id: 'calling:call-lead',
        title: 'Call lead…',
        group: 'Actions',
        keywords: ['call', 'phone', 'dial', 'ring'],
        ...(focusTarget ? { subtitle: focusTarget.leadName } : {}),
        run: () => {
          if (focusTarget) {
            void startCall(focusTarget, { origin: 'keyboard' });
          } else {
            toast('Open a lead, then press C to call');
            navigate('/leads');
          }
          onRun();
        },
      },
      {
        id: 'calling:list-dialer',
        title: 'Start list dialer',
        group: 'Actions',
        keywords: ['dialer', 'call', 'power dial', 'sequential', 'queue'],
        run: () => {
          navigate('/dialer');
          onRun();
        },
      },
    ],
    [navigate, toast, focusTarget, startCall, onRun],
  );
}
