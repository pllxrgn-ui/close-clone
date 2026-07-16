/*
 * Optimistic cross-cache lead patching for bulk actions. The bulk bar lives in
 * the leads feature but must not know that feature's query keys, so instead of
 * targeting keys we walk every cached query and structurally patch any lead rows
 * we find — plain `Lead[]`, a keyset `{items}` page, a smart-view preview
 * `{items,countEstimate}`, or an infinite-query `{pages:[{items}]}`. Unchanged
 * data keeps its reference (react-query then skips a needless re-render), and a
 * snapshot is returned so `onError` can roll the optimistic write back.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Lead } from '@switchboard/shared';

export type LeadPatchFn = (lead: Lead) => Lead;
export type CacheSnapshot = ReadonlyArray<readonly [readonly unknown[], unknown]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Patch matching leads within one array, preserving the reference if no change. */
function mapLeadArray(
  items: readonly unknown[],
  ids: ReadonlySet<string>,
  patch: LeadPatchFn,
): readonly unknown[] {
  let changed = false;
  const next = items.map((item) => {
    if (isRecord(item) && typeof item.id === 'string' && ids.has(item.id)) {
      changed = true;
      return patch(item as unknown as Lead);
    }
    return item;
  });
  return changed ? next : items;
}

/**
 * Deep-map lead rows inside any of the cache shapes the leads surfaces use.
 * Returns the same reference when nothing matched.
 */
export function mapLeadsDeep(data: unknown, ids: ReadonlySet<string>, patch: LeadPatchFn): unknown {
  if (ids.size === 0 || data == null) return data;

  if (Array.isArray(data)) {
    return mapLeadArray(data, ids, patch);
  }

  if (isRecord(data)) {
    // Keyset page / smart-view preview: { items: Lead[], ... }
    if (Array.isArray(data.items)) {
      const nextItems = mapLeadArray(data.items, ids, patch);
      return nextItems === data.items ? data : { ...data, items: nextItems };
    }
    // Infinite query: { pages: [{ items: Lead[] }], pageParams }
    if (Array.isArray(data.pages)) {
      let changed = false;
      const pages = data.pages.map((page) => {
        const mapped = mapLeadsDeep(page, ids, patch);
        if (mapped !== page) changed = true;
        return mapped;
      });
      return changed ? { ...data, pages } : data;
    }
  }

  return data;
}

/**
 * Apply `patch` to matching leads across every cached query, returning a snapshot
 * of the pre-patch data for the queries that actually changed (for rollback).
 */
export function applyOptimisticLeadPatch(
  queryClient: QueryClient,
  ids: ReadonlySet<string>,
  patch: LeadPatchFn,
): CacheSnapshot {
  const snapshot: Array<readonly [readonly unknown[], unknown]> = [];
  for (const query of queryClient.getQueryCache().getAll()) {
    const prev = query.state.data;
    const next = mapLeadsDeep(prev, ids, patch);
    if (next !== prev) {
      snapshot.push([query.queryKey, prev]);
      queryClient.setQueryData(query.queryKey, next);
    }
  }
  return snapshot;
}

/** Restore a snapshot taken by {@link applyOptimisticLeadPatch}. */
export function restoreSnapshot(queryClient: QueryClient, snapshot: CacheSnapshot): void {
  for (const [key, data] of snapshot) {
    queryClient.setQueryData(key, data);
  }
}
