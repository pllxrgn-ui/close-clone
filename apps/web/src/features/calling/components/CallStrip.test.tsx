import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CallSession } from '../context/CallProvider.tsx';
import { CallStrip } from './CallStrip.tsx';
import { makeFakeClock, renderCalling } from '../test/harness.tsx';

/*
 * Unit tests for the global call strip in isolation — a fabricated session plus a
 * fake clock (no timers). Covers the answered controls (mute/hold/hang-up), the
 * recording consent indicator (I-REC), the voicemail-drop menu, and the hang-up
 * wrap-up outcome panel, plus the answered-only keyboard shortcuts.
 */

function answeredSession(over: Partial<CallSession> = {}): CallSession {
  return {
    callId: 'call-1',
    callSid: 'CA0001',
    leadId: 'L1',
    contactId: 'c1',
    leadName: 'North Labs',
    contactName: 'Sam Patel',
    number: '+12065550134',
    recording: true,
    uiState: 'answered',
    answeredAtMs: 0,
    endedAtMs: null,
    muted: false,
    onHold: false,
    voicemailDropped: false,
    via: 'dial',
    ...over,
  };
}

function noopHandlers() {
  return {
    onToggleMute: vi.fn(),
    onToggleHold: vi.fn(),
    onHangUp: vi.fn(),
    onDiscard: vi.fn(),
    onSaveOutcome: vi.fn().mockResolvedValue(true),
    onDropVoicemail: vi.fn().mockResolvedValue(true),
  };
}

afterEach(cleanup);

describe('CallStrip', () => {
  test('renders nothing when there is no active call', () => {
    const { container } = renderCalling(
      <CallStrip session={null} clock={makeFakeClock()} {...noopHandlers()} />,
    );
    expect(container.querySelector('.call-strip')).toBeNull();
  });

  test('answered call shows the number, live timer, and consent-announced recording', () => {
    renderCalling(
      <CallStrip session={answeredSession()} clock={makeFakeClock()} {...noopHandlers()} />,
    );
    expect(screen.getByRole('region', { name: /Call with North Labs/ })).toBeInTheDocument();
    expect(screen.getByText('(206) 555-0134')).toBeInTheDocument();
    expect(screen.getByText('0:00')).toBeInTheDocument();
    expect(screen.getByText(/Recording/)).toBeInTheDocument();
    expect(screen.getByText(/consent announced/)).toBeInTheDocument();
  });

  test('no recording indicator when the call is not recorded', () => {
    renderCalling(
      <CallStrip
        session={answeredSession({ recording: false })}
        clock={makeFakeClock()}
        {...noopHandlers()}
      />,
    );
    expect(screen.queryByText(/Recording/)).not.toBeInTheDocument();
  });

  test('mute and hang-up controls invoke their handlers', async () => {
    const handlers = noopHandlers();
    const user = userEvent.setup();
    renderCalling(<CallStrip session={answeredSession()} clock={makeFakeClock()} {...handlers} />);
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(handlers.onToggleMute).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /Hang up/ }));
    expect(handlers.onHangUp).toHaveBeenCalledTimes(1);
  });

  test('the M shortcut toggles mute only while answered', async () => {
    const handlers = noopHandlers();
    const user = userEvent.setup();
    renderCalling(<CallStrip session={answeredSession()} clock={makeFakeClock()} {...handlers} />);
    await user.keyboard('m');
    expect(handlers.onToggleMute).toHaveBeenCalledTimes(1);
  });

  test('voicemail menu drops the selected asset', async () => {
    const handlers = noopHandlers();
    const user = userEvent.setup();
    renderCalling(<CallStrip session={answeredSession()} clock={makeFakeClock()} {...handlers} />);
    await user.click(screen.getByRole('button', { name: 'Drop voicemail' }));
    await user.click(await screen.findByRole('menuitem', { name: /Intro — first touch/ }));
    expect(handlers.onDropVoicemail).toHaveBeenCalledWith('vm-intro-first-touch');
  });

  test('hang-up wrap-up: pick an outcome and log the call', async () => {
    const handlers = noopHandlers();
    const user = userEvent.setup();
    renderCalling(
      <CallStrip
        session={answeredSession({ uiState: 'wrapup', endedAtMs: 65_000 })}
        clock={makeFakeClock()}
        {...handlers}
      />,
    );
    // Frozen duration is shown (65s → 1:05).
    expect(screen.getByText('1:05')).toBeInTheDocument();
    const logBtn = screen.getByRole('button', { name: 'Log call' });
    expect(logBtn).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Meeting booked' }));
    await user.click(logBtn);
    expect(handlers.onSaveOutcome).toHaveBeenCalledWith({ outcome: 'Meeting booked' });
  });

  test('wrap-up discard bails out without logging', async () => {
    const handlers = noopHandlers();
    const user = userEvent.setup();
    renderCalling(
      <CallStrip
        session={answeredSession({ uiState: 'wrapup', endedAtMs: 1000 })}
        clock={makeFakeClock()}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(handlers.onDiscard).toHaveBeenCalledTimes(1);
    expect(handlers.onSaveOutcome).not.toHaveBeenCalled();
  });
});
