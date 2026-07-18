import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { search } from '../api/search.ts';
import { NAV_ITEMS } from '../app/nav.tsx';
import { useTheme } from '../theme/ThemeProvider.tsx';

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
 * The always-present commands: navigate to every route and the theme toggle.
 * Every Action command comes from its owning feature (calling, sms, ai, comms,
 * import, …) so the palette never advertises an action that isn't real.
 * `onRun` is invoked after each command (the palette uses it to close).
 */
export function useStaticCommands(onRun: () => void): Command[] {
  const navigate = useNavigate();
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

    return [...navigation, ...theme];
  }, [navigate, cycle, choice, resolved, onRun]);
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
