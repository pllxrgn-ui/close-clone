import type { JSX } from 'react';
import { IconButton } from '../ui/index.ts';
import { MonitorIcon, MoonIcon, SunIcon } from '../ui/icons.tsx';
import { useTheme } from '../theme/ThemeProvider.tsx';

/** Cycles light → dark → system; icon + accessible label reflect the choice. */
export function ThemeToggle(): JSX.Element {
  const { choice, resolved, cycle } = useTheme();
  const label = choice === 'system' ? `Theme: system (${resolved})` : `Theme: ${choice}`;
  const icon =
    choice === 'light' ? (
      <SunIcon size={16} />
    ) : choice === 'dark' ? (
      <MoonIcon size={16} />
    ) : (
      <MonitorIcon size={16} />
    );
  return (
    <IconButton label={label} onClick={cycle}>
      {icon}
    </IconButton>
  );
}
