import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { astArb, TEST_CATALOG } from './arbitrary.ts';
import { ParseError } from './errors.ts';
import { parse } from './parser.ts';
import { astToDsl } from './serialize.ts';

const opts = { fieldCatalog: TEST_CATALOG };

describe('astToDsl — examples', () => {
  it('serializes leaves canonically', () => {
    expect(astToDsl(parse('name = "Acme"'))).toBe('name = "Acme"');
    expect(astToDsl(parse('owner in (me)'))).toBe('owner in (me)');
    expect(astToDsl(parse('has call within 7d'))).toBe('has call within 7d');
    expect(astToDsl(parse('has in_sequence("X")'))).toBe('has in_sequence("X")');
    expect(astToDsl(parse('created > 30d ago'))).toBe('created > 30d ago');
    expect(astToDsl(parse('next_task_due is_set'))).toBe('next_task_due is_set');
  });

  it('escapes quotes and backslashes in strings', () => {
    const ast = parse('name = "a\\"b\\\\c"');
    expect(astToDsl(ast)).toBe('name = "a\\"b\\\\c"');
  });

  it('inserts parentheses only where precedence requires', () => {
    expect(astToDsl(parse('has call and has email or has sms'))).toBe(
      'has call and has email or has sms',
    );
    expect(astToDsl(parse('has call and (has email or has sms)'))).toBe(
      'has call and (has email or has sms)',
    );
    expect(astToDsl(parse('not (has call and has email)'))).toBe('not (has call and has email)');
  });
});

describe('astToDsl — normative round-trip parse(astToDsl(a)) ≡ a', () => {
  it('holds for generated ASTs (property, 2000 runs)', () => {
    fc.assert(
      fc.property(astArb, (ast) => {
        const dsl = astToDsl(ast);
        const reparsed = parse(dsl, opts);
        expect(reparsed).toEqual(ast);
      }),
      { numRuns: 2000 },
    );
  });

  it('is idempotent under a second round-trip', () => {
    fc.assert(
      fc.property(astArb, (ast) => {
        const dsl1 = astToDsl(ast);
        const dsl2 = astToDsl(parse(dsl1, opts));
        expect(dsl2).toBe(dsl1);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('parser fuzz — only ever throws ParseError', () => {
  it('never throws a non-ParseError on arbitrary strings (2000 runs)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 160 }), (s) => {
        try {
          parse(s, opts);
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws a non-ParseError on DSL-token-biased input (2000 runs)', () => {
    const tokenArb = fc.constantFrom(
      'name',
      'status',
      'owner',
      'custom.industry',
      'has',
      'no',
      'call',
      'in_sequence',
      'within',
      'and',
      'or',
      'not',
      'in',
      'matches',
      '(',
      ')',
      ',',
      '=',
      '!=',
      '>=',
      'contains',
      'is_set',
      '"x"',
      '30d',
      'ago',
      'me',
      'true',
      '2024-01-01',
      'this_week',
    );
    fc.assert(
      fc.property(fc.array(tokenArb, { maxLength: 24 }), (parts) => {
        try {
          parse(parts.join(' '), opts);
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
        }
      }),
      { numRuns: 2000 },
    );
  });
});
