import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server.ts';
import { renderReports } from '../test/harness.tsx';
import { reportsHandlers } from '../mocks/reportsHandlers.ts';
import { FunnelReport } from './FunnelReport.tsx';

beforeEach(() => server.use(...reportsHandlers));
afterEach(cleanup);

describe('FunnelReport', () => {
  test('groups by currency and renders a funnel band per currency', async () => {
    const { container } = renderReports(<FunnelReport />);

    // both seeded currencies get their own pipeline block
    expect(await screen.findByRole('region', { name: 'USD pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'EUR pipeline' })).toBeInTheDocument();

    // funnel band segments carry stage label + count (USD Discovery = 18, EUR = 8)
    expect(screen.getByLabelText('Discovery: 18')).toBeInTheDocument();
    expect(screen.getByLabelText('Discovery: 8')).toBeInTheDocument();

    // terminal stages are colored won/lost
    expect(container.querySelector('.rpt-funnel__seg--won')).not.toBeNull();
    expect(container.querySelector('.rpt-funnel__seg--lost')).not.toBeNull();

    // the stage table carries the weighted-value (display numeral) column
    expect(screen.getAllByText('Weighted').length).toBeGreaterThan(0);
    expect(container.querySelector('td.is-display')).not.toBeNull();
  });

  test('renders an empty state when there is no pipeline', async () => {
    server.use(http.get('*/api/v1/reports/funnel', () => HttpResponse.json({ items: [] })));
    renderReports(<FunnelReport />);
    expect(await screen.findByText('No pipeline yet')).toBeInTheDocument();
  });
});
