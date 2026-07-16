import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders } from '../../app/AppProviders.tsx';
import { ROUTER_FUTURE } from '../../app/routerFuture.ts';
import { KeyboardProvider } from '../../keyboard/index.ts';
import { ToastProvider } from '../../feedback/index.ts';
import { server } from '../../mocks/server.ts';
import { ViewBuilderPage } from './ViewBuilderPage.tsx';
import { viewBuilderHandlers } from './mockHandlers.ts';

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  server.use(...viewBuilderHandlers);
  user = userEvent.setup();
});
afterEach(cleanup);

function renderBuilder(path = '/views/new'): RenderResult {
  return render(
    <AppProviders>
      <KeyboardProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
            <Routes>
              <Route path="/views/new" element={<ViewBuilderPage />} />
              <Route path="/views/:id" element={<ViewBuilderPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </KeyboardProvider>
    </AppProviders>,
  );
}

// ── Fresh-query helpers (never hold a node across an await — re-render detaches it) ──
const rootGroup = (): HTMLElement => screen.getByRole('group', { name: 'Filter conditions' });
const nestedGroup = (): HTMLElement => screen.getByRole('group', { name: 'Condition group' });
function rowsIn(scope: HTMLElement): HTMLElement[] {
  return within(scope).queryAllByRole('group', { name: 'Condition' });
}
function row(scope: HTMLElement, index: number): HTMLElement {
  const r = rowsIn(scope)[index];
  if (!r) throw new Error(`condition row ${index} not found`);
  return r;
}

/** Keyboard-activate a button (focus then Enter). */
async function pressEnter(el: HTMLElement): Promise<void> {
  el.focus();
  await user.keyboard('{Enter}');
}

async function readDsl(): Promise<string> {
  await user.click(screen.getByRole('tab', { name: 'Raw DSL' }));
  const ta = await screen.findByRole('textbox', { name: 'Smart View DSL' });
  return (ta as HTMLTextAreaElement).value;
}

async function waitForCatalog(): Promise<void> {
  await screen.findByRole('option', { name: 'Segment' });
}

describe('ViewBuilderPage — keyboard-only nested construction', () => {
  test('builds a 3-clause nested view using the keyboard → canonical DSL', async () => {
    renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });
    await waitForCatalog();

    // ── Clause 1 (root): status = "Won" ──────────────────────────────────────
    await user.selectOptions(
      within(row(rootGroup(), 0)).getByRole('combobox', { name: 'Attribute' }),
      'status',
    );
    await waitFor(() =>
      expect(
        within(row(rootGroup(), 0)).getByRole('combobox', { name: 'Value' }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(
      within(row(rootGroup(), 0)).getByRole('combobox', { name: 'Value' }),
      'Won',
    );

    // ── Add a nested group ────────────────────────────────────────────────────
    await pressEnter(within(rootGroup()).getByRole('button', { name: 'Group' }));
    await waitFor(() => expect(nestedGroup()).toBeInTheDocument());

    // ── Clause 2 (nested): owner in (me) ─────────────────────────────────────
    await user.selectOptions(
      within(row(nestedGroup(), 0)).getByRole('combobox', { name: 'Attribute' }),
      'owner',
    );
    await user.selectOptions(
      within(row(nestedGroup(), 0)).getByRole('combobox', { name: 'Comparator' }),
      'in',
    );
    await waitFor(() => expect(within(nestedGroup()).getByText('me')).toBeInTheDocument());

    // ── Nested group matches ANY (or) ────────────────────────────────────────
    await pressEnter(within(nestedGroup()).getByRole('button', { name: 'Any' }));

    // ── Clause 3 (nested): has inbound_email within 7d ───────────────────────
    await pressEnter(within(nestedGroup()).getByRole('button', { name: 'Condition' }));
    await waitFor(() => expect(rowsIn(nestedGroup())).toHaveLength(2));

    const attrs = within(nestedGroup()).getAllByRole('combobox', { name: 'Attribute' });
    await user.selectOptions(attrs[attrs.length - 1] as HTMLElement, '__activity__');
    await waitFor(() =>
      expect(
        within(row(nestedGroup(), 1)).getByRole('combobox', { name: 'Activity type' }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(
      within(row(nestedGroup(), 1)).getByRole('combobox', { name: 'Activity type' }),
      'inbound_email',
    );

    const withinBox = within(row(nestedGroup(), 1)).getByRole('checkbox');
    withinBox.focus();
    await user.keyboard(' '); // Space toggles the focused checkbox
    await waitFor(() =>
      expect(
        within(row(nestedGroup(), 1)).getByRole('spinbutton', { name: 'Within amount' }),
      ).toBeInTheDocument(),
    );
    const amount = within(row(nestedGroup(), 1)).getByRole('spinbutton', { name: 'Within amount' });
    amount.focus();
    await user.keyboard('{Control>}a{/Control}7'); // select-all then type → "7"

    // ── Assert canonical DSL ─────────────────────────────────────────────────
    expect(await readDsl()).toBe(
      'status = "Won" and (owner in (me) or has inbound_email within 7d)',
    );
  });

  test('Alt+ArrowDown reorders a focused condition without a mouse', async () => {
    renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });
    await waitForCatalog();

    await user.type(within(row(rootGroup(), 0)).getByRole('textbox', { name: 'Value' }), 'acme');
    await pressEnter(within(rootGroup()).getByRole('button', { name: 'Condition' }));
    await waitFor(() => expect(rowsIn(rootGroup())).toHaveLength(2));
    await user.selectOptions(
      within(row(rootGroup(), 1)).getByRole('combobox', { name: 'Attribute' }),
      'dnc',
    );

    expect(await readDsl()).toBe('name contains "acme" and dnc = true');
    await user.click(screen.getByRole('tab', { name: 'Builder' }));

    const firstAttr = within(row(rootGroup(), 0)).getByRole('combobox', { name: 'Attribute' });
    firstAttr.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(await readDsl()).toBe('dnc = true and name contains "acme"');
  });
});

describe('ViewBuilderPage — raw DSL editor', () => {
  test('shows a position-carrying error and gates Apply on a clean parse', async () => {
    renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });

    await user.click(screen.getByRole('tab', { name: 'Raw DSL' }));
    const ta = await screen.findByRole('textbox', { name: 'Smart View DSL' });

    fireEvent.change(ta, { target: { value: 'status = ' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Line 1, column/);
    expect(alert.textContent).toContain('^');
    expect(screen.getByRole('button', { name: 'Apply to builder' })).toBeDisabled();

    fireEvent.change(ta, { target: { value: 'dnc = true' } });
    expect(screen.queryByRole('alert')).toBeNull();
    const apply = screen.getByRole('button', { name: 'Apply to builder' });
    expect(apply).toBeEnabled();
    await user.click(apply);

    await screen.findByRole('group', { name: 'Filter conditions' });
    expect(await readDsl()).toBe('dnc = true');
  });

  test('rejects an unknown field with a parse error (never silently applied)', async () => {
    renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });
    await user.click(screen.getByRole('tab', { name: 'Raw DSL' }));
    const ta = await screen.findByRole('textbox', { name: 'Smart View DSL' });
    fireEvent.change(ta, { target: { value: 'nope = 1' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/unknown field/i);
    expect(screen.getByRole('button', { name: 'Apply to builder' })).toBeDisabled();
  });
});

describe('ViewBuilderPage — live preview + save', () => {
  test('debounced preview shows a count and rows', async () => {
    renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });

    const preview = screen.getByRole('region', { name: 'Live preview' });
    const table = await within(preview).findByRole('table', {}, { timeout: 3000 });
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
    expect(within(preview).getByText(/≈\s*\d/)).toBeInTheDocument();
  });

  test('creates a new Smart View via the CRUD endpoint', async () => {
    renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });

    const name = screen.getByRole('textbox', { name: 'View name' });
    await user.clear(name);
    await user.type(name, 'Hot leads');
    await user.click(screen.getByRole('button', { name: 'Create view' }));

    expect(await screen.findByText('Smart View created')).toBeInTheDocument();
  });

  test('disables save when the view has no conditions', async () => {
    renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });
    await waitForCatalog();

    await user.click(within(rootGroup()).getByRole('button', { name: 'Remove condition' }));
    await waitFor(() => expect(rowsIn(rootGroup())).toHaveLength(0));
    expect(screen.getByRole('button', { name: 'Create view' })).toBeDisabled();
    expect(within(rootGroup()).getByText(/No conditions yet/)).toBeInTheDocument();
  });
});

describe('ViewBuilderPage — accessibility', () => {
  const AXE_OPTIONS: axe.RunOptions = { rules: { 'color-contrast': { enabled: false } } };

  async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.passes.length).toBeGreaterThan(0);
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(blocking.map((v) => `${v.id}: ${v.help}`).join('\n')).toBe('');
  }

  test('no serious/critical axe violations (dark theme, builder + preview)', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const { container } = renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });
    await waitForCatalog();
    await within(screen.getByRole('region', { name: 'Live preview' })).findByRole(
      'table',
      {},
      { timeout: 3000 },
    );
    await expectNoSeriousViolations(container);
    document.documentElement.removeAttribute('data-theme');
  });

  test('no serious/critical axe violations (light theme, DSL tab)', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const { container } = renderBuilder();
    await screen.findByRole('textbox', { name: 'View name' });
    await user.click(screen.getByRole('tab', { name: 'Raw DSL' }));
    await screen.findByRole('textbox', { name: 'Smart View DSL' });
    await expectNoSeriousViolations(container);
    document.documentElement.removeAttribute('data-theme');
  });
});
