/*
 * A tiny module-scope mirror of the leads board's current bulk selection. The
 * bulk bar publishes its selected rows here; the command palette reads them so
 * "Export selected leads (CSV)" is a real, gated command (it only appears when a
 * selection exists — never a no-op). This is the ONLY cross-surface coupling the
 * bulk feature needs, and it is one-directional (bar → mirror → palette).
 */
import { useSyncExternalStore } from 'react';
import type { Lead } from '@switchboard/shared';
import type { CsvLabelCtx } from './csv.ts';

export interface BulkSelection {
  readonly leads: readonly Lead[];
  readonly ctx: CsvLabelCtx | null;
}

const EMPTY: BulkSelection = { leads: [], ctx: null };
let current: BulkSelection = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Publish the current selection (called by the bulk bar on selection change). */
export function setBulkSelection(leads: readonly Lead[], ctx: CsvLabelCtx): void {
  current = leads.length === 0 ? EMPTY : { leads, ctx };
  emit();
}

/** Clear the mirror (called when the bulk bar unmounts / selection empties). */
export function clearBulkSelection(): void {
  if (current === EMPTY) return;
  current = EMPTY;
  emit();
}

export function getBulkSelection(): BulkSelection {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a React tree to the mirror (stable snapshot reference per change). */
export function useBulkSelection(): BulkSelection {
  return useSyncExternalStore(subscribe, getBulkSelection, getBulkSelection);
}
