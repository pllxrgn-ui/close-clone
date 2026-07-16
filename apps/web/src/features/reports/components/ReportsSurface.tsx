/*
 * Reports surface shell — the tablist over the three report families and the
 * active tab's panel. Tab state lives in the URL (`?report=`), so the command
 * palette and the 1/2/3 route shortcuts can deep-link a family and the choice
 * survives navigation. Keyboard support comes from the shared Tabs primitive
 * (roving tabindex + arrow/Home/End, WAI-ARIA tabs, 0ms switches) plus the 1/2/3
 * route shortcuts wired here. Only the active panel mounts, so inactive report
 * queries never fire.
 */
import { useCallback, useMemo } from 'react';
import type { JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useKeyBindings } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';
import { Tab, TabList, TabPanel, Tabs } from '../../../ui/index.ts';
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

export function ReportsSurface(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const raw = params.get('report');
  const active: ReportTabKey = isReportTabKey(raw) ? raw : 'activity';

  const select = useCallback(
    (key: string): void => {
      setParams(
        (prev) => {
          prev.set('report', key);
          return prev;
        },
        { replace: true },
      );
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

  return (
    <div className="rpt">
      <header className="rpt__head">
        <div>
          <h1 className="rpt__title">Reports</h1>
          <p className="rpt__sub">Pipeline and activity analytics across the team.</p>
        </div>
      </header>

      <Tabs value={active} onValueChange={select}>
        <TabList label="Report families" className="rpt-tabs">
          {TABS.map((tab) => (
            <Tab key={tab.key} value={tab.key}>
              {tab.label}
            </Tab>
          ))}
        </TabList>
        <TabPanel value="activity" className="rpt-tabpanel">
          <ActivityReport />
        </TabPanel>
        <TabPanel value="funnel" className="rpt-tabpanel">
          <FunnelReport />
        </TabPanel>
        <TabPanel value="sequences" className="rpt-tabpanel">
          <SequencesReport />
        </TabPanel>
      </Tabs>
    </div>
  );
}
