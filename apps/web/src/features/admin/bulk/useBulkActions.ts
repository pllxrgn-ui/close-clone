/*
 * The bulk-action implementations, bound to the query cache + toast surface. Each
 * mutation is optimistic (the lead-bearing caches patch immediately, roll back on
 * error) and confirms with a counted toast ("12 leads assigned to …"). Real store
 * mutation happens through the C7 endpoints (leads CRUD PATCH, sequence enroll),
 * so the leads board reflects the change and it survives route changes.
 *
 * These are exported (via the feature index) for the leads bulk bar to call at
 * merge; nothing here reads the leads feature's internals — cache patching is
 * structural (see leadCache.ts).
 */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Lead, LeadStatus, User } from '@switchboard/shared';
import { ApiError } from '../../../api/index.ts';
import { useToast } from '../../../feedback/ToastProvider.tsx';
import { enrollLeads, patchLead } from '../api.ts';
import type { SequenceWithCount } from '../types.ts';
import { SEQUENCES_QUERY_KEY } from '../queryKeys.ts';
import type { CsvLabelCtx } from './csv.ts';
import { csvFilename, downloadCsv, leadsToCsv } from './csv.ts';
import { applyOptimisticLeadPatch, restoreSnapshot, type LeadPatchFn } from './leadCache.ts';
import type { LeadPatch } from '../api.ts';

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${fallback} — ${err.message}`;
  return fallback;
}

export interface BulkActionsApi {
  assignOwner(leads: readonly Lead[], owner: User): Promise<void>;
  setStatus(leads: readonly Lead[], status: LeadStatus): Promise<void>;
  setDnc(leads: readonly Lead[], reason: string): Promise<void>;
  clearDnc(leads: readonly Lead[], reason: string): Promise<void>;
  enroll(leads: readonly Lead[], sequence: SequenceWithCount): Promise<void>;
  exportCsv(leads: readonly Lead[], ctx: CsvLabelCtx): void;
  /** True while any bulk mutation is in flight (drives the bar's busy state). */
  pending: boolean;
}

export function useBulkActions(): BulkActionsApi {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingCount, setPendingCount] = useState(0);

  const track = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setPendingCount((c) => c + 1);
    try {
      await fn();
    } finally {
      setPendingCount((c) => c - 1);
    }
  }, []);

  /** Shared optimistic runner for lead-field mutations. */
  const runLeadPatch = useCallback(
    async (
      leads: readonly Lead[],
      body: LeadPatch,
      cachePatch: LeadPatchFn,
      successMsg: string,
      failMsg: string,
    ): Promise<void> => {
      if (leads.length === 0) return;
      const ids = new Set(leads.map((l) => l.id));
      const snapshot = applyOptimisticLeadPatch(queryClient, ids, cachePatch);
      try {
        await Promise.all(leads.map((lead) => patchLead(lead.id, body)));
        toast(successMsg);
        for (const [key] of snapshot) {
          void queryClient.invalidateQueries({ queryKey: key, exact: true });
        }
      } catch (err) {
        restoreSnapshot(queryClient, snapshot);
        toast(errorMessage(err, failMsg));
        throw err;
      }
    },
    [queryClient, toast],
  );

  const assignOwner = useCallback<BulkActionsApi['assignOwner']>(
    (leads, owner) =>
      track(() =>
        runLeadPatch(
          leads,
          { ownerId: owner.id },
          (l) => ({ ...l, ownerId: owner.id }),
          `${plural(leads.length, 'lead')} assigned to ${owner.name}`,
          `Couldn’t assign ${plural(leads.length, 'lead')}`,
        ),
      ),
    [track, runLeadPatch],
  );

  const setStatus = useCallback<BulkActionsApi['setStatus']>(
    (leads, status) =>
      track(() =>
        runLeadPatch(
          leads,
          { statusId: status.id },
          (l) => ({ ...l, statusId: status.id }),
          `${plural(leads.length, 'lead')} set to ${status.label}`,
          `Couldn’t update ${plural(leads.length, 'lead')}`,
        ),
      ),
    [track, runLeadPatch],
  );

  const setDnc = useCallback<BulkActionsApi['setDnc']>(
    (leads, reason) =>
      track(() =>
        runLeadPatch(
          leads,
          { dnc: true, reason },
          (l) => ({ ...l, dnc: true }),
          `${plural(leads.length, 'lead')} marked Do Not Contact`,
          `Couldn’t update DNC on ${plural(leads.length, 'lead')}`,
        ),
      ),
    [track, runLeadPatch],
  );

  const clearDnc = useCallback<BulkActionsApi['clearDnc']>(
    (leads, reason) =>
      track(() =>
        runLeadPatch(
          leads,
          { dnc: false, reason },
          (l) => ({ ...l, dnc: false }),
          `DNC cleared on ${plural(leads.length, 'lead')}`,
          `Couldn’t clear DNC on ${plural(leads.length, 'lead')}`,
        ),
      ),
    [track, runLeadPatch],
  );

  const enroll = useCallback<BulkActionsApi['enroll']>(
    (leads, sequence) =>
      track(async () => {
        if (leads.length === 0) return;
        try {
          const result = await enrollLeads(
            sequence.id,
            leads.map((l) => l.id),
          );
          const parts = [`${plural(result.enrolled, 'lead')} enrolled in ${sequence.name}`];
          if (result.skipped > 0) {
            parts.push(`${result.skipped} skipped (DNC)`);
          }
          toast(parts.join(' · '));
          void queryClient.invalidateQueries({ queryKey: SEQUENCES_QUERY_KEY });
        } catch (err) {
          toast(errorMessage(err, `Couldn’t enroll ${plural(leads.length, 'lead')}`));
          throw err;
        }
      }),
    [track, toast, queryClient],
  );

  const exportCsv = useCallback<BulkActionsApi['exportCsv']>(
    (leads, ctx) => {
      if (leads.length === 0) return;
      const ok = downloadCsv(csvFilename(), leadsToCsv(leads, ctx));
      toast(
        ok ? `Exported ${plural(leads.length, 'lead')} to CSV` : 'CSV export isn’t available here',
      );
    },
    [toast],
  );

  return { assignOwner, setStatus, setDnc, clearDnc, enroll, exportCsv, pending: pendingCount > 0 };
}
