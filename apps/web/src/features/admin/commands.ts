/*
 * Palette commands contributed by the admin surface. Exported for the merge to
 * splice into the command palette's static command list (see routeWiring) — the
 * palette's `commands.ts` is owned by another task, so this hook is composed in
 * rather than self-registering, exactly like the MSW handler sets.
 *
 * Two groups, both reusing existing palette groups (no new group needed):
 *   - Navigate: one command per settings section (deep-links `?section=`),
 *   - Actions: "Export selected leads (CSV)" — only present when a selection
 *     exists (read from the bulk selection mirror), so it is never a no-op.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Command } from '../../command/index.ts';
import { useToast } from '../../feedback/ToastProvider.tsx';
import { useAuth } from '../../auth/AuthProvider.tsx';
import { SETTINGS_SECTIONS } from './settings/SettingsNav.tsx';
import { csvFilename, downloadCsv, leadsToCsv } from './bulk/csv.ts';
import { useBulkSelection } from './bulk/selectionStore.ts';

export function useAdminCommands(onRun: () => void): Command[] {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const selection = useBulkSelection();

  return useMemo(() => {
    const navCommands: Command[] = SETTINGS_SECTIONS.filter(
      (section) => user?.role === 'admin' || !section.adminOnly,
    ).map((section) => ({
      id: `settings:${section.id}`,
      title: `Settings — ${section.label}`,
      group: 'Navigate',
      keywords: ['settings', 'admin', 'config', section.label.toLowerCase()],
      run: () => {
        navigate(`/settings?section=${section.id}`);
        onRun();
      },
    }));

    const actionCommands: Command[] = [];
    const { leads, ctx } = selection;
    if (leads.length > 0 && ctx) {
      const count = leads.length;
      actionCommands.push({
        id: 'bulk:export-csv',
        title: `Export ${count.toLocaleString('en-US')} selected ${count === 1 ? 'lead' : 'leads'} as CSV`,
        group: 'Actions',
        keywords: ['export', 'csv', 'download', 'leads', 'bulk', 'selection'],
        run: () => {
          const ok = downloadCsv(csvFilename(), leadsToCsv(leads, ctx));
          toast(
            ok
              ? `Exported ${count.toLocaleString('en-US')} ${count === 1 ? 'lead' : 'leads'} to CSV`
              : 'CSV export isn’t available here',
          );
          onRun();
        },
      });
    }

    return [...navCommands, ...actionCommands];
  }, [navigate, toast, selection, onRun, user?.role]);
}
