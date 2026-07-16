/*
 * Reports surface shell — the tablist over the three report families and the
 * active tab's panel. Tab state lives in the URL (`?report=`), so the command
 * palette and the 1/2/3 route shortcuts can deep-link a family and the choice
 * survives navigation. Full keyboard support: roving tabindex + arrow/Home/End
 * on the tablist (WAI-ARIA tabs), plus 1/2/3 anywhere on the route. Tab switches
 * are instant (keyboard-initiated → no motion).
 */
import { useCallback, useMemo, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useKeyBindings } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';
import { ActivityReport } from './ActivityReport.tsx';
import { FunnelReport } from './FunnelReport.tsx';
import { SequencesReport } from './SequencesReport.tsx';

const TABS = [
  { key: 'activity', label: 'Activity' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'sequences', label: 'Sequences' },
] as const;

export type ReportTabKey = (typeof TABS)[number]['key'];

export function isReportTabKey(value: string | null): value is ReportTabKey {
  return value !== null && TABS.some((t) => t.key === value);
}

function tabAt(index: number): ReportTabKey {
  const wrapped = ((index % TABS.length) + TABS.length) % TABS.length;
  return TABS[wrapped]?.key ?? 'activity';
}

export function ReportsSurface(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const raw = params.get('report');
  const active: ReportTabKey = isReportTabKey(raw) ? raw : 'activity';
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = useCallback(
    (key: ReportTabKey, focus = false): void => {
      setParams(
        (prev) => {
          prev.set('report', key);
          return prev;
        },
        { replace: true },
      );
      if (focus) {
        const idx = TABS.findIndex((t) => t.key === key);
        tabRefs.current[idx]?.focus();
      }
    },
    [setParams],
  );

  // 1/2/3 jump to a report family from anywhere on the route (cheat-sheet listed).
  const bindings = useMemo<KeyBindingDef[]>(
    () =>
      TABS.map((tab, i) => ({
        id: `reports.tab.${tab.key}`,
        combo: String(i + 1),
        scope: 'route',
        label: `Reports: ${tab.label}`,
        group: 'Reports',
        handler: () => select(tab.key),
      })),
    [select],
  );
  useKeyBindings(bindings);

  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const idx = TABS.findIndex((t) => t.key === active);
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        select(tabAt(idx + 1), true);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        select(tabAt(idx - 1), true);
        break;
      case 'Home':
        event.preventDefault();
        select(tabAt(0), true);
        break;
      case 'End':
        event.preventDefault();
        select(tabAt(TABS.length - 1), true);
        break;
      default:
        break;
    }
  };

  return (
    <div className="rpt">
      <header className="rpt__head">
        <div>
          <h1 className="rpt__title">Reports</h1>
          <p className="rpt__sub">Pipeline and activity analytics across the team.</p>
        </div>
      </header>

      <div
        className="rpt-tabs"
        role="tablist"
        aria-label="Report families"
        onKeyDown={onTabsKeyDown}
      >
        {TABS.map((tab, i) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`rpt-tab-${tab.key}`}
            aria-selected={tab.key === active}
            aria-controls={`rpt-panel-${tab.key}`}
            tabIndex={tab.key === active ? 0 : -1}
            className="rpt-tab"
            onClick={() => select(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`rpt-panel-${active}`}
        aria-labelledby={`rpt-tab-${active}`}
        tabIndex={0}
      >
        {active === 'activity' && <ActivityReport />}
        {active === 'funnel' && <FunnelReport />}
        {active === 'sequences' && <SequencesReport />}
      </div>
    </div>
  );
}
