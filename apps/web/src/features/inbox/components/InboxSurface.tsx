import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../../api/index.ts';
import { Button, EmptyState, Skeleton } from '../../../ui/index.ts';
import { useToast } from '../../../feedback/index.ts';
import {
  approveReview,
  completeTask,
  getInboxQueue,
  getInboxStats,
  sendReply,
  skipReview,
  snoozeItem,
} from '../api/inbox.ts';
import type { ComposerSendPayload } from './ComposerDrawer.tsx';
import { ComposerDrawer } from './ComposerDrawer.tsx';
import { InboxHeader } from './InboxHeader.tsx';
import { InboxRow } from './InboxRow.tsx';
import type { InboxRowActions } from './InboxRow.tsx';
import { ZeroInbox } from './ZeroInbox.tsx';
import { useInboxNav } from '../hooks/useInboxNav.ts';
import { groupSections } from '../model/queue.ts';
import type { InboxItem, InboxStats, ReplyItem } from '../model/types.ts';

const EMPTY_STATS: InboxStats = { needsYouNow: 0, overdue: 0, doneToday: 0 };

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SUPPRESSED') return 'This contact is on the do-not-contact list.';
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

export function InboxSurface(): JSX.Element {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const queueQuery = useQuery({
    queryKey: ['inbox'],
    queryFn: ({ signal }) => getInboxQueue(signal),
  });
  const statsQuery = useQuery({
    queryKey: ['inbox', 'stats'],
    queryFn: ({ signal }) => getInboxStats(signal),
  });

  const items: InboxItem[] = queueQuery.data?.items ?? [];
  const stats = statsQuery.data ?? EMPTY_STATS;

  const [composerItem, setComposerItem] = useState<ReplyItem | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const pendingRefocus = useRef(false);

  // Invalidating the ['inbox'] prefix refetches both the queue and the stats.
  const refresh = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['inbox'] });
  }, [queryClient]);

  const onActionError = useCallback(
    (error: unknown): void => {
      pendingRefocus.current = false;
      toast(errorMessage(error));
    },
    [toast],
  );

  const completeMutation = useMutation({
    mutationFn: (taskId: string) => completeTask(taskId),
    onSuccess: refresh,
    onError: onActionError,
  });
  const approveMutation = useMutation({
    mutationFn: (intentId: string) => approveReview(intentId),
    onSuccess: refresh,
    onError: onActionError,
  });
  const skipMutation = useMutation({
    mutationFn: (intentId: string) => skipReview(intentId),
    onSuccess: refresh,
    onError: onActionError,
  });
  const snoozeMutation = useMutation({
    mutationFn: (itemId: string) => snoozeItem(itemId),
    onSuccess: refresh,
    onError: onActionError,
  });
  const replyMutation = useMutation({
    mutationFn: (input: { item: ReplyItem; payload: ComposerSendPayload }) =>
      sendReply({
        threadId: input.item.threadId,
        channel: input.item.channel,
        to: input.item.toAddress,
        subject: input.payload.subject,
        body: input.payload.body,
        leadId: input.item.leadId,
      }),
    onSuccess: () => {
      setComposerItem(null);
      setSendError(null);
      pendingRefocus.current = true;
      refresh();
    },
    onError: (error) => setSendError(errorMessage(error)),
  });

  // ── Per-item action dispatch (shared by keyboard + row buttons) ─────────────
  const openReply = useCallback((item: ReplyItem): void => {
    setSendError(null);
    setComposerItem(item);
  }, []);
  const complete = useCallback(
    (item: InboxItem): void => {
      if (item.kind !== 'task') return;
      pendingRefocus.current = true;
      completeMutation.mutate(item.taskId);
    },
    [completeMutation],
  );
  const approve = useCallback(
    (item: InboxItem): void => {
      if (item.kind !== 'review') return;
      pendingRefocus.current = true;
      approveMutation.mutate(item.intentId);
    },
    [approveMutation],
  );
  const skip = useCallback(
    (item: InboxItem): void => {
      if (item.kind !== 'review') return;
      pendingRefocus.current = true;
      skipMutation.mutate(item.intentId);
    },
    [skipMutation],
  );
  const snooze = useCallback(
    (item: InboxItem): void => {
      pendingRefocus.current = true;
      snoozeMutation.mutate(item.id);
    },
    [snoozeMutation],
  );
  const primary = useCallback(
    (item: InboxItem): void => {
      if (item.kind === 'reply') openReply(item);
      else if (item.kind === 'task') complete(item);
      else approve(item);
    },
    [openReply, complete, approve],
  );

  const nav = useInboxNav({
    count: items.length,
    enabled: composerItem === null,
    onPrimary: (index) => {
      const item = items[index];
      if (item) primary(item);
    },
    onComplete: (index) => {
      const item = items[index];
      if (item) complete(item);
    },
    onReply: (index) => {
      const item = items[index];
      if (item?.kind === 'reply') openReply(item);
    },
    onSnooze: (index) => {
      const item = items[index];
      if (item) snooze(item);
    },
    onApprove: (index) => {
      const item = items[index];
      if (item) approve(item);
    },
    onSkip: (index) => {
      const item = items[index];
      if (item) skip(item);
    },
  });

  const { focusActive } = nav;
  // After an action shifts the queue, keep the flow by focusing the row that slid
  // into the active slot (never animates — it is a keyboard-driven focus move).
  useEffect(() => {
    if (pendingRefocus.current) {
      pendingRefocus.current = false;
      focusActive();
    }
  }, [items, focusActive]);

  const rowActionsFor = (item: InboxItem): InboxRowActions => ({
    onReply: () => {
      if (item.kind === 'reply') openReply(item);
    },
    onComplete: () => complete(item),
    onApprove: () => approve(item),
    onSkip: () => skip(item),
    onSnooze: () => snooze(item),
  });

  function renderSections(): JSX.Element[] {
    const sections = groupSections(items);
    const out: JSX.Element[] = [];
    let index = 0;
    for (const section of sections) {
      const rows: JSX.Element[] = [];
      for (const item of section.items) {
        const rowIndex = index;
        rows.push(
          <InboxRow
            key={item.id}
            item={item}
            active={rowIndex === nav.activeIndex}
            rowProps={nav.getRowProps(rowIndex)}
            actions={rowActionsFor(item)}
          />,
        );
        index += 1;
      }
      out.push(
        <section
          key={section.id}
          className="sb-inbox__section"
          aria-label={`${section.label}, ${section.items.length}`}
        >
          <h2 className="sb-inbox__section-head">
            <span className="sb-inbox__section-label">{section.label}</span>
            <span className="sb-inbox__section-count">{section.items.length}</span>
          </h2>
          <ul className="sb-inbox__rows">{rows}</ul>
        </section>,
      );
    }
    return out;
  }

  const isLoading = queueQuery.isLoading;
  const isError = queueQuery.isError;

  return (
    <div className="sb-inbox">
      <InboxHeader stats={stats} />

      <div className="sb-inbox__body">
        {isError ? (
          <EmptyState
            title="Couldn’t load your inbox"
            description={errorMessage(queueQuery.error)}
            actions={<Button onClick={() => void queueQuery.refetch()}>Retry</Button>}
          />
        ) : isLoading ? (
          <div className="sb-inbox__loading" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={36} className="sb-inbox__loading-row" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <ZeroInbox doneToday={stats.doneToday} />
        ) : (
          <div className="sb-inbox__queue">{renderSections()}</div>
        )}
      </div>

      <ComposerDrawer
        item={composerItem}
        sending={replyMutation.isPending}
        errorMessage={sendError}
        onClose={() => {
          setComposerItem(null);
          setSendError(null);
        }}
        onSend={(payload) => {
          if (composerItem) replyMutation.mutate({ item: composerItem, payload });
        }}
      />
    </div>
  );
}
