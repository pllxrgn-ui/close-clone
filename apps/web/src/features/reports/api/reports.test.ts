import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchCompleteSequencesReport } from './reports.ts';

afterEach(() => vi.unstubAllGlobals());

describe('complete report pagination', () => {
  test('follows every cursor before returning totals', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ sequenceId: 'one' }], nextCursor: 'page-2' })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ sequenceId: 'two' }] })));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchCompleteSequencesReport();

    expect(page.items.map((row) => row.sequenceId)).toEqual(['one', 'two']);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=page-2');
  });
});
