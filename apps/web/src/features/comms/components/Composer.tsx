import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent, RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Contact } from '@switchboard/shared';
import { Modal } from '../../../ui/Modal.tsx';
import {
  Button,
  EmptyState,
  IconButton,
  Input,
  Select,
  Spinner,
  StatusPill,
  Textarea,
} from '../../../ui/index.ts';
import { ApiError } from '../../../api/index.ts';
import { getLead } from '../../../api/leads.ts';
import { listUsers } from '../../../api/reference.ts';
import { search } from '../../../api/search.ts';
import { useToast } from '../../../feedback/index.ts';
import { useDebouncedValue } from '../../../command/index.ts';
import {
  listLeadContacts,
  listSnippets,
  listSuppressedRecipients,
  listTemplates,
  sendEmail,
} from '../api/comms.ts';
import {
  buildMergeContext,
  parseMergeTemplate,
  primaryEmail,
  renderMergeTemplate,
  unresolvedKeys,
} from '../lib/mergeTags.ts';
import { applySnippet, detectSlashToken, matchSnippets } from '../lib/snippets.ts';
import { MergePreview } from './MergePreview.tsx';
import { SnippetMenu } from './SnippetMenu.tsx';
import {
  AlertTriangleIcon,
  BanIcon,
  CloseIcon,
  MailIcon,
  SearchIcon,
  SendIcon,
  TemplateIcon,
} from '../icons.tsx';

export interface ComposerProps {
  open: boolean;
  onClose: () => void;
  /** When set the composer opens straight to the compose step for this lead. */
  leadId?: string | null;
  /** Keyboard-opened (palette) → no entrance animation, per the motion law. */
  instant?: boolean;
}

/** Blocked-recipient reasons — the compliance rail, surfaced before Send. */
interface Block {
  tone: 'dnc';
  reason: string;
}

/**
 * The email composer drawer. Origin-aware (slides in from the seam; instant when
 * summoned by keyboard). Reuses the Modal primitive for portal + focus-trap +
 * focus-restore. Renders merge tags live, gates Send on unresolved tags AND the
 * DNC/suppression rail, and supports `/shortcut` snippet insertion in the body.
 */
export function Composer({
  open,
  onClose,
  leadId = null,
  instant = false,
}: ComposerProps): JSX.Element {
  const initialFocusRef = useRef<HTMLElement | null>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      label="New email"
      initialFocusRef={initialFocusRef}
      className={instant ? 'comms-drawer comms-drawer--instant' : 'comms-drawer'}
      backdropClassName="comms-drawer-overlay"
    >
      <ComposerBody
        key={leadId ?? 'no-lead'}
        onClose={onClose}
        leadId={leadId}
        firstFieldRef={initialFocusRef}
      />
    </Modal>
  );
}

function ComposerBody({
  onClose,
  leadId,
  firstFieldRef,
}: {
  onClose: () => void;
  leadId: string | null;
  firstFieldRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const [pickedLeadId, setPickedLeadId] = useState<string | null>(null);
  const effectiveLeadId = leadId ?? pickedLeadId;

  if (!effectiveLeadId) {
    return <LeadPicker onPick={setPickedLeadId} searchRef={firstFieldRef} onClose={onClose} />;
  }
  return <ComposeForm leadId={effectiveLeadId} firstFieldRef={firstFieldRef} onClose={onClose} />;
}

// ── Step 1 (palette entry only): pick the lead to email ──────────────────────

function LeadPicker({
  onPick,
  searchRef,
  onClose,
}: {
  onPick: (leadId: string) => void;
  searchRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 150);
  const trimmed = debounced.trim();
  const { data, isFetching } = useQuery({
    queryKey: ['comms-lead-search', trimmed],
    queryFn: ({ signal }) => search(trimmed, signal),
    enabled: trimmed.length > 0,
    staleTime: 15_000,
  });
  const leads = (data?.items ?? []).filter((hit) => hit.type === 'lead').slice(0, 8);

  return (
    <div className="comms-drawer__inner">
      <header className="comms-drawer__head">
        <h2 className="comms-drawer__title">
          <MailIcon size={16} /> New email
        </h2>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </header>
      <div className="comms-drawer__scroll">
        <label className="comms-field">
          <span className="comms-field__label">Lead</span>
          <span className="comms-search">
            <SearchIcon size={14} className="comms-search__icon" />
            <Input
              ref={searchRef as RefObject<HTMLInputElement>}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search leads to email…"
              aria-label="Search leads"
              autoComplete="off"
              spellCheck={false}
            />
          </span>
        </label>
        {trimmed.length === 0 ? (
          <p className="comms-hint">Search for the lead you want to email.</p>
        ) : leads.length === 0 && !isFetching ? (
          <p className="comms-hint">No leads match “{trimmed}”.</p>
        ) : (
          <ul className="comms-picklist" aria-label="Lead results">
            {leads.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className="sb-row comms-picklist__row"
                  onClick={() => onPick(hit.leadId)}
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
      </div>
    </div>
  );
}

// ── Step 2: compose ──────────────────────────────────────────────────────────

function ComposeForm({
  leadId,
  firstFieldRef,
  onClose,
}: {
  leadId: string;
  firstFieldRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const leadQuery = useQuery({ queryKey: ['lead', leadId], queryFn: () => getLead(leadId) });
  const contactsQuery = useQuery({
    queryKey: ['lead-contacts', leadId],
    queryFn: () => listLeadContacts(leadId),
  });
  const usersQuery = useQuery({ queryKey: ['ref', 'users'], queryFn: () => listUsers() });
  const templatesQuery = useQuery({
    queryKey: ['comms', 'templates'],
    queryFn: () => listTemplates(),
  });
  const snippetsQuery = useQuery({
    queryKey: ['comms', 'snippets'],
    queryFn: () => listSnippets(),
  });
  const suppressedQuery = useQuery({
    queryKey: ['comms', 'suppressed', leadId],
    queryFn: () => listSuppressedRecipients(leadId),
  });

  const contacts = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);
  const [contactId, setContactId] = useState<string | null>(null);
  const selectedContact: Contact | null = useMemo(
    () => contacts.find((c) => c.id === contactId) ?? contacts[0] ?? null,
    [contacts, contactId],
  );

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState('');

  // Snippet autocomplete state.
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [snipToken, setSnipToken] = useState<ReturnType<typeof detectSlashToken>>(null);
  const [snipActive, setSnipActive] = useState(0);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const snipId = useId();

  const owner = useMemo(() => {
    const ownerId = leadQuery.data?.ownerId ?? null;
    return (usersQuery.data ?? []).find((u) => u.id === ownerId) ?? null;
  }, [leadQuery.data, usersQuery.data]);

  const ctx = useMemo(
    () => buildMergeContext({ lead: leadQuery.data, contact: selectedContact, owner }),
    [leadQuery.data, selectedContact, owner],
  );

  const snippets = snippetsQuery.data ?? [];
  const snipMatches = useMemo(
    () => (snipToken ? matchSnippets(snipToken.query, snippets) : []),
    [snipToken, snippets],
  );
  const snipOpen = snipToken !== null && snipMatches.length > 0;

  // Apply a deferred caret position after a snippet insertion re-renders.
  useEffect(() => {
    if (pendingCaret === null) return;
    const el = bodyRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pendingCaret, pendingCaret);
    }
    setPendingCaret(null);
  }, [pendingCaret]);

  const recipientEmail = primaryEmail(selectedContact);
  const suppressed = useMemo(
    () => new Set((suppressedQuery.data?.emails ?? []).map((e) => e.toLowerCase())),
    [suppressedQuery.data],
  );

  const block: Block | null = useMemo(() => {
    if (leadQuery.data?.dnc) {
      return { tone: 'dnc', reason: 'This lead is marked do-not-contact — outreach is blocked.' };
    }
    if (selectedContact?.dnc) {
      return {
        tone: 'dnc',
        reason: 'This contact is marked do-not-contact — outreach is blocked.',
      };
    }
    if (recipientEmail && suppressed.has(recipientEmail.toLowerCase())) {
      return {
        tone: 'dnc',
        reason: 'This address is suppressed (unsubscribed or bounced) — outreach is blocked.',
      };
    }
    return null;
  }, [leadQuery.data, selectedContact, recipientEmail, suppressed]);

  const subjectSegments = useMemo(() => parseMergeTemplate(subject, ctx), [subject, ctx]);
  const bodySegments = useMemo(() => parseMergeTemplate(body, ctx), [body, ctx]);
  const unresolved = useMemo(
    () => [...new Set([...unresolvedKeys(subjectSegments), ...unresolvedKeys(bodySegments)])],
    [subjectSegments, bodySegments],
  );
  const anyUnresolved = unresolved.length > 0;

  const sendMutation = useMutation({
    mutationFn: () =>
      sendEmail({
        leadId,
        contactId: selectedContact?.id ?? null,
        to: recipientEmail ? [recipientEmail] : [],
        subject: renderMergeTemplate(subject, ctx),
        body: renderMergeTemplate(body, ctx),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      toast(`Email sent to ${recipientEmail}`);
      onClose();
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Could not send email');
    },
  });

  const noContacts = !contactsQuery.isLoading && contacts.length === 0;
  const canSend =
    !block &&
    !!recipientEmail &&
    subject.trim() !== '' &&
    body.trim() !== '' &&
    !anyUnresolved &&
    !sendMutation.isPending;

  const sendHint = block
    ? block.reason
    : !recipientEmail
      ? 'Add a contact email to send.'
      : subject.trim() === ''
        ? 'Add a subject to send.'
        : body.trim() === ''
          ? 'Write a message to send.'
          : anyUnresolved
            ? `Resolve ${unresolved.length} merge tag${unresolved.length === 1 ? '' : 's'} to send.`
            : null;

  function applyTemplate(id: string): void {
    setTemplateId(id);
    const tmpl = (templatesQuery.data ?? []).find((t) => t.id === id);
    if (!tmpl) return;
    setSubject(tmpl.subject ?? '');
    setBody(tmpl.body);
    setSnipToken(null);
  }

  function onBodyChange(value: string, caret: number): void {
    setBody(value);
    const token = detectSlashToken(value, caret);
    setSnipToken(token && matchSnippets(token.query, snippets).length > 0 ? token : null);
    setSnipActive(0);
  }

  function insertSnippet(index: number): void {
    if (!snipToken) return;
    const snippet = snipMatches[index];
    if (!snippet) return;
    const result = applySnippet(body, snipToken, snippet.body);
    setBody(result.text);
    setSnipToken(null);
    setPendingCaret(result.caret);
  }

  function onBodyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!snipOpen) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSnipActive((i) => Math.min(i + 1, snipMatches.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSnipActive((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        insertSnippet(snipActive);
        break;
      case 'Escape':
        // Swallow so the drawer stays open; just dismiss the menu.
        event.preventDefault();
        event.stopPropagation();
        setSnipToken(null);
        break;
      default:
        break;
    }
  }

  const isLoading = leadQuery.isLoading || contactsQuery.isLoading;

  return (
    <div className="comms-drawer__inner">
      <header className="comms-drawer__head">
        <h2 className="comms-drawer__title">
          <MailIcon size={16} />
          New email
          {leadQuery.data ? (
            <span className="comms-drawer__subject-of"> · {leadQuery.data.name}</span>
          ) : null}
        </h2>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </header>

      <div className="comms-drawer__scroll">
        {isLoading ? (
          <div className="comms-drawer__loading" role="status">
            <Spinner label="Loading composer" />
          </div>
        ) : noContacts ? (
          <EmptyState
            title="No contacts on this lead"
            description="Add a contact with an email address before composing."
          />
        ) : (
          <>
            {/* Recipient */}
            <label className="comms-field">
              <span className="comms-field__label">To</span>
              {contacts.length > 1 ? (
                <Select
                  value={selectedContact?.id ?? ''}
                  onChange={(e) => setContactId(e.target.value)}
                  aria-label="Recipient contact"
                >
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {primaryEmail(c) || 'no email'}
                    </option>
                  ))}
                </Select>
              ) : (
                <output className="comms-recipient">
                  {selectedContact?.name}
                  {recipientEmail ? (
                    <span className="comms-recipient__email"> · {recipientEmail}</span>
                  ) : null}
                </output>
              )}
            </label>

            {/* Compliance rail */}
            {block ? (
              <div className="comms-rail comms-rail--dnc" role="alert">
                <BanIcon size={16} />
                <div>
                  <StatusPill tone="dnc" dot>
                    Do not contact
                  </StatusPill>
                  <p className="comms-rail__reason">{block.reason}</p>
                </div>
              </div>
            ) : null}

            {/* Template picker */}
            <label className="comms-field">
              <span className="comms-field__label">
                <TemplateIcon size={13} /> Template
              </span>
              <Select
                value={templateId}
                onChange={(e) => applyTemplate(e.target.value)}
                aria-label="Template"
              >
                <option value="">Start from scratch…</option>
                {(templatesQuery.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </label>

            {/* Subject */}
            <label className="comms-field">
              <span className="comms-field__label">Subject</span>
              <Input
                ref={firstFieldRef as RefObject<HTMLInputElement>}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject line — merge tags like {{lead.name}} allowed"
                aria-label="Subject"
              />
            </label>

            {/* Body + snippet autocomplete */}
            <label className="comms-field comms-field--body">
              <span className="comms-field__label">
                Message
                <span className="comms-field__hint">
                  type <code>/</code> for snippets
                </span>
              </span>
              <div className="comms-body">
                <Textarea
                  ref={bodyRef}
                  className="comms-textarea"
                  value={body}
                  rows={9}
                  onChange={(e) =>
                    onBodyChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
                  }
                  onKeyDown={onBodyKeyDown}
                  placeholder="Write your message…"
                  aria-label="Message body"
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  aria-controls={snipOpen ? `${snipId}-listbox` : undefined}
                  aria-activedescendant={snipOpen ? `${snipId}-opt-${snipActive}` : undefined}
                  spellCheck
                />
                {snipOpen ? (
                  <SnippetMenu
                    snippets={snipMatches}
                    activeIndex={snipActive}
                    listboxId={`${snipId}-listbox`}
                    optionId={(i) => `${snipId}-opt-${i}`}
                    onPick={(snippet) => insertSnippet(snipMatches.indexOf(snippet))}
                    onHover={setSnipActive}
                  />
                ) : null}
              </div>
            </label>

            {/* Live merge preview */}
            <section className="comms-previewbox" aria-label="Preview">
              <div className="comms-previewbox__head">
                <span className="comms-field__label">Preview</span>
                {anyUnresolved ? (
                  <span className="comms-previewbox__warn">
                    <AlertTriangleIcon size={13} />
                    {unresolved.length} unresolved: {unresolved.map((k) => `{{${k}}}`).join(', ')}
                  </span>
                ) : null}
              </div>
              <div className="comms-previewbox__subject">
                <MergePreview segments={subjectSegments} />
              </div>
              <MergePreview segments={bodySegments} className="comms-previewbox__body" />
            </section>
          </>
        )}
      </div>

      <footer className="comms-drawer__foot">
        {sendHint ? (
          <span className="comms-drawer__foot-hint" aria-live="polite">
            {sendHint}
          </span>
        ) : (
          <span className="comms-drawer__foot-hint comms-drawer__foot-hint--ok" aria-live="polite">
            Ready to send to {recipientEmail}
          </span>
        )}
        <div className="comms-drawer__foot-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => sendMutation.mutate()}
            disabled={!canSend}
            loading={sendMutation.isPending}
            {...(sendHint ? { title: sendHint } : {})}
          >
            <SendIcon size={14} /> Send
          </Button>
        </div>
      </footer>
    </div>
  );
}
