import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BarComparison, FunnelBand, MeterBar, StatTile } from './charts.tsx';
import type { BarItem, FunnelSegment } from './charts.tsx';

afterEach(cleanup);

describe('StatTile', () => {
  test('renders the value and label', () => {
    render(<StatTile label="Calls logged" value="1,234" />);
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('Calls logged')).toBeInTheDocument();
  });
});

describe('BarComparison', () => {
  const items: BarItem[] = [
    { id: 'a', label: 'Ada', value: 8, display: '8' },
    { id: 'b', label: 'Ben', value: 4, display: '4' },
    { id: 'c', label: 'Cai', value: 6, display: '6' },
  ];

  test('marks exactly the max-value bar as the leader and full-width', () => {
    const { container } = render(<BarComparison items={items} unitLabel="calls" />);
    const leaders = container.querySelectorAll('.rpt-bar--leader');
    expect(leaders).toHaveLength(1);
    const leaderFill = leaders[0]?.querySelector('.rpt-bar__fill') as HTMLElement | null;
    expect(leaderFill?.style.transform).toBe('scaleX(1)');
    // leader row is named for the max value
    expect(leaders[0]?.getAttribute('aria-label')).toContain('Ada');
    expect(leaders[0]?.getAttribute('aria-label')).toContain('leader');
  });

  test('non-leader fills scale proportionally to the max', () => {
    const { container } = render(<BarComparison items={items} unitLabel="calls" />);
    const bars = [...container.querySelectorAll('.rpt-bar')];
    const ben = bars.find((b) => b.getAttribute('aria-label')?.includes('Ben'));
    const fill = ben?.querySelector('.rpt-bar__fill') as HTMLElement | null;
    expect(fill?.style.transform).toBe('scaleX(0.5)'); // 4 / 8
  });

  test('all-zero data does not crash and scales to 0', () => {
    const { container } = render(
      <BarComparison items={[{ id: 'a', label: 'Ada', value: 0 }]} unitLabel="calls" />,
    );
    expect(container.querySelectorAll('.rpt-bar--leader')).toHaveLength(0);
    const fill = container.querySelector('.rpt-bar__fill') as HTMLElement | null;
    expect(fill?.style.transform).toBe('scaleX(0)');
  });
});

describe('FunnelBand', () => {
  const segments: FunnelSegment[] = [
    { id: 's0', label: 'Discovery', count: 10, display: '10', kind: 'open' },
    { id: 's1', label: 'Proposal', count: 6, display: '6', kind: 'open' },
    { id: 'sw', label: 'Closed Won', count: 4, display: '4', kind: 'won' },
    { id: 'sl', label: 'Closed Lost', count: 2, display: '2', kind: 'lost' },
  ];

  test('renders each stage label + count and widths proportional to the max', () => {
    const { container } = render(<FunnelBand segments={segments} />);
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    const segs = [...container.querySelectorAll('.rpt-funnel__seg')] as HTMLElement[];
    expect(segs).toHaveLength(4);
    expect(segs[0]?.style.width).toBe('100%'); // 10 / 10
    expect(segs[1]?.style.width).toBe('60%'); // 6 / 10
  });

  test('colors won/lost segments with the state classes', () => {
    const { container } = render(<FunnelBand segments={segments} />);
    expect(container.querySelector('.rpt-funnel__seg--won')).not.toBeNull();
    expect(container.querySelector('.rpt-funnel__seg--lost')).not.toBeNull();
  });
});

describe('MeterBar', () => {
  test('applies the tone class, scales the fill, and shows the value', () => {
    const { container } = render(<MeterBar percent={22.5} tone="high" valueText="22.5%" />);
    expect(container.querySelector('.rpt-meter--high')).not.toBeNull();
    const fill = container.querySelector('.rpt-meter__fill') as HTMLElement | null;
    expect(fill?.style.transform).toBe('scaleX(0.225)');
    expect(screen.getByText('22.5%')).toBeInTheDocument();
  });

  test('caps the fill at 100%', () => {
    const { container } = render(<MeterBar percent={140} tone="high" valueText="140%" />);
    const fill = container.querySelector('.rpt-meter__fill') as HTMLElement | null;
    expect(fill?.style.transform).toBe('scaleX(1)');
  });
});
