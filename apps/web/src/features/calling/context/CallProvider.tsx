import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { JSX, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../../auth/AuthProvider.tsx';
import { useToast } from '../../../feedback/ToastProvider.tsx';
import { ApiError } from '../../../api/errors.ts';
import { advanceDialer, dialCall, dropVoicemail, patchCall } from '../api/calling.ts';
import {
  DEFAULT_CALL_TIMINGS,
  nextConnectState,
  type CallTimings,
  type CallUiState,
} from '../lib/lifecycle.ts';
import { CallStrip } from '../components/CallStrip.tsx';
import '../calling.css';

/*
 * App-level calling context. Owns the ONE active call at a time and mounts the
 * global call strip once, above the routes, so a call summoned from the lead
 * page seam / list dialer / command palette survives route changes (mirrors
 * CommsProvider). Wire at merge by wrapping the authenticated shell subtree
 * (see routeWiring):  <CallProvider> … ShellChrome … </CallProvider>.
 *
 * The connect leg (dialing → ringing → answered) is SIMULATED on an injectable
 * clock — there is no Twilio callback stream in the demo. The CONTRACTS §C7 WS
 * `call.state` frame is a cache-invalidation hint that would drive these
 * transitions in production; a WS source would replace the timer here and feed
 * `applyStateHint`-style updates without touching the strip. Clock + timings are
 * injectable so tests advance deterministically without global fake timers.
 */

export interface CallClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
}

export const systemClock: CallClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
};

export type CallVia = 'dial' | 'advance';

/** What a caller (launcher / dialer / palette) knows about who to call. */
export interface CallTarget {
  leadId: string;
  leadName: string;
  contactId?: string | null;
  contactName?: string | null;
  /** Explicit number (the dialer passes the queue entry's phone); else resolved. */
  to?: string;
  recordOptOut?: boolean;
}

export interface CallSession {
  callId: string;
  callSid: string;
  leadId: string;
  contactId: string | null;
  leadName: string;
  contactName: string | null;
  number: string;
  recording: boolean;
  uiState: CallUiState;
  /** Epoch ms when the call was answered (drives the live duration timer). */
  answeredAtMs: number | null;
  /** Epoch ms when the call left the wire (freezes the final duration). */
  endedAtMs: number | null;
  muted: boolean;
  onHold: boolean;
  voicemailDropped: boolean;
  via: CallVia;
}

export type StartReason = 'blocked' | 'busy' | 'no-number' | 'error';
export type StartResult = { ok: true; callId: string } | { ok: false; reason: StartReason };

export interface StartOptions {
  via?: CallVia;
  origin?: 'keyboard' | 'pointer';
}

interface CallContextValue {
  session: CallSession | null;
  /** A call is in progress (live or in wrap-up) — one at a time. */
  isBusy: boolean;
  /** The lead currently in view (set by the lead-page launcher) for palette/`C`. */
  focusTarget: CallTarget | null;
  setFocusTarget: (target: CallTarget | null) => void;
  startCall: (target: CallTarget, opts?: StartOptions) => Promise<StartResult>;
  toggleMute: () => void;
  toggleHold: () => void;
  hangUp: () => void;
  /** Drop a pre-recorded voicemail asset; resolves true on success. */
  dropVoicemailAsset: (recordingRef: string) => Promise<boolean>;
  /** Log the call outcome (+ optional note); resolves true on success. */
  saveOutcome: (input: { outcome: string; notes?: string }) => Promise<boolean>;
  discard: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

export interface CallProviderProps {
  children: ReactNode;
  /** Injectable clock (tests pass a controllable one). Defaults to system. */
  clock?: CallClock;
  /** Connect-leg timings; tests pass `{dialMs:0,ringMs:0}` to reach answered fast. */
  timings?: CallTimings;
}

export function CallProvider({
  children,
  clock = systemClock,
  timings = DEFAULT_CALL_TIMINGS,
}: CallProviderProps): JSX.Element {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<CallSession | null>(null);
  const [focusTarget, setFocusTarget] = useState<CallTarget | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clock.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [clock]);

  // Connect-leg simulation: each live phase schedules the next. Re-runs on every
  // phase change; cleanup clears the pending timer (so hang-up cannot stale-advance).
  useEffect(() => {
    if (session === null) return;
    const phase = session.uiState;
    const next = nextConnectState(phase);
    if (next === null) return;
    const delay = phase === 'dialing' ? timings.dialMs : timings.ringMs;
    const id = clock.setTimeout(() => {
      setSession((s) =>
        s && s.uiState === phase
          ? {
              ...s,
              uiState: next,
              answeredAtMs: next === 'answered' ? clock.now() : s.answeredAtMs,
            }
          : s,
      );
    }, delay);
    timerRef.current = id;
    return () => clock.clearTimeout(id);
    // Deps are the phase-identifying fields (callId + uiState) plus the stable
    // clock/timings — re-running on any other session field is intentional noise.
  }, [session?.callId, session?.uiState, clock, timings]);

  const closeSession = useCallback(() => {
    clearTimer();
    setSession(null);
  }, [clearTimer]);

  const startCall = useCallback(
    async (target: CallTarget, opts?: StartOptions): Promise<StartResult> => {
      if (session !== null) {
        toast('Finish the current call first');
        return { ok: false, reason: 'busy' };
      }
      const userId = user?.id;
      if (!userId) {
        toast('Sign in to place a call');
        return { ok: false, reason: 'error' };
      }
      const via = opts?.via ?? 'dial';
      const input = {
        userId,
        leadId: target.leadId,
        ...(target.contactId ? { contactId: target.contactId } : {}),
        ...(target.to ? { to: target.to } : {}),
        ...(target.recordOptOut ? { recordOptOut: target.recordOptOut } : {}),
      };
      try {
        const result = await (via === 'advance' ? advanceDialer(input) : dialCall(input));
        setSession({
          callId: result.callId,
          callSid: result.callSid,
          leadId: target.leadId,
          contactId: target.contactId ?? null,
          leadName: target.leadName,
          contactName: target.contactName ?? null,
          number: result.to,
          recording: result.recording,
          uiState: 'dialing',
          answeredAtMs: null,
          endedAtMs: null,
          muted: false,
          onHold: false,
          voicemailDropped: false,
          via,
        });
        return { ok: true, callId: result.callId };
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'SUPPRESSED') {
            toast(`Blocked — ${target.leadName} is on the do-not-contact list`);
            return { ok: false, reason: 'blocked' };
          }
          if (err.code === 'CONFLICT') {
            toast('Finish the current call first');
            return { ok: false, reason: 'busy' };
          }
          if (err.code === 'VALIDATION_FAILED') {
            toast(`No phone number on file for ${target.leadName}`);
            return { ok: false, reason: 'no-number' };
          }
          toast(err.message);
          return { ok: false, reason: 'error' };
        }
        toast('Could not place the call');
        return { ok: false, reason: 'error' };
      }
    },
    [session, user?.id, toast],
  );

  const toggleMute = useCallback(() => {
    setSession((s) => (s ? { ...s, muted: !s.muted } : s));
  }, []);

  const toggleHold = useCallback(() => {
    setSession((s) => (s ? { ...s, onHold: !s.onHold } : s));
  }, []);

  const hangUp = useCallback(() => {
    clearTimer();
    setSession((s) =>
      s ? { ...s, uiState: 'wrapup', endedAtMs: clock.now(), muted: false, onHold: false } : s,
    );
  }, [clearTimer, clock]);

  const discard = useCallback(() => {
    closeSession();
  }, [closeSession]);

  const saveOutcome = useCallback(
    async (input: { outcome: string; notes?: string }): Promise<boolean> => {
      if (session === null) return false;
      const { leadId } = session;
      try {
        await patchCall(session.callId, {
          outcome: input.outcome,
          ...(input.notes && input.notes.trim().length > 0 ? { notes: input.notes } : {}),
          ...(user?.id ? { actorId: user.id } : {}),
        });
        // The engine lands a call_logged activity — refresh the timeline, the lead,
        // and the call-summaries rail so the logged call appears without a reload.
        void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
        void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
        void queryClient.invalidateQueries({ queryKey: ['ai-lead-calls', leadId] });
        toast(`Call logged — ${input.outcome}`);
        closeSession();
        return true;
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Could not log the call');
        return false;
      }
    },
    [session, user?.id, toast, closeSession, queryClient],
  );

  const dropVoicemailAsset = useCallback(
    async (recordingRef: string): Promise<boolean> => {
      if (session === null) return false;
      const { leadId } = session;
      try {
        await dropVoicemail(session.callId, {
          recordingRef,
          ...(user?.id ? { actorId: user.id } : {}),
        });
        // Dropping voicemail finalizes the call with a call_logged activity — refresh
        // the same surfaces so the timeline and summaries rail stay in sync.
        void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
        void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
        void queryClient.invalidateQueries({ queryKey: ['ai-lead-calls', leadId] });
        clearTimer();
        toast('Voicemail dropped');
        closeSession();
        return true;
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Could not drop the voicemail');
        return false;
      }
    },
    [session, user?.id, toast, clearTimer, closeSession, queryClient],
  );

  const value = useMemo<CallContextValue>(
    () => ({
      session,
      isBusy: session !== null,
      focusTarget,
      setFocusTarget,
      startCall,
      toggleMute,
      toggleHold,
      hangUp,
      dropVoicemailAsset,
      saveOutcome,
      discard,
    }),
    [
      session,
      focusTarget,
      startCall,
      toggleMute,
      toggleHold,
      hangUp,
      dropVoicemailAsset,
      saveOutcome,
      discard,
    ],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      <CallStrip
        session={session}
        clock={clock}
        onToggleMute={toggleMute}
        onToggleHold={toggleHold}
        onHangUp={hangUp}
        onDiscard={discard}
        onSaveOutcome={saveOutcome}
        onDropVoicemail={dropVoicemailAsset}
      />
    </CallContext.Provider>
  );
}

/** Access the call controls. Must be used within {@link CallProvider}. */
export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used within a CallProvider');
  return ctx;
}
