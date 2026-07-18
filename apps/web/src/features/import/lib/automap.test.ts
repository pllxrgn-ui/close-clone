import { describe, expect, test } from 'vitest';
import { autoMap } from './automap.ts';

const CUSTOM = [
  { key: 'segment', label: 'Segment' },
  { key: 'region', label: 'Region' },
  { key: 'employees', label: 'Employees' },
  { key: 'notes', label: 'Account notes' },
];

function targetFor(headers: string[], header: string): string | undefined {
  const cols = autoMap(headers, CUSTOM);
  return cols.find((c) => c.source === header)?.target;
}

describe('autoMap', () => {
  test('maps the common lead + contact columns by header name', () => {
    const headers = ['Company', 'Website', 'Email', 'Phone', 'Title', 'Contact'];
    const cols = autoMap(headers, CUSTOM);
    const bySource = new Map(cols.map((c) => [c.source, c.target]));
    expect(bySource.get('Company')).toBe('lead.name');
    expect(bySource.get('Website')).toBe('lead.url');
    expect(bySource.get('Email')).toBe('contact.email');
    expect(bySource.get('Phone')).toBe('contact.phone');
    expect(bySource.get('Title')).toBe('contact.title');
    expect(bySource.get('Contact')).toBe('contact.name');
  });

  test('is punctuation/case insensitive', () => {
    expect(targetFor(['E-mail Address'], 'E-mail Address')).toBe('contact.email');
    expect(targetFor(['Do Not Contact'], 'Do Not Contact')).toBe('lead.dnc');
  });

  test('maps a header onto a matching custom field by key or label', () => {
    expect(targetFor(['Segment'], 'Segment')).toBe('custom.segment');
    expect(targetFor(['Notes'], 'Notes')).toBe('custom.notes');
  });

  test('ignores an unrecognized header', () => {
    expect(targetFor(['Sparkle Index'], 'Sparkle Index')).toBe('ignore');
  });

  test('does not assign the same builtin target twice', () => {
    const cols = autoMap(['Company', 'Account'], CUSTOM);
    const leadNameCount = cols.filter((c) => c.target === 'lead.name').length;
    expect(leadNameCount).toBe(1);
  });

  test('returns one column per header, in order', () => {
    const headers = ['Company', 'Email'];
    expect(autoMap(headers, CUSTOM).map((c) => c.source)).toEqual(headers);
  });
});
