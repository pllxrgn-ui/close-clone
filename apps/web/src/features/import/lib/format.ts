/*
 * Display helpers for the preview ledger + summaries: disposition/match labels
 * and human-readable text for the engine's machine error codes, so a rep sees
 * "Invalid email address" rather than `invalid_email`.
 */
import type { MatchType, RowOutcome } from '../types.ts';

export function outcomeLabel(outcome: RowOutcome): string {
  switch (outcome) {
    case 'create':
      return 'Create';
    case 'dedupe':
      return 'Duplicate';
    case 'error':
      return 'Error';
    case 'empty':
      return 'Empty';
  }
}

export function matchTypeLabel(matchType: MatchType): string {
  switch (matchType) {
    case 'email':
      return 'Email';
    case 'domain':
      return 'Domain';
    case 'fuzzy-name':
      return 'Fuzzy name';
  }
}

const ERROR_TEXT: Record<string, string> = {
  invalid_email: 'Invalid email address',
  invalid_number: 'Not a number',
  invalid_date: 'Not a valid date (use YYYY-MM-DD)',
  invalid_bool: 'Not a yes/no value',
  not_in_options: 'Not an allowed option',
  unknown_user: 'No user matches this owner',
  unknown_status: 'No such lead status',
  unknown_custom_field: 'Unknown custom field',
  missing_lead_name: 'No company name to create a lead from',
};

/** Friendly text for an engine error code (falls back to the raw code). */
export function humanError(code: string): string {
  return ERROR_TEXT[code] ?? code;
}

/** "1 lead" / "2 leads" — tabular counts with correct pluralization. */
export function countNoun(n: number, singular: string, plural?: string): string {
  const word = n === 1 ? singular : (plural ?? `${singular}s`);
  return `${n} ${word}`;
}
