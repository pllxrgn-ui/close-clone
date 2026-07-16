import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { StateLegend } from './StateLegend.tsx';
import { LAMP_LEGEND } from './Lamp.tsx';

afterEach(cleanup);

describe('StateLegend', () => {
  test('is a labelled region titled "Status lamps"', () => {
    render(<StateLegend />);
    const region = screen.getByRole('region', { name: 'Status lamp legend' });
    expect(within(region).getByRole('heading', { name: 'Status lamps' })).toBeInTheDocument();
  });

  test('lists every state with its meaning, straight from the registry', () => {
    render(<StateLegend />);
    for (const meta of LAMP_LEGEND) {
      expect(screen.getByText(meta.label)).toBeInTheDocument();
      expect(screen.getByText(meta.meaning)).toBeInTheDocument();
    }
  });

  // failure path: legend lamps are decorative (the visible name carries the label),
  // so they must not each surface as a separate img in the a11y tree.
  test('lamps are decorative (no duplicate img nodes)', () => {
    render(<StateLegend />);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });
});
