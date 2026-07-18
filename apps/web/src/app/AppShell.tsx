import { Suspense, useCallback, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';
import { Spinner } from '../ui/index.ts';
import { KeyboardProvider, CheatSheet } from '../keyboard/index.ts';
import { CommandPalette } from '../command/index.ts';
import { ToastProvider } from '../feedback/index.ts';
import { CommsProvider } from '../features/comms/index.ts';
import { CallProvider } from '../features/calling/index.ts';
import { SmsProvider } from '../features/sms/index.ts';
import { AiProvider } from '../features/ai/index.ts';
import { LeftRail } from './LeftRail.tsx';
import { TopBar } from './TopBar.tsx';
import { useRailCollapsed } from './railState.ts';
import { useShellKeymap } from './useShellKeymap.ts';

function PageLoading(): JSX.Element {
  return (
    <div className="sb-page-loading">
      <Spinner size="lg" label="Loading page" />
    </div>
  );
}

/**
 * Authenticated layout. The KeyboardProvider owns the global keymap; the command
 * palette and cheat sheet are always mounted (they render nothing when closed)
 * so their open state and focus restore stay self-contained.
 */
export function AppShell(): JSX.Element {
  return (
    <KeyboardProvider>
      <ToastProvider>
        <CommsProvider>
          <CallProvider>
            <SmsProvider>
              <AiProvider>
                <ShellChrome />
              </AiProvider>
            </SmsProvider>
          </CallProvider>
        </CommsProvider>
      </ToastProvider>
    </KeyboardProvider>
  );
}

function ShellChrome(): JSX.Element {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);

  const openPalette = useCallback(() => {
    setCheatOpen(false);
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const togglePalette = useCallback(() => {
    setCheatOpen(false);
    setPaletteOpen((open) => !open);
  }, []);
  const closeCheatSheet = useCallback(() => setCheatOpen(false), []);
  const toggleCheatSheet = useCallback(() => {
    setPaletteOpen(false);
    setCheatOpen((open) => !open);
  }, []);

  useShellKeymap({ searchRef, togglePalette, toggleCheatSheet });
  const rail = useRailCollapsed();

  return (
    <div className="sb-app" data-rail={rail.collapsed ? 'collapsed' : undefined}>
      <a className="sb-skip" href="#main-content">
        Skip to content
      </a>
      <TopBar searchRef={searchRef} onOpenPalette={openPalette} />
      <LeftRail collapsed={rail.collapsed} onToggleCollapse={rail.toggle} />
      <main className="sb-main" id="main-content" tabIndex={-1}>
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </main>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <CheatSheet open={cheatOpen} onClose={closeCheatSheet} />
    </div>
  );
}
