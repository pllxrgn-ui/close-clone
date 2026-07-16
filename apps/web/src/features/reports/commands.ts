/*
 * Command-palette registrations for the reporting surface. Exported as a hook so
 * the palette can compose it beside its static commands (see routeWiring): each
 * entry deep-links a report family through the `?report=` param. Typed against
 * the palette's own `Command` contract so the shapes never drift.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Command } from '../../command/commands.ts';

const ENTRIES = [
  {
    key: 'activity',
    title: 'Reports: Activity',
    keywords: ['reports', 'activity', 'calls', 'emails', 'talk time'],
  },
  {
    key: 'funnel',
    title: 'Reports: Funnel',
    keywords: ['reports', 'funnel', 'pipeline', 'stages', 'won', 'lost'],
  },
  {
    key: 'sequences',
    title: 'Reports: Sequences',
    keywords: ['reports', 'sequences', 'reply rate', 'cadence'],
  },
] as const;

/** Palette commands that jump straight to a report family. */
export function useReportsCommands(onRun: () => void): Command[] {
  const navigate = useNavigate();
  return useMemo(
    () =>
      ENTRIES.map((entry) => ({
        id: `reports:${entry.key}`,
        title: entry.title,
        group: 'Navigate' as const,
        keywords: [...entry.keywords],
        run: () => {
          navigate(`/reports?report=${entry.key}`);
          onRun();
        },
      })),
    [navigate, onRun],
  );
}
