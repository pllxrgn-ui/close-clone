import type { Call } from '@switchboard/shared';

/*
 * The client-side call lifecycle used by the global call strip.
 *
 * A real outbound call moves queued → ringing → answered → (completed | …) as
 * Twilio status callbacks arrive; the CONTRACTS §C7 WS `call.state` frame is a
 * cache-invalidation hint that would drive those transitions in production. In
 * the zero-backend demo there is no callback stream, so the strip SIMULATES the
 * connect leg on an injectable clock (see CallProvider). This module owns the
 * pure parts of that simulation — the phase vocabulary, the auto-advance edges,
 * and the mapping back onto the C1 `calls.status` enum — so the simulator and a
 * future WS-driven source share one state model.
 */

/** Strip-facing phases. `wrapup` is post-disconnect outcome logging (not live). */
export const CALL_UI_STATES = ['dialing', 'ringing', 'answered', 'wrapup'] as const;
export type CallUiState = (typeof CALL_UI_STATES)[number];

/** Phases in which a call is on the wire (blocks a sequential dialer advance). */
export const LIVE_UI_STATES = ['dialing', 'ringing', 'answered'] as const;

export function isLiveState(state: CallUiState): boolean {
  return (LIVE_UI_STATES as readonly string[]).includes(state);
}

/**
 * The next phase the connect simulation advances to, or `null` at a resting
 * phase (`answered` waits for the rep; `wrapup` is terminal for the sim). A WS
 * `call.state` source would replace this driver, feeding real phases instead.
 */
export function nextConnectState(state: CallUiState): CallUiState | null {
  switch (state) {
    case 'dialing':
      return 'ringing';
    case 'ringing':
      return 'answered';
    default:
      return null;
  }
}

/** Believable connect timings (ms) for the simulation; overridable in tests. */
export interface CallTimings {
  /** dialing → ringing. */
  dialMs: number;
  /** ringing → answered. */
  ringMs: number;
}

export const DEFAULT_CALL_TIMINGS: CallTimings = { dialMs: 1100, ringMs: 2600 };

/**
 * Terminal C1 `calls.status` for a logged outcome. The mock finalizer stamps
 * this on the row when the rep saves the outcome (the demo's stand-in for the
 * status-callback worker); the mapping is intentionally small and explicit.
 */
export type CallOutcomeDisposition = 'completed' | 'missed' | 'voicemail';

const OUTCOME_STATUS: Record<CallOutcomeDisposition, Call['status']> = {
  completed: 'completed',
  missed: 'missed',
  voicemail: 'voicemail',
};

export function dispositionToStatus(disposition: CallOutcomeDisposition): Call['status'] {
  return OUTCOME_STATUS[disposition];
}
