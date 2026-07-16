import { describe, expect, test } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Lead } from '@switchboard/shared';
import { applyOptimisticLeadPatch, mapLeadsDeep, restoreSnapshot } from './leadCache.ts';

function lead(id: string, over: Partial<Lead> = {}): Lead {
  return {
    id,
    name: id,
    url: null,
    description: null,
    statusId: 'st1',
    ownerId: 'u1',
    custom: {},
    lastContactedAt: null,
    lastInboundAt: null,
    nextTaskDueAt: null,
    lastCallAt: null,
    lastEmailAt: null,
    lastSmsAt: null,
    dnc: false,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const setOwner =
  (ownerId: string) =>
  (l: Lead): Lead => ({ ...l, ownerId });

describe('mapLeadsDeep', () => {
  const ids = new Set(['a']);

  test('patches within a plain array', () => {
    const data = [lead('a'), lead('b')];
    const next = mapLeadsDeep(data, ids, setOwner('u2')) as Lead[];
    expect(next[0]?.ownerId).toBe('u2');
    expect(next[1]?.ownerId).toBe('u1');
    expect(next[1]).toBe(data[1]); // untouched row keeps identity
  });

  test('patches within a keyset page { items }', () => {
    const data = { items: [lead('a'), lead('b')], nextCursor: 'x' };
    const next = mapLeadsDeep(data, ids, setOwner('u2')) as typeof data;
    expect(next.items[0]?.ownerId).toBe('u2');
    expect(next.nextCursor).toBe('x');
  });

  test('patches within an infinite query { pages: [{ items }] }', () => {
    const data = {
      pages: [{ items: [lead('a')] }, { items: [lead('b')] }],
      pageParams: [undefined],
    };
    const next = mapLeadsDeep(data, ids, setOwner('u2')) as typeof data;
    expect(next.pages[0]?.items[0]?.ownerId).toBe('u2');
    expect(next.pages[1]).toBe(data.pages[1]); // unchanged page keeps identity
  });

  test('returns the same reference when nothing matches', () => {
    const data = { items: [lead('z')] };
    expect(mapLeadsDeep(data, ids, setOwner('u2'))).toBe(data);
  });

  test('is a no-op for unrelated shapes', () => {
    const data = { totalCount: 3 };
    expect(mapLeadsDeep(data, ids, setOwner('u2'))).toBe(data);
  });
});

describe('applyOptimisticLeadPatch + restoreSnapshot', () => {
  test('patches every cache that holds the lead and can roll back', () => {
    const qc = new QueryClient();
    qc.setQueryData(['leads', 'all'], {
      pages: [{ items: [lead('a'), lead('b')] }],
      pageParams: [undefined],
    });
    qc.setQueryData(['smart-view-preview', 'v1'], { items: [lead('a')], countEstimate: 1 });
    qc.setQueryData(['unrelated'], { hello: 'world' });

    const snapshot = applyOptimisticLeadPatch(qc, new Set(['a']), setOwner('u9'));

    const infinite = qc.getQueryData<{ pages: Array<{ items: Lead[] }> }>(['leads', 'all']);
    const preview = qc.getQueryData<{ items: Lead[] }>(['smart-view-preview', 'v1']);
    expect(infinite?.pages[0]?.items[0]?.ownerId).toBe('u9');
    expect(preview?.items[0]?.ownerId).toBe('u9');
    // only the two lead-bearing caches were snapshotted
    expect(snapshot.length).toBe(2);

    restoreSnapshot(qc, snapshot);
    const rolledBack = qc.getQueryData<{ pages: Array<{ items: Lead[] }> }>(['leads', 'all']);
    expect(rolledBack?.pages[0]?.items[0]?.ownerId).toBe('u1');
  });
});
