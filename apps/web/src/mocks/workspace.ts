import type { Activity, Contact, Lead, Opportunity, SmartView } from '@switchboard/shared';

/*
 * Workspace mode for the mock demo. `sample` (default) boots the full seeded
 * org; `blank` boots an EMPTY org — same users/statuses/stages/sequences
 * scaffolding, zero leads — and persists everything the user creates (typed-in
 * leads, CSV imports, tasks, notes, timelines, smart views) to localStorage on
 * THIS device, so it behaves like a real account across reloads.
 *
 * This module knows nothing about the fixture db's construction — fixtures.ts
 * consumes the mode + snapshot at boot, and main.tsx starts the persistence
 * loop (never at module scope: tests import the handlers without a browser).
 */

export type WorkspaceMode = 'sample' | 'blank';

export const WORKSPACE_KEY = 'sb-workspace';
const BLANK_DB_KEY = 'sb-blank-db-v1';

export interface BlankSnapshot {
  v: 1;
  leads: Lead[];
  contacts: Contact[];
  opportunities: Opportunity[];
  /** Map entries — JSON has no Map. */
  activities: Array<[string, Activity[]]>;
  smartViews: SmartView[];
}

export function workspaceMode(): WorkspaceMode {
  try {
    return localStorage.getItem(WORKSPACE_KEY) === 'blank' ? 'blank' : 'sample';
  } catch {
    return 'sample';
  }
}

export function setWorkspaceMode(mode: WorkspaceMode): void {
  try {
    if (mode === 'blank') localStorage.setItem(WORKSPACE_KEY, 'blank');
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* storage unavailable — mode stays session-default */
  }
}

export function loadBlankSnapshot(): BlankSnapshot | null {
  try {
    const raw = localStorage.getItem(BLANK_DB_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { v?: unknown }).v === 1 &&
      Array.isArray((parsed as { leads?: unknown }).leads)
    ) {
      return parsed as BlankSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveBlankSnapshot(snapshot: BlankSnapshot): void {
  try {
    localStorage.setItem(BLANK_DB_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode — the session still works, it just won't survive */
  }
}

export function hasBlankSnapshot(): boolean {
  try {
    return localStorage.getItem(BLANK_DB_KEY) !== null;
  } catch {
    return false;
  }
}

/** Drop the persisted blank-workspace data (the workspace boots empty again). */
export function clearBlankWorkspace(): void {
  try {
    localStorage.removeItem(BLANK_DB_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Persist the blank workspace on a heartbeat + when the tab hides/closes.
 * Called from main.tsx AFTER the mock worker starts, and only in blank mode.
 */
export function startWorkspacePersistence(collect: () => BlankSnapshot): void {
  if (workspaceMode() !== 'blank') return;
  const save = (): void => saveBlankSnapshot(collect());
  window.setInterval(save, 5_000);
  window.addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
}
