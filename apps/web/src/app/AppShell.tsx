import { Suspense, useRef } from 'react';
import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';
import { Spinner } from '../ui/index.ts';
import { LeftRail } from './LeftRail.tsx';
import { TopBar } from './TopBar.tsx';
import { useGlobalShortcuts } from './useGlobalShortcuts.ts';

function PageLoading(): JSX.Element {
  return (
    <div className="sb-page-loading">
      <Spinner size="lg" label="Loading page" />
    </div>
  );
}

/** Authenticated layout: top bar + left rail + routed main region. */
export function AppShell(): JSX.Element {
  const searchRef = useRef<HTMLInputElement | null>(null);
  useGlobalShortcuts(searchRef);

  return (
    <div className="sb-app">
      <a className="sb-skip" href="#main-content">
        Skip to content
      </a>
      <TopBar searchRef={searchRef} />
      <LeftRail />
      <main className="sb-main" id="main-content" tabIndex={-1}>
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
