import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { User } from '@switchboard/shared';
import { useAuth } from './AuthProvider.tsx';
import { listDevUsers } from './devAuth.ts';
import { initials } from '../lib/format.ts';
import { Spinner } from '../ui/index.ts';
import { BoardMark } from '../ui/BoardMark.tsx';
import {
  clearBlankWorkspace,
  hasBlankSnapshot,
  setWorkspaceMode,
  workspaceMode,
} from '../mocks/workspace.ts';
import type { WorkspaceMode } from '../mocks/workspace.ts';

const WORKSPACE_OPTIONS: ReadonlyArray<{
  mode: WorkspaceMode;
  label: string;
  hint: string;
}> = [
  {
    mode: 'sample',
    label: 'Sample data',
    hint: 'A full demo org — 200+ leads, timelines, reports.',
  },
  {
    mode: 'blank',
    label: 'Blank workspace',
    hint: 'Start empty and use it like a real account — your leads and CSV imports persist on this device.',
  },
];

/**
 * Dev-login screen (MOCK auth only). Picks a fixture user — no password, no
 * external account. On selection the user is stored and we return to the
 * originally requested route (or /inbox). In real mode `LoginPage` renders
 * `SsoLoginPage` instead; this component is never mounted there, so the
 * dev-users query (which only exists under MOCK_MODE) never fires.
 */
export function DevLoginPage({ from }: { from: string }): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();

  const usersQuery = useQuery({ queryKey: ['dev-users'], queryFn: () => listDevUsers() });

  const choose = (user: User): void => {
    login(user);
    navigate(from, { replace: true });
  };

  // The fixture db is built once at boot, so switching workspaces reloads —
  // honest and instant enough for a login-screen choice.
  const mode = workspaceMode();
  const pickWorkspace = (next: WorkspaceMode): void => {
    if (next === mode) return;
    setWorkspaceMode(next);
    window.location.reload();
  };
  const resetBlank = (): void => {
    clearBlankWorkspace();
    window.location.reload();
  };

  const users = usersQuery.data;

  return (
    <main className="sb-login">
      <div className="sb-login__card">
        <div className="sb-login__brand">
          <BoardMark size={20} />
          <span>Switchboard</span>
        </div>
        <h1 className="sb-login__title">Sign in</h1>
        <p className="sb-login__hint">
          Mock mode — pick a user to sign in. No password and no external account required.
        </p>

        <div className="sb-login__ws" role="radiogroup" aria-label="Workspace">
          {WORKSPACE_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={mode === option.mode}
              className={
                mode === option.mode ? 'sb-login__ws-option is-selected' : 'sb-login__ws-option'
              }
              onClick={() => pickWorkspace(option.mode)}
            >
              <span className="sb-login__ws-label">{option.label}</span>
              <span className="sb-login__ws-hint">{option.hint}</span>
            </button>
          ))}
        </div>
        {mode === 'blank' && hasBlankSnapshot() ? (
          <button type="button" className="sb-login__ws-reset" onClick={resetBlank}>
            Reset blank workspace — erase the data saved on this device
          </button>
        ) : null}

        {usersQuery.isPending ? (
          <div className="sb-login__loading">
            <Spinner label="Loading users" />
          </div>
        ) : usersQuery.isError || !users ? (
          <p role="alert" className="sb-login__error">
            Couldn’t load users — the mock API may not be running.
          </p>
        ) : (
          <ul className="sb-login__users">
            {users.map((user) => (
              <li key={user.id}>
                <button type="button" className="sb-login__user" onClick={() => choose(user)}>
                  <span className="sb-avatar" aria-hidden="true">
                    {initials(user.name)}
                  </span>
                  <span className="sb-login__user-main">
                    <span className="sb-login__user-name">{user.name}</span>
                    <span className="sb-login__user-email">{user.email}</span>
                  </span>
                  <span className="sb-login__user-role">{user.role}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
