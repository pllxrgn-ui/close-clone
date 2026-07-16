import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, EmptyState, Skeleton } from '../../../../ui/index.ts';
import { listUsers } from '../../../../api/reference.ts';
import { ApiError } from '../../../../api/index.ts';
import { USERS_QUERY_KEY } from '../../queryKeys.ts';

/*
 * Users section — read-backed from the D-023 `GET /users` reference endpoint
 * (minimal shape: id, name, email, isActive; never tokens/idp fields). Role is an
 * achromatic chip (roles aren't states); the active dot is the only color, per the
 * state-is-the-color-budget law.
 */

function errorText(err: unknown): string {
  return err instanceof ApiError ? `${err.message} (${err.code})` : 'Something went wrong.';
}

export function UsersSection(): JSX.Element {
  const usersQuery = useQuery({ queryKey: USERS_QUERY_KEY, queryFn: () => listUsers() });

  return (
    <section className="admin-section" aria-labelledby="admin-users-title">
      <header className="admin-section__head">
        <h1 id="admin-users-title" className="admin-section__title">
          Users
        </h1>
        <p className="admin-section__desc">
          People with access to this workspace. Roles and access are managed by an admin.
        </p>
      </header>

      {usersQuery.isLoading ? (
        <div className="admin-stack" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={36} />
          ))}
        </div>
      ) : usersQuery.isError ? (
        <EmptyState
          title="Couldn’t load users"
          description={errorText(usersQuery.error)}
          actions={<Button onClick={() => void usersQuery.refetch()}>Retry</Button>}
        />
      ) : (usersQuery.data ?? []).length === 0 ? (
        <EmptyState title="No users" description="No one has access to this workspace yet." />
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <caption className="sb-visually-hidden">Users with workspace access</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {(usersQuery.data ?? []).map((user) => (
                <tr key={user.id}>
                  <th scope="row" className="admin-table__name">
                    {user.name}
                  </th>
                  <td className="admin-mono">{user.email}</td>
                  <td>
                    <span className="admin-chip" data-role={user.role}>
                      {user.role}
                    </span>
                  </td>
                  <td>
                    <span className="admin-live">
                      <span
                        className="admin-live__dot"
                        data-on={user.isActive ? '' : undefined}
                        aria-hidden="true"
                      />
                      {user.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
