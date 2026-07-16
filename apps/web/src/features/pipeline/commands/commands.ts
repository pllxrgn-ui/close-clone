import { useMemo, useSyncExternalStore } from 'react';
import type { Command } from '../../../command/index.ts';
import { getActiveOpp, runMove, subscribeActiveOpp } from '../state/boardInteraction.ts';
import type { MoveDir } from '../state/boardInteraction.ts';

/*
 * Palette commands for the pipeline surface. They act on the board's currently
 * focused deal and are present ONLY while one is focused, so the palette never
 * offers a command that would do nothing. Wired into the palette at merge — see
 * this feature's routeWiring — mirroring how the keyboard registry auto-collects
 * the board's shortcuts.
 */

interface Spec {
  dir: MoveDir;
  verb: string;
  keywords: string[];
}

const SPECS: readonly Spec[] = [
  { dir: 'next', verb: 'Advance', keywords: ['stage', 'forward', 'progress', 'next'] },
  { dir: 'prev', verb: 'Move back', keywords: ['stage', 'back', 'regress', 'previous'] },
  { dir: 'won', verb: 'Mark won', keywords: ['won', 'close', 'win', 'deal'] },
  { dir: 'lost', verb: 'Mark lost', keywords: ['lost', 'close', 'lose', 'deal'] },
];

/**
 * Commands for the focused deal. `onRun` (the palette's close callback) fires
 * after each. Returns [] when no deal is focused.
 */
export function usePipelineCommands(onRun: () => void): Command[] {
  const active = useSyncExternalStore(subscribeActiveOpp, getActiveOpp, getActiveOpp);
  return useMemo(() => {
    if (!active) return [];
    return SPECS.map((spec) => ({
      id: `pipeline:${spec.dir}`,
      title: `${spec.verb}: ${active.label}`,
      group: 'Actions' as const,
      keywords: ['pipeline', 'opportunity', ...spec.keywords],
      run: () => {
        runMove(spec.dir);
        onRun();
      },
    }));
  }, [active, onRun]);
}
