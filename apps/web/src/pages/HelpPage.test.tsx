import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { HelpPage } from './HelpPage.tsx';

function renderHelp() {
  return render(
    <MemoryRouter initialEntries={['/help']}>
      <HelpPage />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('HelpPage', () => {
  test('renders five real help categories as native disclosures', () => {
    const { container } = renderHelp();
    for (const name of [
      'Account and inboxes',
      'Daily workflow',
      'Calling and messaging',
      'Compliance',
      'Admin support',
    ]) {
      expect(screen.getByRole('heading', { name, level: 2 })).toBeInTheDocument();
    }
    expect(container.querySelectorAll('details.sb-help__faq-item')).toHaveLength(15);
    expect(screen.getByText(/disconnecting removes Switchboard's authorization/i)).toBeInTheDocument();
  });

  test('opens an answer through its native summary', async () => {
    const user = userEvent.setup();
    renderHelp();
    const summary = screen.getByText('How do I connect my Gmail inbox?').closest('summary');
    expect(summary).not.toBeNull();
    await user.click(summary as HTMLElement);
    expect(summary?.parentElement).toHaveAttribute('open');
  });

  test('links to existing action surfaces', () => {
    renderHelp();
    expect(screen.getByRole('link', { name: /Settings → Inboxes/i })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Smart Views' })).toHaveAttribute('href', '/views');
  });

  test('has no serious or critical axe violations', async () => {
    const { container } = renderHelp();
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(blocking.map((violation) => violation.id)).toEqual([]);
  });
});
