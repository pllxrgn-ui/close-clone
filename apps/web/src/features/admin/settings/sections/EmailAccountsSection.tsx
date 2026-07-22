import { useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { EmailAccount } from '@switchboard/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../../../api/index.ts';
import { browserNav } from '../../../../auth/browserNav.ts';
import { useAuth } from '../../../../auth/AuthProvider.tsx';
import { useToast } from '../../../../feedback/ToastProvider.tsx';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  StatusPill,
} from '../../../../ui/index.ts';
import { disconnectEmailAccount, listEmailAccounts, startGmailLink } from '../../api.ts';
import { EMAIL_ACCOUNTS_QUERY_KEY } from '../../queryKeys.ts';
import { InboxesIcon } from '../../icons.tsx';

const STATUS_LABELS: Record<EmailAccount['syncStatus'], string> = {
  UNLINKED: 'Not connected',
  AUTHORIZING: 'Awaiting Google',
  BACKFILLING: 'Importing mail',
  LIVE: 'Connected',
  DEGRADED: 'Sync delayed',
  RESYNC: 'Resyncing mail',
  REAUTH_REQUIRED: 'Needs reconnect',
};

export function EmailAccountsSection(): JSX.Element {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [address, setAddress] = useState(user?.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const accountsQuery = useQuery({
    queryKey: EMAIL_ACCOUNTS_QUERY_KEY,
    queryFn: ({ signal }) => listEmailAccounts(signal),
  });

  const connect = useMutation({
    mutationFn: startGmailLink,
    onSuccess: ({ authUrl }) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: EMAIL_ACCOUNTS_QUERY_KEY });
      if (import.meta.env.VITE_API_MODE === 'real') {
        browserNav.assign(authUrl);
      } else {
        toast('Gmail connected in demo mode.');
      }
    },
    onError: (reason) => {
      setError(reason instanceof ApiError ? reason.message : 'Could not start Gmail connection.');
    },
  });
  const disconnect = useMutation({
    mutationFn: disconnectEmailAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: EMAIL_ACCOUNTS_QUERY_KEY });
      toast('Inbox disconnected. Existing email history was kept.');
    },
    onError: (reason) => {
      toast(reason instanceof ApiError ? reason.message : 'Could not disconnect inbox.');
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const normalized = address.trim().toLowerCase();
    if (!normalized) {
      setError('Enter the Gmail address you want to connect.');
      return;
    }
    connect.mutate(normalized);
  };

  return (
    <section className="admin-section" aria-labelledby="admin-inboxes-title">
      <header className="admin-section__head">
        <h1 id="admin-inboxes-title" className="admin-section__title">
          Inboxes
        </h1>
        <p className="admin-section__desc">
          Connect Gmail to sync conversations and send from your own mailbox. Google asks you to
          approve access; your password is never shared with Switchboard.
        </p>
      </header>

      <form className="admin-cf__form" onSubmit={submit}>
        <div className="admin-cf__form-grid">
          <Field
            label="Gmail address"
            hint="The Google account selected during approval must match."
            error={error}
            required
          >
            <Input
              type="email"
              autoComplete="email"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              required
            />
          </Field>
          <Button type="submit" variant="primary" loading={connect.isPending}>
            Connect Gmail
          </Button>
        </div>
      </form>

      <h2 className="admin-subhead">Connected accounts</h2>
      {accountsQuery.isLoading ? (
        <div className="admin-stack" aria-hidden="true">
          <Skeleton height={48} />
          <Skeleton height={48} />
        </div>
      ) : accountsQuery.isError ? (
        <ErrorState
          title="Couldn’t load inboxes"
          description={
            accountsQuery.error instanceof ApiError ? accountsQuery.error.message : undefined
          }
          onRetry={() => void accountsQuery.refetch()}
        />
      ) : accountsQuery.data?.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <caption className="sb-visually-hidden">Your connected email accounts</caption>
            <thead>
              <tr>
                <th scope="col">Email address</th>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {accountsQuery.data.map((account) => (
                <tr key={account.id}>
                  <th scope="row" className="admin-table__name">
                    {account.address}
                  </th>
                  <td>Gmail</td>
                  <td>
                    <StatusPill tone={account.syncStatus === 'LIVE' ? 'won' : 'draft'} dot>
                      {STATUS_LABELS[account.syncStatus]}
                    </StatusPill>
                  </td>
                  <td>
                    {account.syncStatus === 'REAUTH_REQUIRED' ? (
                      <Button
                        size="sm"
                        onClick={() => connect.mutate(account.address)}
                        loading={connect.isPending}
                      >
                        Reconnect Gmail
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Disconnect ${account.address}`}
                        onClick={() => disconnect.mutate(account.id)}
                        loading={disconnect.isPending}
                      >
                        Disconnect
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<InboxesIcon size={20} />}
          title="No inbox connected"
          description="Connect Gmail above to begin syncing email."
        />
      )}
    </section>
  );
}
