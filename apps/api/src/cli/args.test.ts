import { describe, expect, test } from 'vitest';

import { flagBool, flagString, parseArgs } from './args.ts';

/** Task 5g — argv parsing (incl. edge cases: bare booleans, `=`, empty argv). */

describe('parseArgs', () => {
  test('empty argv → no command, no positionals', () => {
    expect(parseArgs([])).toEqual({ command: null, positionals: [], flags: {} });
  });

  test('command + positionals', () => {
    const r = parseArgs(['merge-leads', 'W1', 'L1']);
    expect(r.command).toBe('merge-leads');
    expect(r.positionals).toEqual(['W1', 'L1']);
  });

  test('--flag value consumes the next token', () => {
    const r = parseArgs(['hard-delete-lead', 'L1', '--reason', 'gdpr erase']);
    expect(r.positionals).toEqual(['L1']);
    expect(r.flags['reason']).toBe('gdpr erase');
  });

  test('--flag=value form', () => {
    const r = parseArgs(['x', '--reason=cleanup']);
    expect(r.flags['reason']).toBe('cleanup');
  });

  test('declared boolean flag never consumes the next token', () => {
    const r = parseArgs(['hard-delete-lead', 'L1', '--force', '--reason', 'x'], {
      booleans: ['force'],
    });
    expect(r.flags['force']).toBe(true);
    expect(r.flags['reason']).toBe('x');
    expect(r.positionals).toEqual(['L1']);
  });

  test('a value flag with no following value becomes boolean true', () => {
    const r = parseArgs(['x', '--reason']);
    expect(r.flags['reason']).toBe(true);
  });
});

describe('flag readers', () => {
  test('flagString returns strings, rejects boolean/empty/missing', () => {
    expect(flagString({ reason: 'hi' }, 'reason')).toBe('hi');
    expect(flagString({ reason: true }, 'reason')).toBeUndefined();
    expect(flagString({ reason: '' }, 'reason')).toBeUndefined();
    expect(flagString({}, 'reason')).toBeUndefined();
  });

  test('flagBool is true only when present-as-true', () => {
    expect(flagBool({ force: true }, 'force')).toBe(true);
    expect(flagBool({ force: 'true' }, 'force')).toBe(true);
    expect(flagBool({ force: 'no' }, 'force')).toBe(false);
    expect(flagBool({}, 'force')).toBe(false);
  });
});
