import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ACTIVITY_TYPES } from '@switchboard/shared';
import type { Activity } from '@switchboard/shared';
import { Timeline, groupEventsByDay } from './Timeline.tsx';
import { resolveEventMeta } from '../events/eventMeta.tsx';
import { REF_NOW, hoursAgo, makeActivity } from '../test/factories.ts';

afterEach(cleanup);

const userName = (id: string | null): string => (id ? 'Ben Reyes' : '—');

const noop = (): void => {};

function baseProps() {
  return {
    userName,
    now: REF_NOW,
    isLoading: false,
    isError: false,
    onRetry: noop,
    hasMore: false,
    onLoadMore: noop,
    loadingMore: false,
  };
}

describe('groupEventsByDay', () => {
  test('groups contiguous same-day events and preserves order', () => {
    // Local-constructed instants keep the calendar-day comparison tz-independent.
    const localNow = new Date(2026, 6, 15, 12);
    const events: Activity[] = [
      makeActivity({ occurredAt: new Date(2026, 6, 15, 10).toISOString() }),
      makeActivity({ occurredAt: new Date(2026, 6, 15, 9).toISOString() }),
      makeActivity({ occurredAt: new Date(2026, 6, 13, 9).toISOString() }),
    ];
    const groups = groupEventsByDay(events, localNow);
    expect(groups.length).toBe(2);
    expect(groups[0]?.events.length).toBe(2);
    expect(groups[1]?.events.length).toBe(1);
  });
});

describe('Timeline — C4 coverage', () => {
  test('renders every C4 activity type with its dedicated label (no unknown fallback)', () => {
    // One event per taxonomy member, spread across several days so groups form.
    const events: Activity[] = ACTIVITY_TYPES.map((type, i) =>
      makeActivity({ type, occurredAt: hoursAgo(i * 5), userId: i % 2 === 0 ? 'u1' : null }),
    );
    render(<Timeline events={events} {...baseProps()} />);

    for (const type of ACTIVITY_TYPES) {
      const label = resolveEventMeta(type).label;
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(document.querySelectorAll('.tl-event').length).toBe(ACTIVITY_TYPES.length);
    // Multiple day groups formed.
    expect(document.querySelectorAll('.tl-day').length).toBeGreaterThan(1);
  });

  test('renders payload-derived detail lines', () => {
    const events: Activity[] = [
      makeActivity({ type: 'email_received', payload: { subject: 'Re: pricing' } }),
      makeActivity({ type: 'status_changed', payload: { from: 'Potential', to: 'Qualified' } }),
    ];
    render(<Timeline events={events} {...baseProps()} />);
    expect(screen.getByText('Re: pricing')).toBeInTheDocument();
    expect(screen.getByText('Potential → Qualified')).toBeInTheDocument();
  });
});

describe('Timeline — states', () => {
  test('loading state', () => {
    render(<Timeline events={[]} {...baseProps()} isLoading />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  test('empty state', () => {
    render(<Timeline events={[]} {...baseProps()} />);
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });

  test('error state offers retry', async () => {
    const onRetry = vi.fn();
    render(<Timeline events={[]} {...baseProps()} isError errorMessage="nope" onRetry={onRetry} />);
    expect(screen.getByText('Couldn’t load the timeline')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test('keyset "load older" fires onLoadMore', async () => {
    const onLoadMore = vi.fn();
    render(
      <Timeline
        events={[makeActivity({ type: 'note_added' })]}
        {...baseProps()}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /load older/i }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});

describe('Timeline — expandable rows', () => {
  test('a row is a disclosure: click reveals payload facts + absolute time, click again collapses', async () => {
    const events = [
      makeActivity({
        type: 'email_received',
        occurredAt: hoursAgo(2),
        payload: { subject: 'Re: pilot rollout', snippet: 'Thursday works — send the order form.' },
      }),
    ];
    render(<Timeline {...baseProps()} events={events} />);

    const row = screen.getByRole('button', { name: /Email received/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    // Per-type payload facts…
    expect(screen.getByText('Subject')).toBeInTheDocument();
    expect(screen.getByText('Thursday works — send the order form.')).toBeInTheDocument();
    // …plus the absolute timestamp that used to hide in a tooltip.
    expect(screen.getByText('When')).toBeInTheDocument();

    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('When')).not.toBeInTheDocument();
  });

  test('the contact resolves by id in the expanded facts', async () => {
    const events = [
      makeActivity({
        type: 'sequence_enrolled',
        contactId: 'c9',
        userId: 'u1',
        payload: { sequence: 'Onboarding' },
      }),
    ];
    render(
      <Timeline
        {...baseProps()}
        contactName={(id) => (id === 'c9' ? 'Quinn Larsen' : '—')}
        events={events}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Enrolled in sequence/ }));
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByText('Quinn Larsen')).toBeInTheDocument();
  });
});
