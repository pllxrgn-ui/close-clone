import { describe, expect, it } from 'vitest';

import { ParseError } from './errors.ts';
import { tokenize } from './lexer.ts';

const kinds = (src: string): string[] => tokenize(src).map((t) => t.kind);

describe('lexer', () => {
  it('tokenizes operators and parens', () => {
    expect(kinds('a = 1')).toEqual(['ident', 'op', 'number', 'eof']);
    expect(tokenize('!= <= >= = < >').map((t) => t.value)).toEqual([
      '!=',
      '<=',
      '>=',
      '=',
      '<',
      '>',
      '',
    ]);
    expect(kinds('(a, b)')).toEqual(['lparen', 'ident', 'comma', 'ident', 'rparen', 'eof']);
  });

  it('lexes dotted identifiers as a single token', () => {
    const t = tokenize('opportunity.value custom.my_key contact.email');
    expect(t.slice(0, 3).map((x) => x.value)).toEqual([
      'opportunity.value',
      'custom.my_key',
      'contact.email',
    ]);
  });

  it('lexes ISO dates as one token (not number-dash-number)', () => {
    expect(tokenize('2024-01-15')[0]).toMatchObject({ kind: 'date', value: '2024-01-15' });
    expect(tokenize('2024-01-15T09:30:00Z')[0]).toMatchObject({ kind: 'date' });
    expect(tokenize('2024-01-15T09:30:00+02:00')[0]?.value).toBe('2024-01-15T09:30:00+02:00');
  });

  it('lexes numbers including negatives and decimals', () => {
    expect(tokenize('-5')[0]).toMatchObject({ kind: 'number', value: '-5' });
    expect(tokenize('3.14')[0]).toMatchObject({ kind: 'number', value: '3.14' });
  });

  it('splits relative-date atoms into number + unit idents', () => {
    expect(
      tokenize('30d')
        .map((t) => `${t.kind}:${t.value}`)
        .slice(0, 2),
    ).toEqual(['number:30', 'ident:d']);
  });

  it('decodes string escapes', () => {
    expect(tokenize('"he said \\"hi\\""')[0]?.value).toBe('he said "hi"');
    expect(tokenize('"back\\\\slash"')[0]?.value).toBe('back\\slash');
  });

  it('tracks line/col positions', () => {
    const toks = tokenize('name =\n  "x"');
    expect(toks[0]?.pos).toMatchObject({ line: 1, col: 1 });
    expect(toks[2]?.pos).toMatchObject({ line: 2, col: 3 });
  });

  it('throws ParseError on an unterminated string', () => {
    expect(() => tokenize('"oops')).toThrow(ParseError);
  });

  it('throws ParseError on an unexpected character', () => {
    try {
      tokenize('a & b');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).position.col).toBe(3);
    }
  });
});
