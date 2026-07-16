import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import * as axe from 'axe-core';
import { server } from '../../mocks/server.ts';
import { renderReports } from './test/harness.tsx';
import { reportsHandlers } from './mocks/reportsHandlers.ts';
import { ReportsSurface } from './components/ReportsSurface.tsx';

/*
 * axe-core structural smoke. jsdom has no layout engine, so color-contrast can't
 * run here — the AA pairs are verified statically (tokens.css + the S4 report
 * computed the won/lost label pairs). Every other rule runs; we fail on
 * serious/critical only, per the acceptance bar.
 */
const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, AXE_OPTIONS);
  expect(results.passes.length).toBeGreaterThan(0);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking.map((v) => `${v.id} (${String(v.impact)}): ${v.help}`).join('\n');
  expect(summary).toBe('');
}

beforeAll(() => {
  document.documentElement.lang = 'en';
  document.title = 'Switchboard';
});
beforeEach(() => server.use(...reportsHandlers));
afterEach(cleanup);

describe('reports surface accessibility (axe-core)', () => {
  test('the activity family has no serious/critical violations', async () => {
    const { container } = renderReports(<ReportsSurface />, '/reports?report=activity');
    await screen.findByText('Calls logged');
    await expectNoSeriousViolations(container);
  });

  test('the funnel family has no serious/critical violations', async () => {
    const { container } = renderReports(<ReportsSurface />, '/reports?report=funnel');
    await screen.findByRole('region', { name: 'USD pipeline' });
    await expectNoSeriousViolations(container);
  });

  test('the sequences family has no serious/critical violations', async () => {
    const { container } = renderReports(<ReportsSurface />, '/reports?report=sequences');
    await screen.findByText('Cold Outreach — Q3');
    await expectNoSeriousViolations(container);
  });

  test('the range control keeps its accessible names', async () => {
    renderReports(<ReportsSurface />, '/reports?report=activity');
    await screen.findByText('Calls logged');
    // segmented control options are individually labelled
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Last 90 days' }));
    expect(screen.getByRole('button', { name: 'Last 90 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
