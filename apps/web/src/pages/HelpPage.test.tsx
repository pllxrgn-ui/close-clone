import { afterEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { HelpPage } from './HelpPage.tsx';

const shellCss = readFileSync(resolve(process.cwd(), 'src/app/shell.css'), 'utf8');

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
    expect(
      screen.getByText(/disconnecting clears Switchboard's Gmail authorization/i),
    ).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: /Settings → Inboxes/i })).toHaveAttribute(
      'href',
      '/settings?section=inboxes',
    );
    expect(screen.getByRole('link', { name: 'Smart Views' })).toHaveAttribute('href', '/views');
    expect(screen.getByRole('link', { name: 'Dialer' })).toHaveAttribute('href', '/dialer');
    expect(screen.getByRole('link', { name: /open a lead/i })).toHaveAttribute('href', '/leads');
    expect(screen.getByRole('link', { name: /Settings → About/i })).toHaveAttribute(
      'href',
      '/settings?section=about',
    );
  });

  test('documents implemented inbox statuses and compliance behavior', () => {
    renderHelp();
    for (const status of [
      'Not connected',
      'Awaiting Google',
      'Importing mail',
      'Connected',
      'Sync delayed',
      'Resyncing mail',
      'Needs reconnect',
    ]) {
      expect(screen.getByText(status)).toBeInTheDocument();
    }
    expect(
      screen.getByText(/Replies and unsubscribes pause active sequences/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/DNC, suppression, and bounce safeguards block eligible sends/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/consent checks run at delivery/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Recording is off by default/i)).toBeInTheDocument();
  });

  test('uses a shrinkable mobile help track', () => {
    expect(shellCss).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(24rem, 100%), 1fr));',
    );
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
