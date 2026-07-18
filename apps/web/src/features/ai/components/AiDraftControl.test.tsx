import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server.ts';
import { aiHandlers } from '../mocks/aiHandlers.ts';
import { AiDraftControl } from './AiDraftControl.tsx';
import { api, renderAi } from '../test/harness.tsx';

/*
 * The composer seam (§I-AI): "Draft with AI" / "Rewrite" fills the composer via
 * onApply — the human still presses Send. This component has NO send capability;
 * the test also proves no /emails/send request is ever made.
 */

beforeEach(() => server.use(...aiHandlers));
afterEach(() => cleanup());

describe('AiDraftControl', () => {
  test('draft flow: instruction → draft → Insert calls onApply, never sends', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    let sendCalled = false;
    server.use(
      http.post(api('/emails/send'), () => {
        sendCalled = true;
        return HttpResponse.json({ message: {} }, { status: 201 });
      }),
    );

    renderAi(<AiDraftControl subject="" body="" onApply={onApply} />);

    // Empty body → only the Draft affordance (no Rewrite yet).
    expect(screen.queryByRole('button', { name: /rewrite/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /draft with ai/i }));

    const instruction = await screen.findByLabelText(/what should the ai write/i);
    await user.type(instruction, 'Write a friendly first-touch intro');
    await user.click(screen.getByRole('button', { name: /generate draft/i }));

    // The draft is shown for review before anything is inserted.
    const insert = await screen.findByRole('button', { name: /insert into email/i });
    expect(screen.getByText(/you review (and|&) send/i)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    await user.click(insert);
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const applied = onApply.mock.calls[0]?.[0] as { body: string };
    expect(applied.body.length).toBeGreaterThan(0);
    // The composer's Send path was never touched by this control (§I-AI).
    expect(sendCalled).toBe(false);
  });

  test('rewrite flow: exposes Rewrite when a body exists and applies the result', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();

    renderAi(
      <AiDraftControl
        subject="Quick idea for North Labs"
        body="Hi Sam, wanted to reach out about our product. It saves time. Let me know."
        onApply={onApply}
      />,
    );

    await user.click(screen.getByRole('button', { name: /rewrite/i }));
    await user.click(screen.getByRole('button', { name: /generate draft/i }));

    const insert = await screen.findByRole('button', { name: /insert into email/i });
    await user.click(insert);
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const applied = onApply.mock.calls[0]?.[0] as { subject?: string; body: string };
    expect(applied.body.length).toBeGreaterThan(0);
  });

  test('discard closes the preview without applying', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    renderAi(<AiDraftControl subject="" body="" onApply={onApply} />);

    await user.click(screen.getByRole('button', { name: /draft with ai/i }));
    await user.type(screen.getByLabelText(/what should the ai write/i), 'Intro please');
    await user.click(screen.getByRole('button', { name: /generate draft/i }));
    await screen.findByRole('button', { name: /insert into email/i });

    await user.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.queryByRole('button', { name: /insert into email/i })).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  test('surfaces a provider error without applying', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    server.use(
      http.post(api('/ai/email-drafts'), () =>
        HttpResponse.json(
          { error: { code: 'PROVIDER_ERROR', message: 'the model is unavailable' } },
          { status: 502 },
        ),
      ),
    );

    renderAi(<AiDraftControl subject="" body="" onApply={onApply} />);
    await user.click(screen.getByRole('button', { name: /draft with ai/i }));
    await user.type(screen.getByLabelText(/what should the ai write/i), 'Intro please');
    await user.click(screen.getByRole('button', { name: /generate draft/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable|could not|error/i);
    expect(onApply).not.toHaveBeenCalled();
  });
});
