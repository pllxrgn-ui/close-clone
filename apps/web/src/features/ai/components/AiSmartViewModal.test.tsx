import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { JSX } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server.ts';
import { db } from '../../../mocks/fixtures.ts';
import { aiHandlers } from '../mocks/aiHandlers.ts';
import { AiSmartViewModal } from './AiSmartViewModal.tsx';
import { api, renderAi } from '../test/harness.tsx';

/*
 * NL → Smart View (§7 / §I-AI): NL box → /ai/smart-view → the UI RE-PARSES the DSL
 * (client authority) → shows the compiled preview → the user CONFIRMS to save/run.
 * Invalid DSL is a visible error, never auto-applied, never saved.
 */

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

beforeEach(() => server.use(...aiHandlers));
afterEach(() => cleanup());

describe('AiSmartViewModal', () => {
  test('valid NL → DSL preview → Create navigates to the saved view', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const before = db.smartViews.length;

    renderAi(
      <>
        <AiSmartViewModal open onClose={onClose} />
        <LocationProbe />
      </>,
      '/views',
    );

    await user.type(await screen.findByLabelText(/describe the view/i), 'show me won deals');
    await user.click(screen.getByRole('button', { name: /ask ai/i }));

    // The re-parsed DSL is shown (the client parser is the authority, not the model).
    expect(await screen.findByText('status = "Won"')).toBeInTheDocument();
    // A compiled preview: an estimated count + first rows.
    expect(await screen.findByText(/^≈[\d,]+$/)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();

    // Nothing is applied until the explicit confirm.
    expect(db.smartViews.length).toBe(before);
    await user.click(screen.getByRole('button', { name: /create smart view/i }));

    await waitFor(() => expect(db.smartViews.length).toBe(before + 1));
    const created = db.smartViews[db.smartViews.length - 1];
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent(`/views/${created?.id ?? 'x'}`),
    );
    expect(onClose).toHaveBeenCalled();
    // Reset the shared fixture so the added view doesn't leak into other tests.
    db.smartViews.length = before;
  });

  test('invalid AI DSL is shown as an error and cannot be saved', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const before = db.smartViews.length;

    renderAi(<AiSmartViewModal open onClose={onClose} />, '/views');

    // `raw:` pins the (invalid) model output verbatim so the guardrail is exercised.
    await user.type(await screen.findByLabelText(/describe the view/i), 'raw: status ==');
    await user.click(screen.getByRole('button', { name: /ask ai/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid/i);
    expect(screen.getByText('status ==')).toBeInTheDocument();
    expect(screen.getByText(/line \d+, col \d+/i)).toBeInTheDocument();
    // No save affordance for an invalid suggestion — never a saved guess.
    expect(screen.queryByRole('button', { name: /create smart view/i })).toBeNull();
    expect(db.smartViews.length).toBe(before);
  });

  test('an example chip fills the NL box', async () => {
    const user = userEvent.setup();
    renderAi(<AiSmartViewModal open onClose={vi.fn()} />, '/views');
    const input = await screen.findByLabelText(/describe the view/i);
    const example = screen.getAllByRole('button', { name: /no touch|won|do not contact/i })[0];
    if (!example) throw new Error('no example chip');
    await user.click(example);
    expect((input as HTMLInputElement).value.length).toBeGreaterThan(0);
  });

  test('surfaces a provider error (model declined) without saving', async () => {
    const user = userEvent.setup();
    const before = db.smartViews.length;
    server.use(
      http.post(api('/ai/smart-view'), () =>
        HttpResponse.json(
          { error: { code: 'PROVIDER_ERROR', message: 'the model declined' } },
          { status: 502 },
        ),
      ),
    );
    renderAi(<AiSmartViewModal open onClose={vi.fn()} />, '/views');
    await user.type(await screen.findByLabelText(/describe the view/i), 'anything at all');
    await user.click(screen.getByRole('button', { name: /ask ai/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/declined|could not|error/i);
    expect(db.smartViews.length).toBe(before);
  });
});
