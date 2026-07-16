import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server.ts';
import { renderReports } from '../test/harness.tsx';
import { reportsHandlers } from '../mocks/reportsHandlers.ts';
import { ActivityReport } from './ActivityReport.tsx';

beforeEach(() => server.use(...reportsHandlers));
afterEach(cleanup);

// Daily call rates from the seed profiles → org calls/day = 27:
//   7d = 189 · 30d = 810 · 90d = 2430
describe('ActivityReport', () => {
  test('renders org totals, a per-rep table, and lights the calls leader', async () => {
    const { container } = renderReports(<ActivityReport />, '/reports?report=activity&range=30d');

    // stat tile: 30-day org calls total
    expect(await screen.findByText('810')).toBeInTheDocument();
    expect(screen.getByText('Calls logged')).toBeInTheDocument();
    expect(screen.getByText('Talk time')).toBeInTheDocument();

    // per-rep table resolves rep names via /users
    const adaCells = await screen.findAllByText('Ada Okafor');
    expect(adaCells.length).toBeGreaterThan(0);

    // Ada has the highest calls/day (8) → the single leader bar
    const leader = container.querySelector('.rpt-bar--leader');
    expect(leader?.getAttribute('aria-label')).toContain('Ada Okafor');
  });

  test('changing the range re-queries and updates the numbers in place', async () => {
    renderReports(<ActivityReport />, '/reports?report=activity&range=30d');
    expect(await screen.findByText('810')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));

    // 7-day total appears; the 30-day total is gone.
    expect(await screen.findByText('189')).toBeInTheDocument();
    expect(screen.queryByText('810')).not.toBeInTheDocument();
  });

  test('shows an honest empty state when the range has no activity', async () => {
    server.use(http.get('*/api/v1/reports/activity', () => HttpResponse.json({ items: [] })));
    renderReports(<ActivityReport />, '/reports?report=activity&range=7d');
    expect(await screen.findByText('No activity in this range')).toBeInTheDocument();
  });

  test('surfaces an error with a retry when the report fails', async () => {
    server.use(
      http.get('*/api/v1/reports/activity', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    renderReports(<ActivityReport />, '/reports?report=activity&range=30d');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
