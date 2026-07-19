import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/*
 * App-level crash armor. Two jobs:
 *
 * 1. STALE-CHUNK RECOVERY — every production deploy replaces the hash-named
 *    chunk files, so a tab opened on an older build throws "Failed to fetch
 *    dynamically imported module" the next time it lazy-loads a route. That
 *    used to be a permanent white screen ("ga crash crash"). Now it reloads
 *    ONCE automatically (sessionStorage guard prevents a reload loop); the
 *    fresh HTML references the live chunks and the user never sees a crash.
 *
 * 2. FRIENDLY FALLBACK — any other render error shows a recoverable panel
 *    instead of a blank page. Plain markup + global classes only: the boundary
 *    must render even when the React tree below it is gone.
 */

const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i;

const RELOAD_GUARD_KEY = 'sb-chunk-reloaded';

function guardSet(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_GUARD_KEY) === '1';
  } catch {
    return true; // no sessionStorage → never auto-reload (avoid loops blind)
  }
}
function setGuard(): void {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
  } catch {
    /* ignore */
  }
}
function clearGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    /* ignore */
  }
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidMount(): void {
    // A clean boot after an auto-reload re-arms the guard for the NEXT deploy
    // (delay it so a crash-during-boot still counts as the guarded attempt).
    window.setTimeout(clearGuard, 10_000);
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[sb] render error', error, info.componentStack);
    if (CHUNK_ERROR_RE.test(String(error)) && !guardSet()) {
      setGuard();
      window.location.reload();
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    // Chunk errors reload automatically (above); this panel is for everything
    // else — and for the second chunk failure in a row.
    return (
      <main className="sb-crash" role="alert">
        <div className="sb-crash__card">
          <h1 className="sb-crash__title">Something went wrong</h1>
          <p className="sb-crash__hint">
            The app hit an unexpected error — usually a stale tab from an older deploy. Reloading
            almost always fixes it.
          </p>
          <div className="sb-crash__actions">
            <button
              type="button"
              className="sb-btn sb-btn--primary"
              onClick={() => {
                clearGuard();
                window.location.reload();
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </main>
    );
  }
}
