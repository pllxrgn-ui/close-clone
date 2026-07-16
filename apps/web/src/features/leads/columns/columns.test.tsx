import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { COLUMN_DEFS, DEFAULT_COLUMN_KEYS, compareByColumn, resolveColumns } from './columns.tsx';
import type { ColumnCtx } from './columns.tsx';
import { REF_NOW, daysAgo, hoursAgo, makeLead } from '../test/factories.ts';

const ctx: ColumnCtx = {
  statusLabel: (id) => (id ? 'Qualified' : '—'),
  ownerName: (id) => (id ? 'Ben Reyes' : '—'),
  now: REF_NOW,
};

describe('resolveColumns', () => {
  test('falls back to the default set when none specified', () => {
    expect(resolveColumns(null).map((c) => c.key)).toEqual([...DEFAULT_COLUMN_KEYS]);
    expect(resolveColumns([]).map((c) => c.key)).toEqual([...DEFAULT_COLUMN_KEYS]);
  });

  test('maps known DSL field names to their column defs', () => {
    const cols = resolveColumns(['name', 'status', 'owner', 'next_task_due']);
    expect(cols.map((c) => c.key)).toEqual(['name', 'status', 'owner', 'next_task_due']);
    expect(cols[1]).toBe(COLUMN_DEFS.status);
  });

  test('forces a leading name column even if omitted', () => {
    const cols = resolveColumns(['status', 'owner']);
    expect(cols[0]?.key).toBe('name');
  });

  test('dedupes repeated fields', () => {
    const cols = resolveColumns(['name', 'name', 'status', 'status']);
    expect(cols.map((c) => c.key)).toEqual(['name', 'status']);
  });

  test('unknown field degrades to a labelled, non-sortable em-dash column', () => {
    const cols = resolveColumns(['name', 'opportunity.value']);
    const opp = cols[1];
    expect(opp?.key).toBe('opportunity.value');
    expect(opp?.header).toBe('Opportunity Value');
    expect(opp?.sortable).toBe(false);
    const { container } = render(<>{opp?.render(makeLead(), ctx)}</>);
    expect(container.textContent).toBe('—');
  });

  test('ignores non-string entries in the columns array', () => {
    const cols = resolveColumns(['name', 42, null, 'status']);
    expect(cols.map((c) => c.key)).toEqual(['name', 'status']);
  });
});

describe('compareByColumn', () => {
  test('sorts by name ascending and descending', () => {
    const leads = [
      makeLead({ name: 'Cedar' }),
      makeLead({ name: 'Apex' }),
      makeLead({ name: 'Bright' }),
    ];
    const asc = [...leads].sort(compareByColumn(COLUMN_DEFS.name!, 'asc', ctx));
    expect(asc.map((l) => l.name)).toEqual(['Apex', 'Bright', 'Cedar']);
    const desc = [...leads].sort(compareByColumn(COLUMN_DEFS.name!, 'desc', ctx));
    expect(desc.map((l) => l.name)).toEqual(['Cedar', 'Bright', 'Apex']);
  });

  test('nulls sort last regardless of direction', () => {
    const withDate = makeLead({ name: 'Has', lastContactedAt: hoursAgo(2) });
    const older = makeLead({ name: 'Older', lastContactedAt: daysAgo(5) });
    const none = makeLead({ name: 'None', lastContactedAt: null });
    const col = COLUMN_DEFS.last_contacted!;

    const asc = [none, withDate, older].sort(compareByColumn(col, 'asc', ctx));
    expect(asc.at(-1)?.name).toBe('None');
    const desc = [none, withDate, older].sort(compareByColumn(col, 'desc', ctx));
    expect(desc.at(-1)?.name).toBe('None');
  });
});

describe('cell rendering', () => {
  test('owner cell shows initials and name', () => {
    const { container } = render(<>{COLUMN_DEFS.owner!.render(makeLead({ ownerId: 'x' }), ctx)}</>);
    expect(container.textContent).toContain('Ben Reyes');
    expect(container.textContent).toContain('BR');
  });

  test('next-task cell flags overdue', () => {
    const { container } = render(
      <>{COLUMN_DEFS.next_task_due!.render(makeLead({ nextTaskDueAt: hoursAgo(4) }), ctx)}</>,
    );
    expect(container.querySelector('.is-overdue')).not.toBeNull();
  });

  test('status cell renders a neutral pill for a plain status', () => {
    const { container } = render(
      <>{COLUMN_DEFS.status!.render(makeLead({ statusId: 'x' }), ctx)}</>,
    );
    expect(container.textContent).toContain('Qualified');
  });
});
