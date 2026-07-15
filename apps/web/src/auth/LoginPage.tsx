import type { JSX } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { User } from '@switchboard/shared';
import { useAuth } from './AuthProvider.tsx';
import { listDevUsers } from './devAuth.ts';
import { initials } from '../lib/format.ts';
import { Spinner } from '../ui/index.ts';
import { BoltIcon } from '../ui/icons.tsx';

interface LocationState {
  from?: string;
}

/**
 * Dev-login screen (MOCK auth). Picks a fixture user — no password, no external
 * account. On selection the user is stored and we return to the originally
 * requested route (or /inbox). Real OIDC replaces this screen wholesale.
 */
export function LoginPage(): JSX.Element {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from ?? '/inbox';

  const usersQuery = useQuery({ queryKey: ['dev-users'], queryFn: () => listDevUsers() });

  if (isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  const choose = (user: User): void => {
    login(user);
    navigate(from, { replace: true });
  };

  const users = usersQuery.data;

  return (
    <main className="sb-login">
      <div className="sb-login__card">
        <div className="sb-login__brand">
          <BoltIcon size={20} />
          <span>Switchboard</span>
        </div>
        <h1 className="sb-login__title">Sign in</h1>
        <p className="sb-login__hint">
          Mock mode — pick a user to sign in. No password and no external account required.
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
