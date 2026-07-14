import type { JSX } from 'react';

/**
 * App shell placeholder (ARCHITECTURE §2: Inbox · Lead page · Smart Views ·
 * Dialer · Command palette · Settings). Task 0c ships the shell only; the
 * keyboard-first surfaces land in later phases.
 */
export function App(): JSX.Element {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <h1>Switchboard</h1>
      </header>
      <main className="app-shell__main">
        <p>Communication-first sales CRM — app shell placeholder.</p>
      </main>
    </div>
  );
}

export default App;
