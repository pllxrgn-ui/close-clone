import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { server } from '../../../mocks/server.ts';
import { renderReports } from '../test/harness.tsx';
import { reportsHandlers } from '../mocks/reportsHandlers.ts';
import { SequencesReport } from './SequencesReport.tsx';

beforeEach(() => server.use(...reportsHandlers));
afterEach(cleanup);

function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name);
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe('SequencesReport', () => {
  test('renders a reply-rate meter toned by the threshold bands', async () => {
    renderReports(<SequencesReport />);
    await screen.findByText('Cold Outreach — Q3');

    // 27/120 = 22.5% → jade (high)
    const cold = rowFor('Cold Outreach — Q3');
    expect(within(cold).getByText('22.5%')).toBeInTheDocument();
    expect(cold.querySelector('.rpt-meter--high')).not.toBeNull();

    // 2/64 = 3.1% → dim (low)
    const renewal = rowFor('Renewal Nudge');
    expect(within(renewal).getByText('3.1%')).toBeInTheDocument();
    expect(renewal.querySelector('.rpt-meter--low')).not.toBeNull();
  });

  test('a zero-send sequence reads 0.0% (no divide-by-zero) and shows its status', async () => {
    renderReports(<SequencesReport />);
    await screen.findByText('Win-back');
    const winback = rowFor('Win-back');
    expect(within(winback).getByText('0.0%')).toBeInTheDocument();
    expect(within(winback).getByText('archived')).toBeInTheDocument();
    expect(winback.querySelector('.rpt-meter--low')).not.toBeNull();
  });
});
