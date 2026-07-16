import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server.ts';
import { commsHandlers } from '../mocks/commsHandlers.ts';
import { commsStore, enrollmentCounts, resetCommsStore } from '../data/store.ts';
import { db } from '../../../mocks/fixtures.ts';
import { SequencesList } from './SequencesList.tsx';
import { SequenceDetail } from './SequenceDetail.tsx';
import { api, makeContact, renderComms } from '../test/harness.tsx';

/** A real fixture lead (unique name) + live non-DNC contact not enrolled in `seqId`.
 *  The enroll handler now validates targets against the fixture db (matching the
 *  real API), so the drawer must enroll an actual lead/contact, not a synthetic id. */
function pickRealEnrollable(seqId: string): {
  leadId: string;
  leadName: string;
  contactId: string;
  contactName: string;
} {
  const nameCounts = new Map<string, number>();
  for (const l of db.leads) nameCounts.set(l.name, (nameCounts.get(l.name) ?? 0) + 1);
  const taken = new Set(
    commsStore.enrollments.filter((e) => e.sequenceId === seqId).map((e) => e.contactId),
  );
  for (const lead of db.leads) {
    if (lead.dnc || lead.deletedAt !== null || nameCounts.get(lead.name) !== 1) continue;
    const contact = db.contacts.find(
      (c) => c.leadId === lead.id && c.deletedAt === null && !c.dnc && !taken.has(c.id),
    );
    if (contact) {
      return {
        leadId: lead.id,
        leadName: lead.name,
        contactId: contact.id,
        contactName: contact.name,
      };
    }
  }
  throw new Error('fixture has no unique-named enrollable lead');
}

/** Escape a fixture name for a substring accessible-name RegExp matcher. */
function rx(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

let user: ReturnType<typeof userEvent.setup>;

function onboardingId(): string {
  const seq = commsStore.sequences.find((s) => s.name === 'Onboarding');
  if (!seq) throw new Error('Onboarding sequence missing from seed');
  return seq.id;
}

beforeEach(() => {
  resetCommsStore();
  server.use(...commsHandlers);
  user = userEvent.setup();
});
afterEach(cleanup);

describe('SequencesList', () => {
  test('renders each sequence with step + enrollment counts', async () => {
    renderComms(<SequencesList />, '/sequences');
    const row = await screen.findByRole('button', { name: /Onboarding/ });
    expect(within(row).getByText('3 steps')).toBeInTheDocument();
    expect(within(row).getByText('6')).toBeInTheDocument(); // active
    expect(within(row).getByText('2')).toBeInTheDocument(); // paused
    // Archived sequence is still listed.
    expect(screen.getByRole('button', { name: /Win-back 2024/ })).toBeInTheDocument();
  });
});

describe('SequenceDetail — compliance + ladder', () => {
  test('shows the reply-pauses-everything guarantee and the review flag', async () => {
    renderComms(<SequenceDetail sequenceId={onboardingId()} />, '/sequences/x');
    await screen.findByRole('heading', { name: 'Onboarding', level: 1 });
    expect(screen.getByText('A reply pauses everything')).toBeInTheDocument();
    expect(screen.getByText(/I-SEND-2/)).toBeInTheDocument();
    // Step ladder rendered with a review-gated step and resolved template names.
    // ("Needs review" appears on the step pill AND in the explanatory note.)
    expect((await screen.findAllByText('Needs review')).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/Intro/)).toBeInTheDocument(); // step template name
  });
});

describe('SequenceDetail — mutations tick the counts', () => {
  test('enrolling a contact increments the active count', async () => {
    const seqId = onboardingId();
    const target = pickRealEnrollable(seqId);
    server.use(
      http.get(api('/search'), () =>
        HttpResponse.json({
          items: [
            {
              type: 'lead',
              id: target.leadId,
              leadId: target.leadId,
              title: target.leadName,
              subtitle: 'Potential',
            },
          ],
        }),
      ),
      http.get(api('/contacts'), () =>
        HttpResponse.json([
          makeContact({
            id: target.contactId,
            leadId: target.leadId,
            name: target.contactName,
            emails: [{ email: 'target@fixture.test', type: 'work' }],
          }),
        ]),
      ),
    );

    renderComms(<SequenceDetail sequenceId={seqId} />, '/sequences/x');
    await screen.findByRole('heading', { name: 'Onboarding', level: 1 });
    const activeBefore = enrollmentCounts(seqId).active;

    await user.click(screen.getByRole('button', { name: /Enroll/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Search leads'), target.leadName);
    await user.click(await within(dialog).findByRole('button', { name: rx(target.leadName) }));
    await user.click(await within(dialog).findByRole('radio', { name: rx(target.contactName) }));
    await user.click(within(dialog).getByRole('button', { name: 'Enroll' }));

    expect(await screen.findByText(/Enrolled in Onboarding/)).toBeInTheDocument();
    await waitFor(() => expect(enrollmentCounts(seqId).active).toBe(activeBefore + 1));
  });

  test('pausing an active enrollment moves it to paused', async () => {
    const seqId = onboardingId();
    renderComms(<SequenceDetail sequenceId={seqId} />, '/sequences/x');
    await screen.findByRole('heading', { name: 'Onboarding', level: 1 });
    await waitFor(() => expect(screen.getAllByText('Active')).toHaveLength(6));

    const pauseButtons = screen.getAllByRole('button', { name: /^Pause / });
    await user.click(pauseButtons[0] as HTMLElement);

    await waitFor(() => expect(screen.getAllByText('Active')).toHaveLength(5));
    expect(enrollmentCounts(seqId).active).toBe(5);
    expect(enrollmentCounts(seqId).paused).toBe(3);
    // A resume affordance now exists.
    expect(screen.getAllByRole('button', { name: /^Resume / }).length).toBeGreaterThan(0);
  });

  test('an archived sequence cannot take new enrollments (Enroll disabled)', async () => {
    const archived = commsStore.sequences.find((s) => s.status === 'archived');
    if (!archived) throw new Error('expected an archived sequence in the seed');
    renderComms(<SequenceDetail sequenceId={archived.id} />, '/sequences/x');
    await screen.findByRole('heading', { name: archived.name, level: 1 });
    expect(screen.getByRole('button', { name: /Enroll/ })).toBeDisabled();
  });
});
