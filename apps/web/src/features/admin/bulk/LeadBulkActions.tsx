import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Lead } from '@switchboard/shared';
import '../admin.css';
import { Button, Combobox } from '../../../ui/index.ts';
import { listLeadStatuses, listUsers } from '../../../api/reference.ts';
import { listSequences } from '../api.ts';
import { LEAD_STATUSES_QUERY_KEY, SEQUENCES_QUERY_KEY, USERS_QUERY_KEY } from '../queryKeys.ts';
import {
  AssignOwnerIcon,
  DncClearIcon,
  DncIcon,
  ExportIcon,
  SequenceIcon,
  StatusIcon,
} from '../icons.tsx';
import type { CsvLabelCtx } from './csv.ts';
import { clearBulkSelection, setBulkSelection } from './selectionStore.ts';
import { DncReasonDialog } from './pickers.tsx';
import { useBulkActions } from './useBulkActions.ts';

/*
 * The live bulk-action set for the leads board's multi-select bar. Rendered in
 * place of the leads feature's Phase-4 disabled placeholders at merge (see the
 * report's routeWiring) — it owns only the action buttons + their dialogs, so it
 * drops straight into `.bulk-bar__actions`. Every button does something real; a
 * successful mutation calls `onDone` (the bar clears its selection).
 */

export interface LeadBulkActionsProps {
  selectedLeads: readonly Lead[];
  /** Called after a successful mutating action (the bar clears the selection). */
  onDone?: () => void;
}

type DialogKind = null | 'owner' | 'status' | 'sequence' | { dnc: 'set' | 'clear' };

function statusAccent(label: string): string | undefined {
  if (label === 'Won') return 'var(--state-reply-solid, var(--state-reply))';
  if (label === 'Lost') return 'var(--state-idle)';
  return undefined;
}

export function LeadBulkActions({ selectedLeads, onDone }: LeadBulkActionsProps): JSX.Element {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const actions = useBulkActions();

  const usersQuery = useQuery({ queryKey: USERS_QUERY_KEY, queryFn: () => listUsers() });
  const statusesQuery = useQuery({
    queryKey: LEAD_STATUSES_QUERY_KEY,
    queryFn: () => listLeadStatuses(),
  });
  const sequencesQuery = useQuery({
    queryKey: SEQUENCES_QUERY_KEY,
    queryFn: () => listSequences(),
  });

  const users = usersQuery.data ?? [];
  const statuses = statusesQuery.data ?? [];
  const sequences = useMemo(
    () => (sequencesQuery.data ?? []).filter((s) => s.status === 'active'),
    [sequencesQuery.data],
  );

  const ctx = useMemo<CsvLabelCtx>(() => {
    const userById = new Map(users.map((u) => [u.id, u.name]));
    const statusById = new Map(statuses.map((s) => [s.id, s.label]));
    return {
      ownerName: (id) => (id ? (userById.get(id) ?? '—') : '—'),
      statusLabel: (id) => (id ? (statusById.get(id) ?? '—') : '—'),
    };
  }, [users, statuses]);

  // Mirror the selection so the palette's "Export selected leads (CSV)" is real.
  useEffect(() => {
    setBulkSelection(selectedLeads, ctx);
    return () => clearBulkSelection();
  }, [selectedLeads, ctx]);

  const count = selectedLeads.length;
  const allDnc = count > 0 && selectedLeads.every((l) => l.dnc);
  const close = (): void => setDialog(null);
  const done = (): void => {
    close();
    onDone?.();
  };

  return (
    <>
      {dialog === 'owner' ? (
        <Combobox
          label="Assign owner"
          className="bulk-bar__picker"
          placeholder="Search reps…"
          defaultOpen
          clearable={false}
          value={null}
          options={users.map((u) => ({
            value: u.id,
            label: u.name,
            sublabel: u.isActive ? u.role : `${u.role} · inactive`,
          }))}
          onChange={(id) => {
            const owner = users.find((u) => u.id === id);
            if (owner) void actions.assignOwner(selectedLeads, owner).then(done, close);
          }}
          onClose={close}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={actions.pending || usersQuery.data === undefined}
          onClick={() => setDialog('owner')}
        >
          <AssignOwnerIcon size={14} />
          Assign owner
        </Button>
      )}

      {dialog === 'status' ? (
        <Combobox
          label="Set status"
          className="bulk-bar__picker"
          placeholder="Set status…"
          defaultOpen
          clearable={false}
          value={null}
          options={statuses.map((s) => {
            const accent = statusAccent(s.label);
            return { value: s.id, label: s.label, ...(accent ? { accent } : {}) };
          })}
          onChange={(id) => {
            const status = statuses.find((s) => s.id === id);
            if (status) void actions.setStatus(selectedLeads, status).then(done, close);
          }}
          onClose={close}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={actions.pending || statusesQuery.data === undefined}
          onClick={() => setDialog('status')}
        >
          <StatusIcon size={14} />
          Edit status
        </Button>
      )}

      {dialog === 'sequence' ? (
        <Combobox
          label="Enroll in sequence"
          className="bulk-bar__picker"
          placeholder="Search sequences…"
          emptyLabel="No active sequences."
          defaultOpen
          clearable={false}
          value={null}
          options={sequences.map((s) => ({
            value: s.id,
            label: s.name,
            sublabel: `${s.activeEnrollments.toLocaleString('en-US')} active`,
          }))}
          onChange={(id) => {
            const seq = sequences.find((s) => s.id === id);
            if (seq) void actions.enroll(selectedLeads, seq).then(done, close);
          }}
          onClose={close}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={actions.pending || sequencesQuery.data === undefined}
          onClick={() => setDialog('sequence')}
        >
          <SequenceIcon size={14} />
          Enroll in sequence
        </Button>
      )}

      <Button size="sm" variant="ghost" onClick={() => actions.exportCsv(selectedLeads, ctx)}>
        <ExportIcon size={14} />
        Export CSV
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={actions.pending}
        onClick={() => setDialog({ dnc: allDnc ? 'clear' : 'set' })}
      >
        {allDnc ? <DncClearIcon size={14} /> : <DncIcon size={14} />}
        {allDnc ? 'Clear DNC' : 'Set DNC'}
      </Button>

      <DncReasonDialog
        open={typeof dialog === 'object' && dialog !== null}
        mode={typeof dialog === 'object' && dialog !== null ? dialog.dnc : 'set'}
        count={count}
        onConfirm={(reason) => {
          if (typeof dialog !== 'object' || dialog === null) return;
          const run = dialog.dnc === 'set' ? actions.setDnc : actions.clearDnc;
          void run(selectedLeads, reason).then(done, close);
        }}
        onClose={close}
      />
    </>
  );
}
