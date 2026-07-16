import { useState } from 'react';
import type { JSX } from 'react';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Lead } from '@switchboard/shared';
import { LeadsTable } from './LeadsTable.tsx';
import type { SortState } from './LeadsTable.tsx';
import { resolveColumns } from '../columns/columns.tsx';
import type { ColumnCtx } from '../columns/columns.tsx';
import { REF_NOW, hoursAgo, makeLead } from '../test/factories.ts';
import { installVirtualizerEnv, renderWithKeyboard } from '../test/harness.tsx';

const ctx: ColumnCtx = {
  statusLabel: (id) => (id ? 'Qualified' : '—'),
  ownerName: (id) => (id ? 'Ben Reyes' : '—'),
  now: REF_NOW,
};

const columns = resolveColumns(['name', 'status', 'owner', 'next_task_due']);

interface ProbeProps {
  leads: Lead[];
  onOpen?: (lead: Lead) => void;
}

function TableProbe({ leads, onOpen = () => {} }: ProbeProps): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState | null>(null);
  const selectAllState =
    selected.size === 0 ? 'none' : selected.size === leads.length ? 'all' : 'some';
  return (
    <LeadsTable
      leads={leads}
      columns={columns}
      ctx={ctx}
      sort={sort}
      onSortChange={(key) =>
        setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
      }
      selectedIds={selected}
      onToggleSelect={(id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
      onToggleSelectAll={() =>
        setSelected((prev) => (prev.size === leads.length ? new Set() : new Set(leads.map((l) => l.id))))
      }
      selectAllState={selectAllState}
      onOpen={onOpen}
      now={REF_NOW}
      totalCount={leads.length}
    />
  );
}

function makeLeads(n: number): Lead[] {
  return Array.from({ length: n }, (_, i) =>
    makeLead({
      name: `Company ${String(i + 1).padStart(4, '0')}`,
      statusId: 's1',
      ownerId: 'u1',
      nextTaskDueAt: i % 3 === 0 ? hoursAgo(2) : null,
    }),
  );
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = installVirtualizerEnv({ height: 640 });
});
afterEach(() => {
  restoreEnv();
  cleanup();
});

describe('LeadsTable — virtualization', () => {
  test('windows 5,000 rows: renders a small window over the full total size', () => {
    renderWithKeyboard(<TableProbe leads={makeLeads(5000)} />);

    const rendered = document.querySelectorAll('.lead-row');
    // A 640px viewport of 36px rows + overscan renders a few dozen rows, never 5k.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(120);

    // The spacer still reserves the full scroll height (5000 × 36px).
    const viewport = document.querySelector('.lead-table__viewport');
    expect(viewport).not.toBeNull();
    expect((viewport as HTMLElement).style.height).toBe(`${5000 * 36}px`);

    // The top of the list is mounted; the tail is not (proof of windowing).
    expect(screen.getByText('Company 0001')).toBeInTheDocument();
    expect(screen.queryByText('Company 5000')).toBeNull();

    // Grid advertises the full logical row count (+1 for the header).
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '5001');
  });

  test('empty dataset renders the header but no data rows', () => {
    renderWithKeyboard(<TableProbe leads={[]} />);
    expect(document.querySelectorAll('.lead-row').length).toBe(0);
    expect(screen.getByRole('columnheader', { name: /name/i })).toBeInTheDocument();
  });
});

describe('LeadsTable — sorting', () => {
  test('clicking a sortable header requests a sort and reflects aria-sort', async () => {
    renderWithKeyboard(<TableProbe leads={makeLeads(5)} />);
    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');

    await userEvent.click(within(nameHeader).getByRole('button'));
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

    await userEvent.click(within(nameHeader).getByRole('button'));
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
  });
});

describe('LeadsTable — selection', () => {
  test('row checkbox toggles selection without opening the lead', async () => {
    const onOpen = vi.fn();
    renderWithKeyboard(<TableProbe leads={makeLeads(5)} onOpen={onOpen} />);
    const firstRow = screen.getAllByRole('row')[1]!;
    const checkbox = within(firstRow).getByRole('checkbox');

    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(firstRow).toHaveAttribute('aria-selected', 'true');
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('select-all checks every loaded row; header goes indeterminate on partial', async () => {
    renderWithKeyboard(<TableProbe leads={makeLeads(4)} />);
    const selectAll = screen.getByRole('checkbox', { name: /select all/i });

    await userEvent.click(selectAll);
    expect(selectAll).toBeChecked();
    for (const row of screen.getAllByRole('row').slice(1)) {
      expect(within(row).getByRole('checkbox')).toBeChecked();
    }

    // Unchecking one row drops the header to indeterminate.
    const firstRowCheckbox = within(screen.getAllByRole('row')[1]!).getByRole('checkbox');
    await userEvent.click(firstRowCheckbox);
    expect((selectAll as HTMLInputElement).indeterminate).toBe(true);
    expect(selectAll).not.toBeChecked();
  });

  test('clicking a row body opens the lead', async () => {
    const onOpen = vi.fn();
    renderWithKeyboard(<TableProbe leads={makeLeads(5)} onOpen={onOpen} />);
    await userEvent.click(screen.getByText('Company 0002'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]?.name).toBe('Company 0002');
  });
});

describe('LeadsTable — keyboard (useListNav + o/x)', () => {
  test('j/k moves focus, o opens, x selects, Enter opens', async () => {
    const onOpen = vi.fn();
    const leads = makeLeads(6);
    renderWithKeyboard(<TableProbe leads={leads} onOpen={onOpen} />);

    const rows = screen.getAllByRole('row'); // [0]=header, [1..]=data
    act(() => rows[1]!.focus());
    expect(rows[1]).toHaveFocus();

    await userEvent.keyboard('j');
    expect(rows[2]).toHaveFocus();

    await userEvent.keyboard('o');
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: leads[1]!.id }));

    await userEvent.keyboard('x');
    expect(rows[2]).toHaveAttribute('aria-selected', 'true');

    onOpen.mockClear();
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: leads[1]!.id }));
  });

  test('list shortcuts are inert until the list is focused', async () => {
    const onOpen = vi.fn();
    renderWithKeyboard(<TableProbe leads={makeLeads(4)} onOpen={onOpen} />);
    await userEvent.keyboard('o'); // nothing focused
    expect(onOpen).not.toHaveBeenCalled();
  });
});
