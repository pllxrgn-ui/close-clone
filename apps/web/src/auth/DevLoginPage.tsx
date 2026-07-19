import { useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { User } from '@switchboard/shared';
import { useAuth } from './AuthProvider.tsx';
import { listDevUsers } from './devAuth.ts';
import { accountUser, createAccount, verifyAccount, MIN_PASSWORD_LENGTH } from './accounts.ts';
import { initials } from '../lib/format.ts';
import { Button, Field, Input, Spinner } from '../ui/index.ts';
import { BoardMark } from '../ui/BoardMark.tsx';
import {
  clearBlankWorkspace,
  getWorkspaceOwner,
  clearWorkspaceOwner,
  hasBlankSnapshot,
  setWorkspaceMode,
  setWorkspaceOwner,
  workspaceMode,
} from '../mocks/workspace.ts';
import type { WorkspaceMode } from '../mocks/workspace.ts';

const ACCOUNT_ERROR_COPY: Record<string, string> = {
  username_taken: 'That username is taken on this device — sign in instead.',
  invalid_username: 'Usernames are 3–24 characters: a–z, 0–9, dot, dash, underscore.',
  weak_password: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`,
  name_required: 'Add your name — it labels everything you do in the workspace.',
  unknown_account: 'No account with that username on this device — create one below.',
  wrong_password: 'Wrong password for that username.',
};

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
    // A demo user never owns a personal workspace — if one was active, drop the
    // owner (their DATA stays under its key) and reboot into the demo db.
    if (getWorkspaceOwner()) {
      clearWorkspaceOwner();
      window.location.assign(from);
      return;
    }
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

  // ── Personal account (username + password; see auth/accounts.ts) ──────────
  const [accountMode, setAccountMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);

  const enterWorkspace = (acctUsername: string, user: User): void => {
    login(user);
    setWorkspaceOwner({ username: acctUsername, user });
    // Full load: the fixture db must reboot into THIS account's workspace.
    window.location.assign(from);
  };

  const submitAccount = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setAccountError(null);
    setAccountBusy(true);
    try {
      if (accountMode === 'signup') {
        const result = await createAccount({ name, username, password });
        if (!result.ok) {
          setAccountError(ACCOUNT_ERROR_COPY[result.error] ?? 'Could not create the account.');
          return;
        }
        enterWorkspace(result.account.username, accountUser(result.account));
        return;
      }
      const result = await verifyAccount(username, password);
      if (!result.ok) {
        setAccountError(ACCOUNT_ERROR_COPY[result.error] ?? 'Could not sign in.');
        return;
      }
      enterWorkspace(result.account.username, accountUser(result.account));
    } finally {
      setAccountBusy(false);
    }
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

        <section className="sb-login__account" aria-label="Your account">
          <div className="sb-login__account-head">
            <h2 className="sb-login__account-title">Your account</h2>
            <div className="sb-login__account-tabs" role="tablist" aria-label="Account mode">
              <button
                type="button"
                role="tab"
                aria-selected={accountMode === 'signin'}
                className={
                  accountMode === 'signin'
                    ? 'sb-login__account-tab is-active'
                    : 'sb-login__account-tab'
                }
                onClick={() => {
                  setAccountMode('signin');
                  setAccountError(null);
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={accountMode === 'signup'}
                className={
                  accountMode === 'signup'
                    ? 'sb-login__account-tab is-active'
                    : 'sb-login__account-tab'
                }
                onClick={() => {
                  setAccountMode('signup');
                  setAccountError(null);
                }}
              >
                Create account
              </button>
            </div>
          </div>

          <form className="sb-login__account-form" onSubmit={(e) => void submitAccount(e)}>
            {accountMode === 'signup' ? (
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Pol Villorente"
                  autoComplete="name"
                />
              </Field>
            ) : null}
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. pol"
                autoComplete="username"
                spellCheck={false}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={accountMode === 'signup' ? `${MIN_PASSWORD_LENGTH}+ characters` : ''}
                autoComplete={accountMode === 'signup' ? 'new-password' : 'current-password'}
              />
            </Field>
            {accountError ? (
              <p role="alert" className="sb-login__account-error">
                {accountError}
              </p>
            ) : null}
            <div className="sb-login__account-actions">
              <span className="sb-login__account-note">
                Your own workspace — data saved on this device.
              </span>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={accountBusy}
                disabled={username.trim() === '' || password === ''}
              >
                {accountMode === 'signup' ? 'Create & open workspace' : 'Sign in'}
              </Button>
            </div>
          </form>
        </section>

        <p className="sb-login__divider" role="presentation">
          or use a demo profile
        </p>

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
