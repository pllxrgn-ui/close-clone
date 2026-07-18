import { useMemo } from 'react';
import type { Command } from '../../command/commands.ts';
import { useAi } from './context/AiProvider.tsx';

/*
 * Palette command registration for the AI surface. Shaped to the existing `Command`
 * contract and reusing the existing Actions group (no new group). Wire at merge
 * exactly like the comms commands — fold into the palette's command pool so group
 * filtering picks it up (see routeWiring):
 *
 *   const staticCommands = [
 *     ...useStaticCommands(onClose),
 *     ...useCommsCommands(onClose),
 *     ...useAiCommands(onClose),
 *   ];
 *
 * Must run within AiProvider (for openSmartView), which wraps the shell once wired.
 */
export function useAiCommands(onRun: () => void): Command[] {
  const { openSmartView } = useAi();

  return useMemo<Command[]>(
    () => [
      {
        id: 'ai:smart-view',
        title: 'AI Smart View…',
        group: 'Actions',
        keywords: [
          'ai',
          'smart view',
          'natural language',
          'nl',
          'describe',
          'filter',
          'query',
          'segment',
        ],
        run: () => {
          openSmartView();
          onRun();
        },
      },
    ],
    [openSmartView, onRun],
  );
}
