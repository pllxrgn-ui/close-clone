import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { Contact, Lead, Snippet, Template } from '@switchboard/shared';
import { server } from '../../../mocks/server.ts';
import { commsHandlers } from '../mocks/commsHandlers.ts';
import { commsStore, resetCommsStore } from '../data/store.ts';
import { Composer } from './Composer.tsx';
import {
  api,
  makeContact,
  makeLead,
  makeSnippet,
  makeTemplate,
  makeUser,
  renderComms,
} from '../test/harness.tsx';

let user: ReturnType<typeof userEvent.setup>;

interface StubOpts {
  lead?: Lead;
  contacts?: Contact[];
  templates?: Template[];
  snippets?: Snippet[];
  suppressed?: string[];
}

function stubComposer(opts: StubOpts = {}): void {
  const lead = opts.lead ?? makeLead();
  const contacts = opts.contacts ?? [
    makeContact({ emails: [{ email: 'sam@x.com', type: 'work' }] }),
  ];
  const templates = opts.templates ?? [makeTemplate()];
  const snippets = opts.snippets ?? [];
  server.use(
    http.get(api('/leads/:id'), () => HttpResponse.json(lead)),
    http.get(api('/contacts'), () => HttpResponse.json(contacts)),
    http.get(api('/users'), () => HttpResponse.json([makeUser()])),
    http.get(api('/templates'), () => HttpResponse.json(templates)),
    http.get(api('/snippets'), () => HttpResponse.json(snippets)),
    http.get(api('/emails/suppressed-recipients'), () =>
      HttpResponse.json({ emails: opts.suppressed ?? [] }),
    ),
  );
}

beforeEach(() => {
  resetCommsStore();
  server.use(...commsHandlers);
  user = userEvent.setup();
});
afterEach(cleanup);

describe('Composer — merge tags', () => {
  test('resolves tags in a live preview and sends → outbox grows + toast', async () => {
    stubComposer();
    const before = commsStore.outbox.length;
    renderComms(<Composer open onClose={() => {}} leadId="L1" />);

    await screen.findByLabelText('Subject');
    await user.selectOptions(screen.getByLabelText('Template'), 't1');

    const preview = screen.getByRole('region', { name: 'Preview' });
    await within(preview).findByText('North Labs'); // {{lead.name}} resolved
    expect(within(preview).getByText('Sam')).toBeInTheDocument(); // {{contact.first_name}}
    expect(within(preview).getByText('Ben Reyes')).toBeInTheDocument(); // {{owner.name}}

    const send = screen.getByRole('button', { name: /Send/ });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    expect(await screen.findByText(/Email sent to sam@x.com/)).toBeInTheDocument();
    expect(commsStore.outbox.length).toBe(before + 1);
    expect(commsStore.outbox[0]?.subject).toBe('Hi North Labs');
  });

  test('an unresolved tag shows an amber token, a warning, and blocks Send', async () => {
    stubComposer({
      templates: [
        makeTemplate({
          id: 't1',
          name: 'Intro',
          subject: 'Hi {{lead.name}}',
          body: 'Hey {{contact.first_name}} — re {{deal.stage}}',
        }),
      ],
    });
    renderComms(<Composer open onClose={() => {}} leadId="L1" />);

    await screen.findByLabelText('Subject');
    await user.selectOptions(screen.getByLabelText('Template'), 't1');

    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(await within(preview).findByText('{{deal.stage}}')).toBeInTheDocument();
    expect(screen.getByText(/1 unresolved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
  });
});

describe('Composer — compliance rails', () => {
  test('a DNC lead shows the rail and disables Send even with a full message', async () => {
    stubComposer({ lead: makeLead({ dnc: true }) });
    renderComms(<Composer open onClose={() => {}} leadId="L1" />);

    await screen.findByLabelText('Subject');
    expect(screen.getByRole('alert')).toHaveTextContent(/do-not-contact/i);
    expect(screen.getByText('Do not contact')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Template'), 't1');
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
  });

  test('a suppressed recipient shows the rail and disables Send', async () => {
    stubComposer({
      contacts: [makeContact({ emails: [{ email: 'sam@x.com', type: 'work' }] })],
      suppressed: ['sam@x.com'],
    });
    renderComms(<Composer open onClose={() => {}} leadId="L1" />);

    await screen.findByLabelText('Subject');
    expect(screen.getByRole('alert')).toHaveTextContent(/suppressed/i);
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
  });

  test('the server refuses a suppressed send even if the UI is bypassed (I-RAIL-API)', async () => {
    // Drive the real POST handler directly with a seeded-suppressed address: the
    // rail lives in the engine layer, so a caller that skipped the UI still 422s.
    const suppressed = [...commsStore.suppressedEmails][0];
    expect(suppressed).toBeTruthy();
    const res = await fetch('/api/v1/emails/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: 'L1', to: [suppressed], subject: 'Hi', body: 'Hi' }),
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('SUPPRESSED');
  });
});

describe('Composer — snippet autocomplete', () => {
  test('typing /shortcut inserts the snippet body', async () => {
    stubComposer({
      snippets: [makeSnippet({ shortcut: 'avail', body: 'I am available Thursday' })],
    });
    renderComms(<Composer open onClose={() => {}} leadId="L1" />);

    const body = (await screen.findByLabelText('Message body')) as HTMLTextAreaElement;
    await user.click(body);
    await user.type(body, '/av');

    const option = await screen.findByRole('option', { name: /avail/ });
    expect(option).toBeInTheDocument();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(body.value).toContain('I am available Thursday'));
    expect(screen.queryByRole('option', { name: /avail/ })).toBeNull(); // menu closed
  });
});
