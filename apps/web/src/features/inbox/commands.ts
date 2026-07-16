import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Command } from '../../command/index.ts';

/*
 * Command-palette (⌘K) contribution for the Inbox. These are keyword-rich
 * entry-points into the triage queue — typing "reply", "overdue" or "triage"
 * jumps straight to /inbox where those live. The row-level verbs (reply, complete,
 * approve, skip, snooze) are registered in the keyboard shortcut registry instead
 * (they need a selected row), and surface in the `?` cheat sheet.
 *
 * The orchestrator wires this at merge by spreading `useInboxCommands(onClose)`
 * into the palette's command list (see routeWiring); nothing self-registers,
 * because command/commands.ts is owned by the shell.
 */
export function useInboxCommands(onRun: () => void): Command[] {
  const navigate = useNavigate();
  return useMemo(() => {
    const go = (): void => {
      navigate('/inbox');
      onRun();
    };
    const base: Array<Pick<Command, 'id' | 'title' | 'keywords'>> = [
      {
        id: 'inbox:triage',
        title: 'Triage inbox',
        keywords: ['inbox', 'triage', 'queue', 'needs you now', 'home'],
      },
      {
        id: 'inbox:replies',
        title: 'Answer replies',
        keywords: ['reply', 'replies', 'inbound', 'respond', 'messages', 'unanswered'],
      },
      {
        id: 'inbox:overdue',
        title: 'Clear overdue tasks',
        keywords: ['overdue', 'due', 'tasks', 'follow-ups', 'sla'],
      },
    ];
    return base.map((entry) => ({ ...entry, group: 'Actions' as const, run: go }));
  }, [navigate, onRun]);
}
