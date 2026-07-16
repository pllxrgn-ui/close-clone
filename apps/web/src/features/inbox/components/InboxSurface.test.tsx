import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../../mocks/server.ts';
import { inboxHandlers } from '../mocks/inboxHandlers.ts';
import { loadInboxStore, resetInboxStore } from '../model/store.ts';
import {
  makeReview,
  makeStore,
  makeTask,
  makeThread,
  renderInbox,
  statValue,
} from '../test/harness.tsx';

beforeEach(() => {
  resetInboxStore();
  server.use(...inboxHandlers);
});
afterEach(cleanup);

describe('Inbox surface — rendering', () => {
  test('merges the three sources into labelled sections with live stats', async () => {
    renderInbox();
    await screen.findByRole('heading', { name: 'Inbox', level: 1 });

    expect(await screen.findByRole('heading', { level: 2, name: /Overdue/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: /Replies/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: /Review/i })).toBeInTheDocument();

    expect(
      (await screen.findAllByRole('button', { name: /^Complete task for/ })).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^Reply to/ }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /^Approve sequence step for/ }).length,
    ).toBeGreaterThan(0);
  });
});

describe('Inbox surface — pointer actions mutate + remove + update stats', () => {
  // Controlled stores with distinct lead names (the 224-lead fixture can repeat a
  // company name, which would make a name-based row assertion ambiguous).
  const twoLeads: Array<[string, string]> = [
    ['L1', 'North Labs'],
    ['L2', 'Cedar Systems'],
  ];
  const twoLeadsLive: Array<[string, boolean]> = [
    ['L1', false],
    ['L2', false],
  ];

  test('completing a task removes its row and bumps Done today', async () => {
    loadInboxStore(
      makeStore({
        tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2', leadId: 'L2', title: 'Send recap' })],
        leadNames: twoLeads,
        leadDnc: twoLeadsLive,
      }),
    );
    const user = userEvent.setup();
    const { container } = renderInbox();
    const first = await screen.findByRole('button', { name: 'Complete task for North Labs' });
    const beforeNeeds = statValue(container, 'neutral');
    const beforeDone = statValue(container, 'done');

    await user.click(first);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Complete task for North Labs' })).toBeNull(),
    );
    await waitFor(() => expect(statValue(container, 'done')).toBe(beforeDone + 1));
    expect(statValue(container, 'neutral')).toBe(beforeNeeds - 1);
  });

  test('replying opens the composer, sends, and clears the row', async () => {
    loadInboxStore(
      makeStore({
        threads: [makeThread({ id: 'r1' })],
        tasks: [makeTask({ id: 't1', leadId: 'L2' })],
        leadNames: twoLeads,
        leadDnc: twoLeadsLive,
      }),
    );
    const user = userEvent.setup();
    const { container } = renderInbox();
    const replyBtn = await screen.findByRole('button', { name: 'Reply to North Labs' });
    const beforeDone = statValue(container, 'done');

    await user.click(replyBtn);
    const dialog = await screen.findByRole('dialog', { name: 'Reply to North Labs' });
    await user.type(within(dialog).getByLabelText('Message'), 'Thanks — answers below.');
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reply to North Labs' })).toBeNull(),
    );
    expect(statValue(container, 'done')).toBe(beforeDone + 1);
  });

  test('approving a review step removes it', async () => {
    loadInboxStore(makeStore({ reviews: [makeReview({ id: 'v1' })] }));
    const user = userEvent.setup();
    renderInbox();
    const approveBtn = await screen.findByRole('button', {
      name: 'Approve sequence step for North Labs',
    });
    await user.click(approveBtn);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Approve sequence step for North Labs' }),
      ).toBeNull(),
    );
  });

  test('a completed row stays gone after the surface remounts (writes survive nav)', async () => {
    loadInboxStore(
      makeStore({
        tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2', leadId: 'L2', title: 'Send recap' })],
        leadNames: [
          ['L1', 'North Labs'],
          ['L2', 'Cedar Systems'],
        ],
        leadDnc: [
          ['L1', false],
          ['L2', false],
        ],
      }),
    );
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole('button', { name: 'Complete task for North Labs' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Complete task for North Labs' })).toBeNull(),
    );

    cleanup();
    renderInbox();
    // The remount re-fetches from the same module store — the task is still done.
    await screen.findByRole('button', { name: 'Complete task for Cedar Systems' });
    expect(screen.queryByRole('button', { name: 'Complete task for North Labs' })).toBeNull();
  });
});

describe('Inbox surface — keyboard path end to end', () => {
  test('C completes the active task and reveals the zero-inbox state', async () => {
    loadInboxStore(makeStore({ tasks: [makeTask({ id: 't1' })] }));
    const user = userEvent.setup();
    const { container } = renderInbox();
    await screen.findByRole('button', { name: 'Complete task for North Labs' });

    await user.keyboard('c');

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Complete task for North Labs' })).toBeNull(),
    );
    expect(statValue(container, 'done')).toBe(1);
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  test('R opens the composer and ⌘/Ctrl+Enter sends', async () => {
    loadInboxStore(makeStore({ threads: [makeThread({ id: 'r1' })] }));
    const user = userEvent.setup();
    renderInbox();
    await screen.findByRole('button', { name: 'Reply to North Labs' });

    await user.keyboard('r');
    const dialog = await screen.findByRole('dialog', { name: 'Reply to North Labs' });
    await user.type(within(dialog).getByLabelText('Message'), 'On it.');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reply to North Labs' })).toBeNull(),
    );
  });

  test('A approves then X skips, with J moving the active row between them', async () => {
    loadInboxStore(
      makeStore({
        reviews: [makeReview({ id: 'v1' }), makeReview({ id: 'v2', leadId: 'L2' })],
        leadNames: [
          ['L1', 'North Labs'],
          ['L2', 'Cedar Systems'],
        ],
        leadDnc: [
          ['L1', false],
          ['L2', false],
        ],
      }),
    );
    const user = userEvent.setup();
    const { container } = renderInbox();
    await screen.findByRole('button', { name: 'Approve sequence step for North Labs' });

    // J moves selection to the second row.
    await user.keyboard('j');
    await waitFor(() =>
      expect(container.querySelectorAll('.sb-inbox__row')[1]?.getAttribute('data-active')).toBe(
        'true',
      ),
    );
    // X skips the active (second) review.
    await user.keyboard('x');
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Approve sequence step for Cedar Systems' }),
      ).toBeNull(),
    );
    // A approves the remaining review.
    await user.keyboard('a');
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Approve sequence step for North Labs' }),
      ).toBeNull(),
    );
  });

  test('S snoozes the active row without counting it as done', async () => {
    loadInboxStore(makeStore({ tasks: [makeTask({ id: 't1' })] }));
    const user = userEvent.setup();
    const { container } = renderInbox();
    await screen.findByRole('button', { name: 'Complete task for North Labs' });
    const beforeDone = statValue(container, 'done');

    await user.keyboard('s');

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Complete task for North Labs' })).toBeNull(),
    );
    expect(statValue(container, 'done')).toBe(beforeDone);
  });
});

describe('Inbox surface — compliance + failure paths', () => {
  test('sending a reply to a DNC lead surfaces the suppression error and keeps the row', async () => {
    loadInboxStore(
      makeStore({
        threads: [makeThread({ id: 'r1', leadId: 'D1' })],
        leadNames: [['D1', 'Sable Freight']],
        leadDnc: [['D1', true]],
      }),
    );
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByRole('button', { name: 'Reply to Sable Freight' }));

    const dialog = await screen.findByRole('dialog', { name: 'Reply to Sable Freight' });
    await user.type(within(dialog).getByLabelText('Message'), 'hello');
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/do-not-contact/i);
    // The composer stays open and the row is not cleared (never bypass the rail).
    expect(screen.getByRole('dialog', { name: 'Reply to Sable Freight' })).toBeInTheDocument();
  });
});
