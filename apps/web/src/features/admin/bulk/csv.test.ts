import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Lead } from '@switchboard/shared';
import { csvFilename, downloadCsv, leadsToCsv, toCsv } from './csv.ts';

function makeLead(over: Partial<Lead>): Lead {
  return {
    id: 'l1',
    name: 'North Labs',
    url: 'https://north.example.com',
    description: null,
    statusId: 'st1',
    ownerId: 'u1',
    custom: {},
    lastContactedAt: '2026-07-10T12:00:00.000Z',
    lastInboundAt: null,
    nextTaskDueAt: null,
    lastCallAt: null,
    lastEmailAt: null,
    lastSmsAt: null,
    dnc: false,
    deletedAt: null,
    createdAt: '2026-01-02T09:00:00.000Z',
    updatedAt: '2026-07-10T12:00:00.000Z',
    ...over,
  };
}

const ctx = {
  ownerName: (id: string | null) => (id === 'u1' ? 'Ada Okafor' : '—'),
  statusLabel: (id: string | null) => (id === 'st1' ? 'Qualified' : '—'),
};

describe('toCsv escaping (RFC 4180)', () => {
  test('quotes fields with commas, quotes, or newlines and doubles quotes', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['plain', 'has,comma'],
        ['has"quote', 'has\nnewline'],
      ],
    );
    expect(csv).toBe('a,b\r\nplain,"has,comma"\r\n"has""quote","has\nnewline"');
  });

  test('rows are CRLF-terminated', () => {
    expect(toCsv(['x'], [['1'], ['2']])).toBe('x\r\n1\r\n2');
  });
});

describe('leadsToCsv', () => {
  test('emits the header and one resolved row per lead', () => {
    const csv = leadsToCsv(
      [makeLead({}), makeLead({ id: 'l2', name: 'Cedar Systems', dnc: true, ownerId: null })],
      ctx,
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Name,Status,Owner,DNC,Last contacted,Created,URL');
    expect(lines[1]).toBe(
      'North Labs,Qualified,Ada Okafor,No,2026-07-10,2026-01-02,https://north.example.com',
    );
    expect(lines[2]).toBe(
      'Cedar Systems,Qualified,—,Yes,2026-07-10,2026-01-02,https://north.example.com',
    );
  });

  test('a lead name containing a comma is quoted', () => {
    const csv = leadsToCsv([makeLead({ name: 'Acme, Inc.' })], ctx);
    expect(csv.split('\r\n')[1]?.startsWith('"Acme, Inc.",')).toBe(true);
  });

  test('null last-contacted and null url render as empty cells', () => {
    const csv = leadsToCsv([makeLead({ lastContactedAt: null, url: null })], ctx);
    const cells = csv.split('\r\n')[1]?.split(',');
    expect(cells?.[4]).toBe(''); // Last contacted
    expect(cells?.[6]).toBe(''); // URL
  });
});

describe('csvFilename', () => {
  test('is date-stamped', () => {
    expect(csvFilename(new Date('2026-07-16T22:00:00Z'))).toBe('leads-2026-07-16.csv');
  });
});

describe('downloadCsv', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  test('creates an object URL and clicks an anchor with the download name', () => {
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const clicks: HTMLAnchorElement[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this);
    });

    const ok = downloadCsv('leads-test.csv', 'a,b\r\n1,2');
    expect(ok).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clicks[0]?.download).toBe('leads-test.csv');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});
