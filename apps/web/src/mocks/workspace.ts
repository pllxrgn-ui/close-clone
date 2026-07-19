import type { Activity, Contact, Lead, Opportunity, SmartView, User } from '@switchboard/shared';

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
const OWNER_KEY = 'sb-workspace-owner';

/**
 * A personal demo account signed into ITS OWN workspace (see auth/accounts.ts).
 * When an owner is set the workspace is always blank-mode, its data persists
 * under a per-account key, and the org's user list is just the owner.
 */
export interface WorkspaceOwner {
  username: string;
  user: User;
}

export function getWorkspaceOwner(): WorkspaceOwner | null {
  try {
    const raw = localStorage.getItem(OWNER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { username?: unknown }).username === 'string'
    ) {
      return parsed as WorkspaceOwner;
    }
    return null;
  } catch {
    return null;
  }
}

export function setWorkspaceOwner(owner: WorkspaceOwner): void {
  try {
    localStorage.setItem(OWNER_KEY, JSON.stringify(owner));
  } catch {
    /* storage unavailable */
  }
}

export function clearWorkspaceOwner(): void {
  try {
    localStorage.removeItem(OWNER_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The active blank-db storage key — per-account when an owner is signed in. */
function blankDbKey(): string {
  const owner = getWorkspaceOwner();
  return owner ? `${BLANK_DB_KEY}:u:${owner.username}` : BLANK_DB_KEY;
}

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
  if (getWorkspaceOwner() !== null) return 'blank';
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
    const raw = localStorage.getItem(blankDbKey());
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
    localStorage.setItem(blankDbKey(), JSON.stringify(snapshot));
  } catch {
    /* quota / private mode — the session still works, it just won't survive */
  }
}

export function hasBlankSnapshot(): boolean {
  try {
    return localStorage.getItem(blankDbKey()) !== null;
  } catch {
    return false;
  }
}

/** Drop the persisted blank-workspace data (the workspace boots empty again). */
export function clearBlankWorkspace(): void {
  try {
    localStorage.removeItem(blankDbKey());
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
