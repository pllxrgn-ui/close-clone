import { describe, expect, test } from 'vitest';
import {
  buildMergeContext,
  firstName,
  hasUnresolved,
  parseMergeTemplate,
  primaryEmail,
  renderMergeTemplate,
  unresolvedKeys,
} from './mergeTags.ts';
import type { MergeContext } from './mergeTags.ts';

const ctx: MergeContext = {
  'lead.name': 'North Labs',
  'contact.first_name': 'Sam',
  'contact.email': 'sam@northlabs.example.com',
  'owner.name': 'Ben Reyes',
};

describe('parseMergeTemplate', () => {
  test('splits literals and resolves known tags', () => {
    const segs = parseMergeTemplate('Hi {{contact.first_name}} at {{lead.name}}!', ctx);
    expect(segs).toEqual([
      { kind: 'text', value: 'Hi ' },
      {
        kind: 'tag',
        raw: '{{contact.first_name}}',
        key: 'contact.first_name',
        resolved: true,
        value: 'Sam',
      },
      { kind: 'text', value: ' at ' },
      { kind: 'tag', raw: '{{lead.name}}', key: 'lead.name', resolved: true, value: 'North Labs' },
      { kind: 'text', value: '!' },
    ]);
  });

  test('tolerates whitespace inside the braces', () => {
    const segs = parseMergeTemplate('{{  owner.name  }}', ctx);
    expect(segs).toEqual([
      {
        kind: 'tag',
        raw: '{{  owner.name  }}',
        key: 'owner.name',
        resolved: true,
        value: 'Ben Reyes',
      },
    ]);
  });

  test('marks an unknown key unresolved', () => {
    const segs = parseMergeTemplate('{{contact.mobile}}', ctx);
    expect(segs[0]).toMatchObject({ kind: 'tag', resolved: false, value: '' });
  });

  test('marks a known-but-empty value unresolved', () => {
    const segs = parseMergeTemplate('{{contact.first_name}}', { 'contact.first_name': '   ' });
    expect(segs[0]).toMatchObject({ kind: 'tag', resolved: false });
  });
});

describe('unresolvedKeys / hasUnresolved', () => {
  test('dedupes unresolved keys in first-seen order', () => {
    const segs = parseMergeTemplate('{{a}} {{b}} {{a}}', {});
    expect(unresolvedKeys(segs)).toEqual(['a', 'b']);
  });

  test('hasUnresolved is false when every tag resolves', () => {
    expect(hasUnresolved('Hi {{contact.first_name}}', ctx)).toBe(false);
  });

  test('hasUnresolved is true when any tag is missing — this is what blocks Send', () => {
    expect(hasUnresolved('Hi {{contact.first_name}} — re {{deal.stage}}', ctx)).toBe(true);
  });

  test('plain text with no tags never blocks Send', () => {
    expect(hasUnresolved('no tags here', {})).toBe(false);
  });
});

describe('renderMergeTemplate', () => {
  test('substitutes resolved tags', () => {
    expect(renderMergeTemplate('Hi {{contact.first_name}}', ctx)).toBe('Hi Sam');
  });

  test('keeps unresolved tags verbatim (Send is gated separately)', () => {
    expect(renderMergeTemplate('Hi {{contact.first_name}} {{x.y}}', ctx)).toBe('Hi Sam {{x.y}}');
  });
});

describe('context helpers', () => {
  test('firstName takes the first whitespace token', () => {
    expect(firstName('Sam Patel')).toBe('Sam');
    expect(firstName('  Riley   Kim ')).toBe('Riley');
    expect(firstName(null)).toBe('');
    expect(firstName('')).toBe('');
  });

  test('primaryEmail reads the first entry or empty', () => {
    expect(primaryEmail({ emails: [{ email: 'a@b.com', type: 'work' }] })).toBe('a@b.com');
    expect(primaryEmail({ emails: [] })).toBe('');
    expect(primaryEmail(null)).toBe('');
  });

  test('buildMergeContext derives first name + aliases, blanks missing pieces', () => {
    const built = buildMergeContext({
      lead: { name: 'North Labs' },
      contact: { name: 'Sam Patel', emails: [{ email: 'sam@x.com', type: 'work' }] },
      owner: { name: 'Ben Reyes' },
    });
    expect(built['contact.first_name']).toBe('Sam');
    expect(built['company']).toBe('North Labs');
    expect(built['contact.email']).toBe('sam@x.com');
    expect(built['owner.name']).toBe('Ben Reyes');
  });

  test('a missing contact yields unresolved contact tags (blocks Send until picked)', () => {
    const built = buildMergeContext({
      lead: { name: 'North Labs' },
      contact: null,
      owner: { name: 'Ben' },
    });
    expect(hasUnresolved('Hi {{contact.first_name}}', built)).toBe(true);
  });
});
