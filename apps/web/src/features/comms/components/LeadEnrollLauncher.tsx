import { useId, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Lead } from '@switchboard/shared';
import {
  Button,
  CloseIcon,
  EmptyState,
  IconButton,
  Modal,
  Select,
  Spinner,
} from '../../../ui/index.ts';
import { ApiError } from '../../../api/errors.ts';
import { useToast } from '../../../feedback/index.ts';
import { enrollInSequence, listLeadContacts, listSequences } from '../api/comms.ts';
import { primaryEmail } from '../lib/mergeTags.ts';
import { BranchIcon } from '../icons.tsx';

/*
 * The lead-page "Enroll" next-action (replaces the last disabled stub): pick one
 * of the ACTIVE sequences for THIS lead (the inverse of the sequence page's
 * EnrollDrawer, which picks a lead for a sequence). Enrolls via the real C7
 * bulk route (`POST /sequences/:id/enroll`, one-element targets) — the engine
 * owns scheduling and re-checks every §4.3 rail inside the send transaction, so
 * a DNC/suppressed contact is enrolled but never sent to (I-DNC at send time).
 */

export function LeadEnrollLauncher({ lead }: { lead: Lead }): JSX.Element {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const headingId = useId();
  const listId = useId();

  const [open, setOpen] = useState(false);
  const [sequenceId, setSequenceId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);

  const sequencesQuery = useQuery({
    queryKey: ['comms', 'sequences'],
    queryFn: () => listSequences(),
    enabled: open,
  });
  const contactsQuery = useQuery({
    queryKey: ['lead-contacts', lead.id],
    queryFn: () => listLeadContacts(lead.id),
    enabled: open,
  });

  const active = useMemo(
    () => (sequencesQuery.data ?? []).filter((s) => s.status === 'active'),
    [sequencesQuery.data],
  );
  const contacts = contactsQuery.data ?? [];
  const selectedContact = contacts.find((c) => c.id === contactId) ?? contacts[0] ?? null;

  function close(): void {
    setOpen(false);
    setSequenceId(null);
    setContactId(null);
    mutation.reset();
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!sequenceId || !selectedContact) return Promise.reject(new Error('no selection'));
      return enrollInSequence(sequenceId, { leadId: lead.id, contactId: selectedContact.id });
    },
    onSuccess: (result) => {
      const name = active.find((s) => s.id === sequenceId)?.name ?? 'sequence';
      if (result.enrolled.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ['lead-timeline', lead.id] });
        void queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
        toast(`Enrolled in ${name}`);
        close();
        return;
      }
      const reason = result.skipped[0]?.reason;
      toast(
        reason === 'already_enrolled'
          ? `${selectedContact?.name ?? 'This contact'} is already in ${name}`
          : `Could not enroll — ${reason ?? 'skipped'}`,
      );
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Could not enroll');
    },
  });

  const isLoading = sequencesQuery.isLoading || contactsQuery.isLoading;
  const canEnroll = sequenceId !== null && selectedContact !== null && !mutation.isPending;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} title={`Enroll ${lead.name} in a sequence`}>
        <BranchIcon size={14} /> Enroll
      </Button>
      <Modal
        open={open}
        onClose={close}
        labelledBy={headingId}
        className="comms-enroll-lead"
        backdropClassName="sb-overlay--center"
      >
        <div className="comms-enroll-lead__inner">
          <header className="comms-enroll-lead__head">
            <h2 id={headingId} className="comms-enroll-lead__title">
              <BranchIcon size={15} /> Enroll · {lead.name}
            </h2>
            <IconButton label="Close" size="sm" onClick={close}>
              <CloseIcon size={16} />
            </IconButton>
          </header>

          {isLoading ? (
            <div className="comms-enroll-lead__loading" role="status">
              <Spinner label="Loading sequences" />
            </div>
          ) : contacts.length === 0 ? (
            <EmptyState
              title="No contacts on this lead"
              description="Sequences send to a contact — add one before enrolling."
            />
          ) : active.length === 0 ? (
            <EmptyState
              title="No active sequences"
              description="Create or activate a sequence first."
            />
          ) : (
            <>
              {contacts.length > 1 ? (
                <label className="comms-field">
                  <span className="comms-field__label">Contact</span>
                  <Select
                    value={selectedContact?.id ?? ''}
                    onChange={(e) => setContactId(e.target.value)}
                    aria-label="Contact to enroll"
                  >
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {primaryEmail(c) || 'no email'}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}

              <div className="comms-enroll-lead__list" role="radiogroup" aria-labelledby={listId}>
                <span id={listId} className="comms-field__label">
                  Sequence
                </span>
                {active.map((seq) => (
                  <button
                    key={seq.id}
                    type="button"
                    role="radio"
                    aria-checked={sequenceId === seq.id}
                    className={
                      sequenceId === seq.id
                        ? 'comms-enroll-lead__row is-selected'
                        : 'comms-enroll-lead__row'
                    }
                    onClick={() => setSequenceId(seq.id)}
                  >
                    <BranchIcon size={14} />
                    <span className="comms-enroll-lead__name">{seq.name}</span>
                  </button>
                ))}
              </div>

              {lead.dnc || selectedContact?.dnc ? (
                <p className="comms-enroll-lead__dnc">
                  Do-not-contact applies: steps are scheduled but the engine blocks every send
                  (I-DNC).
                </p>
              ) : null}
            </>
          )}

          <footer className="comms-enroll-lead__foot">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => mutation.mutate()}
              disabled={!canEnroll}
              loading={mutation.isPending}
            >
              <BranchIcon size={14} /> Enroll
            </Button>
          </footer>
        </div>
      </Modal>
    </>
  );
}
