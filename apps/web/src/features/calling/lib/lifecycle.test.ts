import { describe, expect, test } from 'vitest';
import {
  CALL_UI_STATES,
  dispositionToStatus,
  isLiveState,
  nextConnectState,
  type CallUiState,
} from './lifecycle.ts';

describe('call lifecycle state model', () => {
  test('connect simulation advances dialing → ringing → answered, then rests', () => {
    expect(nextConnectState('dialing')).toBe('ringing');
    expect(nextConnectState('ringing')).toBe('answered');
    expect(nextConnectState('answered')).toBeNull();
    expect(nextConnectState('wrapup')).toBeNull();
  });

  test('live states are exactly the on-the-wire phases (guards sequential advance)', () => {
    expect(isLiveState('dialing')).toBe(true);
    expect(isLiveState('ringing')).toBe(true);
    expect(isLiveState('answered')).toBe(true);
    expect(isLiveState('wrapup')).toBe(false);
  });

  test('every phase either advances or rests — no dangling states', () => {
    for (const state of CALL_UI_STATES) {
      const next = nextConnectState(state as CallUiState);
      expect(next === null || CALL_UI_STATES.includes(next)).toBe(true);
    }
  });

  test('outcome dispositions map onto the C1 calls.status enum', () => {
    expect(dispositionToStatus('completed')).toBe('completed');
    expect(dispositionToStatus('missed')).toBe('missed');
    expect(dispositionToStatus('voicemail')).toBe('voicemail');
  });
});
