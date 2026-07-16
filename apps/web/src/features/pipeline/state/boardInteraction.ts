/*
 * A tiny module-scope bridge between the board and the global command palette.
 *
 * The command palette (Cmd/Ctrl+K) is mounted app-wide and has no seam for a
 * feature to inject commands that act on in-board state. So the board publishes
 * its currently-focused deal here, and registers a "mover" the palette commands
 * can invoke. When no deal is focused (or the board isn't mounted) there is no
 * active opp, so `usePipelineCommands` returns nothing — the palette never shows
 * a command that would no-op.
 */

export type MoveDir = 'prev' | 'next' | 'won' | 'lost';

export interface ActiveOpp {
  id: string;
  /** Human label for the command title (the lead/company name). */
  label: string;
}

let active: ActiveOpp | null = null;
let mover: ((dir: MoveDir) => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeActiveOpp(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveOpp(): ActiveOpp | null {
  return active;
}

/** Publish the focused deal. No-ops (keeps the snapshot stable) if unchanged. */
export function setActiveOpp(next: ActiveOpp | null): void {
  if (active?.id === next?.id && active?.label === next?.label) return;
  active = next;
  emit();
}

/** The board installs the function that actually performs a move. */
export function registerMover(fn: (dir: MoveDir) => void): () => void {
  mover = fn;
  return () => {
    if (mover === fn) mover = null;
  };
}

export function runMove(dir: MoveDir): void {
  mover?.(dir);
}
