import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { search } from '../api/search.ts';
import { NAV_ITEMS } from '../app/nav.tsx';
import { useTheme } from '../theme/ThemeProvider.tsx';
import { useToast } from '../feedback/ToastProvider.tsx';

export const COMMAND_GROUPS = ['Navigate', 'Leads', 'Actions', 'Theme'] as const;
export type CommandGroupName = (typeof COMMAND_GROUPS)[number];

export interface Command {
  id: string;
  title: string;
  group: CommandGroupName;
  keywords?: string[];
  /** Canonical combo string for an inline hint (e.g. `g l`). */
  shortcut?: string;
  /** Secondary line (lead status/company, current theme, …). */
  subtitle?: string;
  run: () => void;
}

/**
 * The always-present commands: navigate to every route, the Phase-4 action
 * placeholders, and the theme toggle. `onRun` is invoked after each command
 * (the palette uses it to close).
 */
export function useStaticCommands(onRun: () => void): Command[] {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { cycle, choice, resolved } = useTheme();

  return useMemo(() => {
    const navigation: Command[] = NAV_ITEMS.map((item) => ({
      id: `nav:${item.to}`,
      title: item.label,
      group: 'Navigate',
      keywords: ['go to', 'open', item.label.toLowerCase()],
      shortcut: `g ${item.key}`,
      run: () => {
        navigate(item.to);
        onRun();
      },
    }));

    const actions: Command[] = [
      { id: 'action:log-call', title: 'Log call', keywords: ['call', 'phone', 'dial', 'activity'] },
      { id: 'action:new-lead', title: 'New lead', keywords: ['create', 'add', 'lead', 'company'] },
      {
        id: 'action:enroll-sequence',
        title: 'Enroll in sequence',
        keywords: ['sequence', 'cadence', 'enroll', 'outreach'],
      },
    ].map((base) => ({
      ...base,
      group: 'Actions' as const,
      run: () => {
        toast(`${base.title} — wired in Phase 4`);
        onRun();
      },
    }));

    const theme: Command[] = [
      {
        id: 'theme:toggle',
        title: 'Toggle theme',
        group: 'Theme',
        keywords: ['dark', 'light', 'system', 'appearance', 'contrast'],
        subtitle:
          choice === 'system'
            ? `System (${resolved})`
            : `${choice[0]?.toUpperCase()}${choice.slice(1)}`,
        run: () => {
          cycle();
          onRun();
        },
      },
    ];

    return [...navigation, ...actions, ...theme];
  }, [navigate, toast, cycle, choice, resolved, onRun]);
}

/**
 * Lead/contact results for the current query, fetched through the API client's
 * global search (MSW-backed under MOCK_MODE). Each resolves to its lead page.
 */
export function useLeadCommands(query: string, onRun: () => void): Command[] {
  const navigate = useNavigate();
  const trimmed = query.trim();
  const { data } = useQuery({
    queryKey: ['palette-search', trimmed],
    queryFn: ({ signal }) => search(trimmed, signal),
    enabled: trimmed.length > 0,
    staleTime: 15_000,
  });

  return useMemo(() => {
    if (!data) return [];
    return data.items
      .filter((hit) => hit.type === 'lead' || hit.type === 'contact')
      .slice(0, 6)
      .map((hit) => ({
        id: `lead:${hit.type}:${hit.id}`,
        title: hit.title,
        group: 'Leads' as const,
        ...(hit.subtitle !== undefined ? { subtitle: hit.subtitle } : {}),
        run: () => {
          navigate(`/leads/${hit.leadId}`);
          onRun();
        },
      }));
  }, [data, navigate, onRun]);
}
