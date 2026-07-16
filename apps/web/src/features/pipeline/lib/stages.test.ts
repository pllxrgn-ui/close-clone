import { describe, expect, test } from 'vitest';
import type { OpportunityStage } from '@switchboard/shared';
import { adjacentStage, sortStages, statusForStage, terminalKind, terminalStage } from './stages.ts';

function stage(id: string, label: string, sortOrder: number): OpportunityStage {
  return { id, label, sortOrder, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

const STAGES: OpportunityStage[] = [
  stage('s4', 'Closed Lost', 4),
  stage('s0', 'Discovery', 0),
  stage('s3', 'Closed Won', 3),
  stage('s1', 'Proposal', 1),
  stage('s2', 'Negotiation', 2),
];

describe('sortStages', () => {
  test('orders by sortOrder ascending regardless of input order', () => {
    expect(sortStages(STAGES).map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  test('breaks sortOrder ties by label and does not mutate the input', () => {
    const tied = [stage('b', 'Beta', 1), stage('a', 'Alpha', 1)];
    const snapshot = tied.map((s) => s.id);
    expect(sortStages(tied).map((s) => s.label)).toEqual(['Alpha', 'Beta']);
    expect(tied.map((s) => s.id)).toEqual(snapshot);
  });
});

describe('terminalKind / statusForStage', () => {
  test('detects won and lost from the label, case-insensitively', () => {
    expect(terminalKind(stage('x', 'Closed Won', 3))).toBe('won');
    expect(terminalKind(stage('x', 'deal LOST', 4))).toBe('lost');
    expect(terminalKind(stage('x', 'Negotiation', 2))).toBeNull();
  });

  test('does not misfire on substrings like "Wonderland"', () => {
    expect(terminalKind(stage('x', 'Wonderland', 1))).toBeNull();
  });

  test('status is derived from the stage: terminal forces won/lost, else active', () => {
    expect(statusForStage(stage('x', 'Closed Won', 3))).toBe('won');
    expect(statusForStage(stage('x', 'Closed Lost', 4))).toBe('lost');
    expect(statusForStage(stage('x', 'Discovery', 0))).toBe('active');
  });
});

describe('terminalStage', () => {
  test('finds the won and lost close columns', () => {
    expect(terminalStage(STAGES, 'won')?.id).toBe('s3');
    expect(terminalStage(STAGES, 'lost')?.id).toBe('s4');
  });

  test('returns null when no terminal column of that kind exists', () => {
    const funnelOnly = [stage('s0', 'Discovery', 0), stage('s1', 'Proposal', 1)];
    expect(terminalStage(funnelOnly, 'won')).toBeNull();
  });
});

describe('adjacentStage', () => {
  test('moves one column forward and back in display order', () => {
    expect(adjacentStage(STAGES, 's1', 1)?.id).toBe('s2');
    expect(adjacentStage(STAGES, 's1', -1)?.id).toBe('s0');
  });

  test('clamps at the boundaries (no wraparound)', () => {
    expect(adjacentStage(STAGES, 's0', -1)).toBeNull();
    expect(adjacentStage(STAGES, 's4', 1)).toBeNull();
  });

  test('returns null for an unknown or null current stage', () => {
    expect(adjacentStage(STAGES, 'nope', 1)).toBeNull();
    expect(adjacentStage(STAGES, null, 1)).toBeNull();
  });
});
