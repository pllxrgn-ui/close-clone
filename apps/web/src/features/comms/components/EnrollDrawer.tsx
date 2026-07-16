import { useMemo, useRef, useState } from 'react';
import type { JSX, RefObject } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Button,
  Drawer,
  EmptyState,
  IconButton,
  Input,
  Spinner,
  StatusPill,
} from '../../../ui/index.ts';
import { ApiError } from '../../../api/index.ts';
import { search } from '../../../api/search.ts';
import { useToast } from '../../../feedback/index.ts';
import { useDebouncedValue } from '../../../command/index.ts';
import { enrollInSequence, listLeadContacts } from '../api/comms.ts';
import { primaryEmail } from '../lib/mergeTags.ts';
import { ArrowLeftIcon, BanIcon, CloseIcon, SearchIcon, UserPlusIcon } from '../icons.tsx';

/*
 * Enroll drawer for a sequence: search a lead → pick a contact → enroll. Built
 * on the shared Drawer primitive (portal + focus-trap + slide-in entrance). The
 * DNC rail shows before the action and blocks enroll; the server re-checks
 * (I-DNC) and the unique-active-enrollment rule (409) is surfaced as a toast.
 */
export function EnrollDrawer({
  open,
  onClose,
  sequenceId,
  sequenceName,
  onEnrolled,
}: {
  open: boolean;
  onClose: () => void;
  sequenceId: string;
  sequenceName: string;
  onEnrolled: () => void;
}): JSX.Element {
  const focusRef = useRef<HTMLElement | null>(null);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      label={`Enroll a contact in ${sequenceName}`}
      initialFocusRef={focusRef}
    >
      <EnrollBody
        key={open ? 'open' : 'closed'}
        sequenceId={sequenceId}
        sequenceName={sequenceName}
        onClose={onClose}
        onEnrolled={onEnrolled}
        searchRef={focusRef}
      />
    </Drawer>
  );
}

function EnrollBody({
  sequenceId,
  sequenceName,
  onClose,
  onEnrolled,
  searchRef,
}: {
  sequenceId: string;
  sequenceName: string;
  onClose: () => void;
  onEnrolled: () => void;
  searchRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ leadId: string; name: string } | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);

  const debounced = useDebouncedValue(query, 150);
  const trimmed = debounced.trim();
  const searchQuery = useQuery({
    queryKey: ['comms-enroll-search', trimmed],
    queryFn: ({ signal }) => search(trimmed, signal),
    enabled: picked === null && trimmed.length > 0,
    staleTime: 15_000,
  });
  const leads = (searchQuery.data?.items ?? []).filter((h) => h.type === 'lead').slice(0, 8);

  const contactsQuery = useQuery({
    queryKey: ['lead-contacts', picked?.leadId],
    queryFn: () => listLeadContacts(picked?.leadId ?? ''),
    enabled: picked !== null,
  });
  const contacts = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);
  const selectedContact = contacts.find((c) => c.id === contactId) ?? null;

  const mutation = useMutation({
    mutationFn: (input: { leadId: string; contactId: string }) =>
      enrollInSequence(sequenceId, input),
    onSuccess: (result) => {
      // The real bulk-enroll returns arrays, not an HTTP error, for a
      // duplicate/soft-deleted target — branch on them (this single target either
      // enrolled or was skipped with a reason).
      if (result.enrolled.length > 0) {
        toast(`Enrolled in ${sequenceName}`);
        onEnrolled();
        onClose();
        return;
      }
      const reason = result.skipped[0]?.reason;
      if (reason === 'already_enrolled') {
        toast('That contact is already enrolled in this sequence.');
      } else {
        toast('Could not enroll contact');
      }
    },
    onError: (err) => {
      // Genuine transport/validation failures (e.g. archived sequence → 422).
      if (err instanceof ApiError && err.code === 'SUPPRESSED') {
        toast('That contact is on the do-not-contact list.');
      } else {
        toast(err instanceof ApiError ? err.message : 'Could not enroll contact');
      }
    },
  });

  const blocked = selectedContact?.dnc ?? false;
  const canEnroll = picked !== null && !!selectedContact && !blocked && !mutation.isPending;

  return (
    <div className="comms-drawer__inner">
      <header className="comms-drawer__head">
        <h2 className="comms-drawer__title">
          <UserPlusIcon size={16} /> Enroll a contact
        </h2>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </header>

      <div className="comms-drawer__scroll">
        <p className="comms-hint">
          Adding to <strong>{sequenceName}</strong>.
        </p>

        {picked === null ? (
          <>
            <label className="comms-field">
              <span className="comms-field__label">Find a lead</span>
              <span className="comms-search">
                <SearchIcon size={14} className="comms-search__icon" />
                <Input
                  ref={searchRef as RefObject<HTMLInputElement>}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search leads…"
                  aria-label="Search leads"
                  autoComplete="off"
                  spellCheck={false}
                />
              </span>
            </label>
            {trimmed.length === 0 ? (
              <p className="comms-hint">Search for the lead whose contact you want to enroll.</p>
            ) : leads.length === 0 && !searchQuery.isFetching ? (
              <p className="comms-hint">No leads match “{trimmed}”.</p>
            ) : (
              <ul className="comms-picklist" aria-label="Lead results">
                {leads.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="sb-row comms-picklist__row"
                      onClick={() => {
                        setPicked({ leadId: hit.leadId, name: hit.title });
                        setContactId(null);
                      }}
                    >
                      <span className="comms-picklist__name">{hit.title}</span>
                      {hit.subtitle ? (
                        <span className="comms-picklist__sub">{hit.subtitle}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="comms-backlink"
              onClick={() => {
                setPicked(null);
                setContactId(null);
              }}
            >
              <ArrowLeftIcon size={13} /> {picked.name}
            </button>

            {contactsQuery.isLoading ? (
              <div className="comms-drawer__loading" role="status">
                <Spinner label="Loading contacts" />
              </div>
            ) : contacts.length === 0 ? (
              <EmptyState title="No contacts" description="This lead has no contacts to enroll." />
            ) : (
              <fieldset className="comms-radio">
                <legend className="comms-field__label">Contact</legend>
                {contacts.map((c) => {
                  const isSel = c.id === contactId;
                  return (
                    <label
                      key={c.id}
                      className={isSel ? 'comms-radio__opt is-selected' : 'comms-radio__opt'}
                    >
                      <input
                        type="radio"
                        name="enroll-contact"
                        value={c.id}
                        checked={isSel}
                        onChange={() => setContactId(c.id)}
                      />
                      <span className="comms-radio__main">
                        <span className="comms-radio__name">{c.name}</span>
                        <span className="comms-radio__email">{primaryEmail(c) || 'no email'}</span>
                      </span>
                      {c.dnc ? (
                        <StatusPill tone="dnc" dot>
                          DNC
                        </StatusPill>
                      ) : null}
                    </label>
                  );
                })}
              </fieldset>
            )}

            {blocked ? (
              <div className="comms-rail comms-rail--dnc" role="alert">
                <BanIcon size={16} />
                <div>
                  <StatusPill tone="dnc" dot>
                    Do not contact
                  </StatusPill>
                  <p className="comms-rail__reason">
                    This contact is marked do-not-contact and can’t be enrolled.
                  </p>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <footer className="comms-drawer__foot">
        <span className="comms-drawer__foot-hint" aria-live="polite">
          {picked === null
            ? 'Pick a lead to continue.'
            : !selectedContact
              ? 'Select a contact to enroll.'
              : blocked
                ? 'This contact can’t be enrolled.'
                : `Ready to enroll ${selectedContact.name}.`}
        </span>
        <div className="comms-drawer__foot-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canEnroll}
            loading={mutation.isPending}
            onClick={() => {
              if (picked && selectedContact) {
                mutation.mutate({ leadId: picked.leadId, contactId: selectedContact.id });
              }
            }}
          >
            <UserPlusIcon size={14} /> Enroll
          </Button>
        </div>
      </footer>
    </div>
  );
}
