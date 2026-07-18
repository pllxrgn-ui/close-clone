import { describe, expect, test } from 'vitest';
import { countNoun, humanError, matchTypeLabel, outcomeLabel } from './format.ts';

describe('outcomeLabel', () => {
  test('names each disposition', () => {
    expect(outcomeLabel('create')).toBe('Create');
    expect(outcomeLabel('dedupe')).toBe('Duplicate');
    expect(outcomeLabel('error')).toBe('Error');
    expect(outcomeLabel('empty')).toBe('Empty');
  });
});

describe('matchTypeLabel', () => {
  test('names each match type', () => {
    expect(matchTypeLabel('email')).toBe('Email');
    expect(matchTypeLabel('domain')).toBe('Domain');
    expect(matchTypeLabel('fuzzy-name')).toBe('Fuzzy name');
  });
});

describe('humanError', () => {
  test('humanizes known engine error codes', () => {
    expect(humanError('invalid_email')).toBe('Invalid email address');
    expect(humanError('missing_lead_name')).toBe('No company name to create a lead from');
    expect(humanError('invalid_number')).toBe('Not a number');
  });
  test('falls back to the raw code for an unknown one', () => {
    expect(humanError('some_new_code')).toBe('some_new_code');
  });
});

describe('countNoun', () => {
  test('pluralizes on count', () => {
    expect(countNoun(1, 'lead')).toBe('1 lead');
    expect(countNoun(2, 'lead')).toBe('2 leads');
    expect(countNoun(0, 'row')).toBe('0 rows');
  });
  test('accepts an explicit plural', () => {
    expect(countNoun(3, 'company', 'companies')).toBe('3 companies');
  });
});
