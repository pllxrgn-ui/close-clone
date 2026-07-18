import { useMemo, useState } from 'react';
import type { JSX, KeyboardEvent, RefObject } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Contact, Lead, SmsMessage } from '@switchboard/shared';
import { Button, Kbd, Select, StatusPill, Textarea } from '../../../ui/index.ts';
import { ApiError } from '../../../api/index.ts';
import { useToast } from '../../../feedback/index.ts';
import { useAuth } from '../../../auth/AuthProvider.tsx';
import { COMPANY_TIMEZONE } from '../data/store.ts';
import { SMS_TEMPLATES } from '../data/templates.ts';
import { sendSms } from '../api/sms.ts';
import {
  DEFAULT_OPT_OUT_LANGUAGE,
  appendOptOutLanguage,
  bodyHasOptOutText,
  hasPriorOutbound,
  quietWindowState,
  smsSegments,
  threadIsOptedOut,
} from '../lib/sms.ts';
import {
  AlertTriangleIcon,
  BanIcon,
  ClockIcon,
  PhoneOffIcon,
  SendIcon,
  TemplateIcon,
} from '../icons.tsx';

/*
 * The compliance-gated SMS composer (drawer footer). Every §C6 rail that the engine
 * enforces at send time is ALSO surfaced here before Send, so the rep sees WHY a
 * text is blocked and Send is disabled with the reason — never a silent failure and
 * never an override prompt:
 *   - I-DNC / suppression: lead DNC, contact DNC, or an opted-out (STOP) number.
 *   - I-QUIET: outside 8am–9pm in the recipient's local time (area-code inferred).
 * The §4.5 first-contact opt-out sentence is shown appended before it is sent, and
 * the character/segment counter reflects the body that will actually go out. The
 * server re-checks every rail (I-RAIL-API); a blocked attempt surfaces its C8 code.
 */

interface Block {
  tone: 'dnc' | 'quiet';
  title: string;
  reason: string;
}

interface SmsComposerProps {
  leadId: string;
  lead: Lead | null;
  contact: Contact | null;
  messages: SmsMessage[];
  /** The instant quiet-hours + relative labels evaluate against (defaults to now). */
  now?: Date;
  onSent: () => void;
  bodyRef?: RefObject<HTMLElement | null>;
}

export function SmsComposer({
  leadId,
  lead,
  contact,
  messages,
  now,
  onSent,
  bodyRef,
}: SmsComposerProps): JSX.Element {
  const { toast } = useToast();
  const { user } = useAuth();
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState('');

  const evaluatedAt = now ?? new Date();
  const toNumber = contact?.phones[0]?.phone ?? null;
  const optedOut = useMemo(() => threadIsOptedOut(messages), [messages]);
  const quiet = useMemo(
    () => (toNumber ? quietWindowState(evaluatedAt, toNumber, COMPANY_TIMEZONE) : null),
    [toNumber, evaluatedAt],
  );

  // §4.5 first-contact opt-out language — shown appended before it is sent.
  const trimmed = body.trim();
  const willAppendOptOut =
    toNumber !== null &&
    trimmed !== '' &&
    !hasPriorOutbound(messages, toNumber) &&
    !bodyHasOptOutText(body);
  const previewBody = willAppendOptOut ? appendOptOutLanguage(body) : body;
  const seg = smsSegments(previewBody);

  const block: Block | null = useMemo(() => {
    if (lead?.dnc)
      return {
        tone: 'dnc',
        title: 'Do not contact',
        reason: 'This lead is marked do-not-contact — texting is blocked.',
      };
    if (contact?.dnc)
      return {
        tone: 'dnc',
        title: 'Do not contact',
        reason: 'This contact is marked do-not-contact — texting is blocked.',
      };
    if (optedOut)
      return {
        tone: 'dnc',
        title: 'Opted out',
        reason: 'This number replied STOP — it is suppressed and cannot be texted.',
      };
    if (quiet && !quiet.within) {
      return {
        tone: 'quiet',
        title: 'Outside sending window',
        reason: `Outside the 8am–9pm window in the recipient’s local time (${quiet.timeZone}). Texting is paused until it reopens.`,
      };
    }
    return null;
  }, [lead, contact, optedOut, quiet]);

  const sendMutation = useMutation({
    mutationFn: () =>
      sendSms({
        userId: user?.id ?? '',
        leadId,
        contactId: contact?.id ?? null,
        ...(toNumber ? { to: toNumber } : {}),
        body: trimmed,
      }),
    onSuccess: (result) => {
      setBody('');
      setTemplateId('');
      onSent();
      toast(result.optOutLanguageAppended ? 'Text sent · opt-out language added' : 'Text sent');
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Could not send text');
    },
  });

  const canSend =
    !block && toNumber !== null && trimmed !== '' && user !== null && !sendMutation.isPending;

  const hint = block
    ? block.reason
    : toNumber === null
      ? 'Add a phone number to this contact to text.'
      : trimmed === ''
        ? 'Write a message to send.'
        : null;

  function applyTemplate(id: string): void {
    setTemplateId(id);
    const tmpl = SMS_TEMPLATES.find((t) => t.id === id);
    if (tmpl) setBody(tmpl.body);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSend) sendMutation.mutate();
    }
  }

  return (
    <footer className="sms-composer">
      {block ? (
        <div className={`sms-rail sms-rail--${block.tone}`} role="alert">
          {block.tone === 'dnc' ? (
            optedOut ? (
              <PhoneOffIcon size={16} />
            ) : (
              <BanIcon size={16} />
            )
          ) : (
            <AlertTriangleIcon size={16} />
          )}
          <div className="sms-rail__text">
            {block.tone === 'dnc' ? (
              <StatusPill tone="dnc" dot>
                {block.title}
              </StatusPill>
            ) : (
              <span className="sms-rail__label">{block.title}</span>
            )}
            <p className="sms-rail__reason">{block.reason}</p>
          </div>
        </div>
      ) : null}

      <label className="sms-field sms-field--template">
        <span className="sms-field__label">
          <TemplateIcon size={13} /> Template
        </span>
        <Select
          value={templateId}
          onChange={(e) => applyTemplate(e.target.value)}
          aria-label="SMS template"
        >
          <option value="">Start from scratch…</option>
          {SMS_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </label>

      <div className="sms-composer__input">
        <Textarea
          ref={bodyRef as RefObject<HTMLTextAreaElement>}
          className="sms-composer__textarea"
          value={body}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Write a text…"
          aria-label="Message body"
          spellCheck
          disabled={block?.tone === 'dnc'}
        />
        {willAppendOptOut ? (
          <p className="sms-composer__optout" aria-live="polite">
            <span className="sms-composer__optout-tag">Auto-appended</span>
            <span className="sms-composer__optout-text">{DEFAULT_OPT_OUT_LANGUAGE}</span>
          </p>
        ) : null}
      </div>

      <div className="sms-composer__foot">
        <div className="sms-composer__meta">
          <span className={seg.segments > 1 ? 'sms-count sms-count--multi' : 'sms-count'}>
            {seg.units} {seg.units === 1 ? 'char' : 'chars'}
            {seg.segments > 0 ? ` · ${seg.segments} SMS` : ''}
            {seg.encoding === 'ucs2' ? ' · Unicode' : ''}
          </span>
          {quiet ? (
            <span className={quiet.within ? 'sms-window' : 'sms-window sms-window--closed'}>
              <ClockIcon size={12} /> {quiet.within ? 'Window open' : 'Window closed'} ·{' '}
              {quiet.timeZone.split('/').pop()?.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
        <div className="sms-composer__actions">
          <Button
            variant="primary"
            onClick={() => sendMutation.mutate()}
            disabled={!canSend}
            loading={sendMutation.isPending}
            {...(hint ? { title: hint } : {})}
          >
            <SendIcon size={14} /> Send
          </Button>
        </div>
      </div>

      <span className="sms-composer__hint" aria-live="polite">
        {hint ?? (
          <>
            Press <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> to send
          </>
        )}
      </span>
    </footer>
  );
}
