import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Button, IconButton, Menu, MenuItem } from '../../../ui/index.ts';
import { useKeyBindings } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';
import type { CallClock, CallSession } from '../context/CallProvider.tsx';
import { elapsedSeconds, formatCallDuration } from '../lib/duration.ts';
import { VOICEMAIL_ASSETS } from '../lib/presets.ts';
import { formatPhone } from '../lib/presets.ts';
import { OutcomePanel } from './OutcomePanel.tsx';
import {
  MicIcon,
  MicOffIcon,
  PauseIcon,
  PhoneOffIcon,
  PhoneOutgoingIcon,
  PlayIcon,
  RecordDotIcon,
  VoicemailIcon,
} from '../icons.tsx';

/*
 * The global call strip — a single app-wide docked console for the ONE active
 * call (mounted once by CallProvider). It progresses dialing → ringing →
 * answered with a live duration timer, exposes mute / hold / voicemail-drop /
 * hang-up, and shows a recording indicator whose consent line makes the I-REC
 * "consent announced before record" guarantee visible. On hang-up it becomes the
 * wrap-up panel (pick an outcome, log the call). Motion: the strip slides up on
 * enter (transform+opacity, <300ms) and drops the movement under reduced motion.
 */

/** Live-ticking elapsed seconds since answer (frozen once the call ends). */
function useElapsedSeconds(session: CallSession | null, clock: CallClock): number {
  const [, setTick] = useState(0);
  const ticking = session?.uiState === 'answered' && session.answeredAtMs !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = clock.setInterval(() => setTick((t) => (t + 1) % 1_000_000), 500);
    return () => clock.clearInterval(id);
  }, [ticking, clock]);
  if (session?.answeredAtMs == null) return 0;
  const end = session.uiState === 'answered' ? clock.now() : (session.endedAtMs ?? clock.now());
  return elapsedSeconds(session.answeredAtMs, end);
}

export interface CallStripProps {
  session: CallSession | null;
  clock: CallClock;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onHangUp: () => void;
  onDiscard: () => void;
  onSaveOutcome: (input: { outcome: string; notes?: string }) => Promise<boolean>;
  onDropVoicemail: (recordingRef: string) => Promise<boolean>;
}

const PHASE_LABEL: Partial<Record<CallSession['uiState'], string>> = {
  dialing: 'Dialing…',
  ringing: 'Ringing…',
};

export function CallStrip({
  session,
  clock,
  onToggleMute,
  onToggleHold,
  onHangUp,
  onDiscard,
  onSaveOutcome,
  onDropVoicemail,
}: CallStripProps): JSX.Element | null {
  const elapsed = useElapsedSeconds(session, clock);

  // Strip control shortcuts — active only while a call is answered (shown in `?`).
  const answered = session?.uiState === 'answered';
  const keyDefs: KeyBindingDef[] = [
    {
      id: 'calling:mute',
      combo: 'm',
      scope: 'global',
      label: session?.muted ? 'Unmute call' : 'Mute call',
      group: 'Active call',
      when: () => answered,
      handler: onToggleMute,
    },
    {
      id: 'calling:hold',
      combo: 'h',
      scope: 'global',
      label: session?.onHold ? 'Resume call' : 'Hold call',
      group: 'Active call',
      when: () => answered,
      handler: onToggleHold,
    },
  ];
  useKeyBindings(keyDefs);

  if (session === null) return null;

  const isWrapup = session.uiState === 'wrapup';
  const durationS =
    session.answeredAtMs !== null && session.endedAtMs !== null
      ? elapsedSeconds(session.answeredAtMs, session.endedAtMs)
      : session.answeredAtMs !== null
        ? elapsed
        : null;

  return (
    <aside
      className="call-strip"
      data-state={session.uiState}
      role="region"
      aria-label={`Call with ${session.leadName}`}
    >
      {isWrapup ? (
        <OutcomePanel
          leadName={session.leadName}
          number={formatPhone(session.number)}
          durationS={durationS}
          onSave={onSaveOutcome}
          onDiscard={onDiscard}
        />
      ) : (
        <div className="call-strip__live">
          <span
            className={`call-strip__lamp call-strip__lamp--${session.uiState}`}
            aria-hidden="true"
          />
          <div className="call-strip__who">
            <span className="call-strip__name">{session.leadName}</span>
            <span className="call-strip__meta">
              <PhoneOutgoingIcon size={12} />
              <span className="call-strip__num">{formatPhone(session.number)}</span>
              <span className="call-strip__phase" aria-live="polite">
                {session.uiState === 'answered'
                  ? session.onHold
                    ? 'On hold'
                    : formatCallDuration(elapsed)
                  : (PHASE_LABEL[session.uiState] ?? '')}
              </span>
            </span>
          </div>

          {session.recording ? (
            <span className="call-strip__rec" role="status">
              <RecordDotIcon size={9} className="call-strip__rec-dot" />
              <span className="call-strip__rec-text">
                Recording<span className="call-strip__rec-consent"> · consent announced</span>
              </span>
            </span>
          ) : null}

          <div className="call-strip__controls">
            <IconButton
              label={session.muted ? 'Unmute' : 'Mute'}
              title={session.muted ? 'Unmute (M)' : 'Mute (M)'}
              size="sm"
              aria-pressed={session.muted}
              className={session.muted ? 'is-on' : undefined}
              disabled={!answered}
              onClick={onToggleMute}
            >
              {session.muted ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
            </IconButton>

            <IconButton
              label={session.onHold ? 'Resume' : 'Hold'}
              title={session.onHold ? 'Resume (H)' : 'Hold (H)'}
              size="sm"
              aria-pressed={session.onHold}
              className={session.onHold ? 'is-on' : undefined}
              disabled={!answered}
              onClick={onToggleHold}
            >
              {session.onHold ? <PlayIcon size={16} /> : <PauseIcon size={16} />}
            </IconButton>

            <Menu
              label="Drop voicemail"
              align="end"
              trigger={(props) => (
                <IconButton {...props} label="Drop voicemail" size="sm" disabled={!answered}>
                  <VoicemailIcon size={16} />
                </IconButton>
              )}
            >
              {VOICEMAIL_ASSETS.map((asset) => (
                <MenuItem
                  key={asset.recordingRef}
                  onSelect={() => void onDropVoicemail(asset.recordingRef)}
                >
                  {asset.label}
                  <span className="call-strip__vm-dur"> · {asset.durationS}s</span>
                </MenuItem>
              ))}
            </Menu>

            <Button variant="danger" size="sm" className="call-strip__hangup" onClick={onHangUp}>
              <PhoneOffIcon size={15} /> Hang up
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}
