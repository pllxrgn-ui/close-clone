import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SmartView } from '@switchboard/shared';
import { apiRequest } from '../../../api/client.ts';
import { useAuth } from '../../../auth/AuthProvider.tsx';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Kbd,
  Select,
  Skeleton,
  StatusPill,
} from '../../../ui/index.ts';
import { useKeyBindings } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';
import { useCall } from '../context/CallProvider.tsx';
import { loadDialerQueue, type DialerQueuePage } from '../api/calling.ts';
import type { DialerEntry } from '../mocks/callingHandlers.ts';
import { formatPhone } from '../lib/presets.ts';
import { BanIcon, PhoneIcon, SkipForwardIcon } from '../icons.tsx';

/*
 * The list dialer (build guide §3): a SEQUENTIAL, rep-advances power-dialer over a
 * Smart View — deliberately NOT predictive. Exactly one live call at a time (the
 * engine 409s a second), the rep advances by hand (`N`), and a DNC / suppressed
 * lead is skipped and shown blocked (the rail is visible, never dialed). Placing a
 * call goes through the same compliance-gated engine as the lead-page launcher, so
 * the global call strip owns the live call here too.
 */

const QUEUE_LIMIT = 50;

function firstDialable(entries: readonly DialerEntry[]): DialerEntry | undefined {
  return entries.find((e) => e.dialable);
}

function nextDialableAfter(
  entries: readonly DialerEntry[],
  leadId: string | null,
): DialerEntry | undefined {
  const start = leadId ? entries.findIndex((e) => e.leadId === leadId) : -1;
  for (let i = start + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry && entry.dialable) return entry;
  }
  return undefined;
}

function blockReason(entry: DialerEntry): string | null {
  if (entry.dnc) return 'Do not contact';
  if (entry.suppressed) return 'Suppressed';
  return null;
}

export function ListDialer(): JSX.Element {
  const { user } = useAuth();
  const { startCall, session, isBusy } = useCall();
  const userId = user?.id ?? '';

  const viewsQuery = useQuery({
    queryKey: ['smart-views'],
    queryFn: ({ signal }) => apiRequest<SmartView[]>('/smart-views', signal ? { signal } : {}),
  });
  const [viewId, setViewId] = useState<string | null>(null);
  useEffect(() => {
    if (viewId === null && viewsQuery.data && viewsQuery.data.length > 0) {
      setViewId(viewsQuery.data[0]!.id);
    }
  }, [viewsQuery.data, viewId]);

  const queueQuery = useQuery<DialerQueuePage>({
    queryKey: ['dialer-queue', viewId, userId],
    enabled: userId !== '' && viewId !== null,
    queryFn: ({ signal }) =>
      loadDialerQueue({ userId, smartViewId: viewId as string, limit: QUEUE_LIMIT }, signal),
  });

  const entries = useMemo<DialerEntry[]>(() => queueQuery.data?.items ?? [], [queueQuery.data]);
  const entriesRef = useRef<DialerEntry[]>(entries);
  entriesRef.current = entries;

  const [cursorLeadId, setCursorLeadId] = useState<string | null>(null);
  // Seat the cursor on the first dialable lead whenever the queue (or view) loads.
  useEffect(() => {
    setCursorLeadId(firstDialable(entries)?.leadId ?? null);
  }, [entries]);

  const onDeck = entries.find((e) => e.leadId === cursorLeadId) ?? null;
  const callable = entries.filter((e) => e.dialable);
  const blockedCount = entries.length - callable.length;
  const onDeckPosition = onDeck ? callable.findIndex((e) => e.leadId === onDeck.leadId) + 1 : 0;

  // Auto-advance: once a dialed call ends (the strip closes), move to the next lead.
  const pendingAdvance = useRef<string | null>(null);
  useEffect(() => {
    if (session === null && pendingAdvance.current !== null) {
      const dialed = pendingAdvance.current;
      pendingAdvance.current = null;
      setCursorLeadId(nextDialableAfter(entriesRef.current, dialed)?.leadId ?? null);
    }
  }, [session]);

  const callOnDeck = (): void => {
    if (!onDeck || isBusy) return;
    void startCall(
      {
        leadId: onDeck.leadId,
        leadName: onDeck.leadName,
        ...(onDeck.contactId ? { contactId: onDeck.contactId } : {}),
        ...(onDeck.phone ? { to: onDeck.phone } : {}),
      },
      { via: 'advance', origin: 'pointer' },
    ).then((res) => {
      if (res.ok) pendingAdvance.current = onDeck.leadId;
    });
  };

  const skip = (): void => {
    setCursorLeadId(nextDialableAfter(entriesRef.current, cursorLeadId)?.leadId ?? null);
  };

  const restart = (): void => {
    setCursorLeadId(firstDialable(entriesRef.current)?.leadId ?? null);
  };

  const keyDefs: KeyBindingDef[] = [
    {
      id: 'calling:dialer-call',
      combo: 'c',
      scope: 'route',
      label: 'Call this lead',
      group: 'List dialer',
      when: () => onDeck !== null && !isBusy,
      handler: callOnDeck,
    },
    {
      id: 'calling:dialer-next',
      combo: 'n',
      scope: 'route',
      label: 'Next lead',
      group: 'List dialer',
      when: () => nextDialableAfter(entriesRef.current, cursorLeadId) !== undefined,
      handler: skip,
    },
  ];
  useKeyBindings(keyDefs);

  return (
    <section className="dialer" aria-labelledby="dialer-title">
      <header className="dialer__head">
        <div>
          <h1 id="dialer-title" className="dialer__title">
            List dialer
          </h1>
          <p className="dialer__sub">
            One call at a time — the rep advances. DNC leads are skipped, never dialed.
          </p>
        </div>
        <Field label="Smart View" className="dialer__view">
          <Select
            value={viewId ?? ''}
            onChange={(e) => setViewId(e.target.value)}
            disabled={!viewsQuery.data}
          >
            {(viewsQuery.data ?? []).map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </Select>
        </Field>
      </header>

      {queueQuery.isPending ? (
        <div className="dialer__loading">
          <Skeleton height={104} radius="0" />
          <Skeleton height={36} radius="0" />
          <Skeleton height={36} radius="0" />
          <Skeleton height={36} radius="0" />
        </div>
      ) : queueQuery.isError ? (
        <ErrorState
          title="Couldn't load the dialer queue"
          onRetry={() => void queueQuery.refetch()}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No callable leads in this view"
          description="Pick another Smart View, or add a phone number to a contact."
        />
      ) : (
        <>
          <div className="dialer__progress" aria-live="polite">
            {onDeck ? (
              <span>
                Lead <strong>{onDeckPosition}</strong> of {callable.length} callable
              </span>
            ) : (
              <span>Queue complete</span>
            )}
            {blockedCount > 0 ? (
              <span className="dialer__blocked-count">
                <BanIcon size={12} /> {blockedCount} blocked
              </span>
            ) : null}
          </div>

          {onDeck ? (
            <div className="dialer__ondeck" data-testid="dialer-ondeck">
              <div className="dialer__ondeck-who">
                <span className="dialer__ondeck-name">{onDeck.leadName}</span>
                <span className="dialer__ondeck-phone">{formatPhone(onDeck.phone ?? '')}</span>
              </div>
              <div className="dialer__ondeck-actions">
                <Button variant="ghost" size="sm" onClick={skip} disabled={isBusy}>
                  <SkipForwardIcon size={14} /> Skip <Kbd>N</Kbd>
                </Button>
                <Button variant="primary" onClick={callOnDeck} disabled={isBusy}>
                  <PhoneIcon size={15} /> Call <Kbd>C</Kbd>
                </Button>
              </div>
            </div>
          ) : (
            <div className="dialer__ondeck dialer__ondeck--done">
              <span>You've worked the whole queue.</span>
              <Button size="sm" onClick={restart}>
                Start over
              </Button>
            </div>
          )}

          <ol className="dialer__queue" aria-label="Dialer queue">
            {entries.map((entry) => {
              const reason = blockReason(entry);
              const isCurrent = entry.leadId === onDeck?.leadId;
              return (
                <li
                  key={entry.leadId}
                  className="dialer__row"
                  data-current={isCurrent || undefined}
                  data-blocked={reason !== null || undefined}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <span className="dialer__row-name">{entry.leadName}</span>
                  <span className="dialer__row-phone">{formatPhone(entry.phone ?? '')}</span>
                  {reason ? (
                    <StatusPill tone="dnc" dot>
                      {reason}
                    </StatusPill>
                  ) : isCurrent ? (
                    <StatusPill tone="newReply" dot>
                      On deck
                    </StatusPill>
                  ) : (
                    <span className="dialer__row-ready">Ready</span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
