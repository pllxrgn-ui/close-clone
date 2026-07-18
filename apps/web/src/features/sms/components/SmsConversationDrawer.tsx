import { useRef, useState } from 'react';
import type { JSX, RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Contact } from '@switchboard/shared';
import { Drawer, IconButton, Select, StatusPill } from '../../../ui/index.ts';
import { ApiError } from '../../../api/index.ts';
import { getLead } from '../../../api/leads.ts';
import { listLeadContacts, listSmsThread } from '../api/sms.ts';
import { formatPhone } from '../lib/sms.ts';
import { CloseIcon, MessageIcon } from '../icons.tsx';
import { SmsThread } from './SmsThread.tsx';
import { SmsComposer } from './SmsComposer.tsx';
import { LeadPicker } from './LeadPicker.tsx';

/*
 * The two-way SMS conversation drawer — the thread (top, scrollable) plus the
 * compliance-gated composer (bottom), edge-docked so the board stays visible. Opens
 * with a slide from the seam; INSTANT (no animation) when summoned by keyboard, per
 * the motion law. Reuses the Drawer primitive (Modal: focus trap, Escape, restore).
 *
 * Without a lead it opens on a lead picker (palette "Text lead…"); with one it goes
 * straight to the conversation. `key={leadId}` remounts the body per lead so state
 * (picked contact, draft) never leaks between conversations.
 */

export interface SmsConversationDrawerProps {
  open: boolean;
  onClose: () => void;
  leadId?: string | null;
  /** Keyboard-summoned (palette) → no entrance animation. */
  instant?: boolean;
  /** Instant the quiet-hours rail evaluates against (testing seam; defaults to now). */
  now?: Date;
}

export function SmsConversationDrawer({
  open,
  onClose,
  leadId = null,
  instant = false,
  now,
}: SmsConversationDrawerProps): JSX.Element | null {
  const initialFocusRef = useRef<HTMLElement | null>(null);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      label="Text message"
      instant={instant}
      className="sms-drawer"
      initialFocusRef={initialFocusRef}
    >
      <DrawerBody
        key={leadId ?? 'no-lead'}
        leadId={leadId}
        onClose={onClose}
        firstFieldRef={initialFocusRef}
        {...(now !== undefined ? { now } : {})}
      />
    </Drawer>
  );
}

function DrawerBody({
  leadId,
  onClose,
  firstFieldRef,
  now,
}: {
  leadId: string | null;
  onClose: () => void;
  firstFieldRef: RefObject<HTMLElement | null>;
  now?: Date;
}): JSX.Element {
  const [picked, setPicked] = useState<string | null>(null);
  const effectiveLeadId = leadId ?? picked;

  return (
    <div className="sms-drawer__inner">
      <header className="sms-drawer__head">
        <h2 className="sms-drawer__title">
          <MessageIcon size={16} /> Text message
        </h2>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </header>
      {effectiveLeadId ? (
        <Conversation
          leadId={effectiveLeadId}
          firstFieldRef={firstFieldRef}
          {...(now !== undefined ? { now } : {})}
        />
      ) : (
        <LeadPicker onPick={setPicked} onClose={onClose} searchRef={firstFieldRef} />
      )}
    </div>
  );
}

function Conversation({
  leadId,
  firstFieldRef,
  now,
}: {
  leadId: string;
  firstFieldRef: RefObject<HTMLElement | null>;
  now?: Date;
}): JSX.Element {
  const queryClient = useQueryClient();
  const threadQuery = useQuery({
    queryKey: ['sms-thread', leadId],
    queryFn: ({ signal }) => listSmsThread(leadId, signal),
  });
  const leadQuery = useQuery({ queryKey: ['lead', leadId], queryFn: () => getLead(leadId) });
  const contactsQuery = useQuery({
    queryKey: ['lead-contacts', leadId],
    queryFn: () => listLeadContacts(leadId),
  });

  const contacts = contactsQuery.data ?? [];
  const [contactId, setContactId] = useState<string | null>(null);
  const contact: Contact | null = contacts.find((c) => c.id === contactId) ?? contacts[0] ?? null;
  const lead = leadQuery.data ?? null;
  const toNumber = contact?.phones[0]?.phone ?? null;

  const messages = threadQuery.data ?? [];
  const evalNow = now ?? new Date();
  const threadError = threadQuery.error instanceof ApiError ? threadQuery.error.message : undefined;

  function onSent(): void {
    void queryClient.invalidateQueries({ queryKey: ['sms-thread', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
  }

  return (
    <>
      <div className="sms-recipient-bar">
        <div className="sms-recipient-bar__who">
          <span className="sms-recipient-bar__name">
            {lead?.name ?? 'Lead'}
            {lead?.dnc ? (
              <StatusPill tone="dnc" dot className="sms-recipient-bar__dnc">
                Do not contact
              </StatusPill>
            ) : null}
          </span>
          {contacts.length > 1 ? (
            <Select
              value={contact?.id ?? ''}
              onChange={(e) => setContactId(e.target.value)}
              aria-label="Recipient contact"
              className="sms-recipient-bar__select"
            >
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.phones[0]?.phone ? ` · ${formatPhone(c.phones[0].phone)}` : ' · no number'}
                </option>
              ))}
            </Select>
          ) : (
            <span className="sms-recipient-bar__num">
              {contact ? contact.name : 'No contact'}
              {toNumber ? (
                <span className="sms-recipient-bar__digits"> · {formatPhone(toNumber)}</span>
              ) : null}
            </span>
          )}
        </div>
      </div>

      <SmsThread
        messages={messages}
        now={evalNow}
        isLoading={threadQuery.isLoading}
        isError={threadQuery.isError}
        {...(threadError !== undefined ? { errorMessage: threadError } : {})}
        onRetry={() => void threadQuery.refetch()}
      />

      <SmsComposer
        leadId={leadId}
        lead={lead}
        contact={contact}
        messages={messages}
        now={evalNow}
        onSent={onSent}
        bodyRef={firstFieldRef}
      />
    </>
  );
}
