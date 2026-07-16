import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { server } from '../../../mocks/server.ts';
import { renderReports } from '../test/harness.tsx';
import { reportsHandlers } from '../mocks/reportsHandlers.ts';
import { ReportsSurface } from './ReportsSurface.tsx';

beforeEach(() => server.use(...reportsHandlers));
afterEach(cleanup);

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('ReportsSurface', () => {
  test('defaults to Activity and switches families on click', async () => {
    renderReports(<ReportsSurface />, '/reports');
    expect(tab('Activity')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Calls logged')).toBeInTheDocument();

    fireEvent.click(tab('Funnel'));
    expect(tab('Funnel')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'USD pipeline' })).toBeInTheDocument();
    expect(screen.queryByText('Calls logged')).not.toBeInTheDocument();
  });

  test('deep-links a family from the URL', async () => {
    renderReports(<ReportsSurface />, '/reports?report=sequences');
    expect(tab('Sequences')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Cold Outreach — Q3')).toBeInTheDocument();
  });

  test('arrow keys move selection along the tablist (roving)', async () => {
    renderReports(<ReportsSurface />, '/reports?report=funnel');
    const tablist = screen.getByRole('tablist');
    tab('Funnel').focus(); // roving tabindex: arrows move relative to the focused tab
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    await waitFor(() => expect(tab('Sequences')).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(tablist, { key: 'ArrowRight' }); // wraps to Activity
    await waitFor(() => expect(tab('Activity')).toHaveAttribute('aria-selected', 'true'));
  });

  test('the 1/2/3 route shortcuts jump straight to a family', async () => {
    renderReports(<ReportsSurface />, '/reports?report=activity');
    await screen.findByText('Calls logged');

    fireEvent.keyDown(document.body, { key: '2' });
    await waitFor(() => expect(tab('Funnel')).toHaveAttribute('aria-selected', 'true'));

    fireEvent.keyDown(document.body, { key: '3' });
    await waitFor(() => expect(tab('Sequences')).toHaveAttribute('aria-selected', 'true'));
  });
});
