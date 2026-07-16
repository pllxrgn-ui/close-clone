import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { Modal } from '../../../ui/Modal.tsx';
import { Button, Input, Kbd } from '../../../ui/index.ts';
import { IS_MAC } from '../../../keyboard/index.ts';
import type { ReplyItem } from '../model/types.ts';
import { MailIcon, MessageIcon, SendIcon, XIcon } from '../icons.tsx';

/*
 * Minimal reply composer, rendered as a right-side drawer over the shared Modal
 * primitive (portal + focus trap + Escape + focus restore). It is keyboard-
 * summoned (R), so — like the palette and cheat sheet — it opens instantly (0ms),
 * per the motion law. To/subject are prefilled; ⌘/Ctrl+Enter sends. The parent
 * owns the send mutation and closes the drawer on success.
 */

export interface ComposerSendPayload {
  subject: string | null;
  body: string;
}

interface ComposerDrawerProps {
  /** The reply being composed, or null when the drawer is closed. */
  item: ReplyItem | null;
  sending: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSend: (payload: ComposerSendPayload) => void;
}

function prefillSubject(item: ReplyItem): string {
  if (item.channel !== 'email' || !item.subject) return '';
  return /^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`;
}

export function ComposerDrawer({
  item,
  sending,
  errorMessage,
  onClose,
  onSend,
}: ComposerDrawerProps): JSX.Element | null {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const ids = useId();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const itemId = item?.id;

  // Re-prefill only when a different reply opens (keyed on the item id, not the
  // object identity), so typing into the body is never clobbered by a re-render.
  useEffect(() => {
    if (item) {
      setSubject(prefillSubject(item));
      setBody('');
    }
  }, [itemId]);

  if (!item) return null;

  const isEmail = item.channel === 'email';
  const canSend = body.trim().length > 0 && !sending;

  function submit(): void {
    if (!item || body.trim().length === 0 || sending) return;
    onSend({ subject: isEmail ? subject : null, body });
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  const subjectId = `${ids}-subject`;
  const bodyId = `${ids}-body`;
  const toId = `${ids}-to`;

  return (
    <Modal
      open
      onClose={onClose}
      label={`Reply to ${item.leadName}`}
      initialFocusRef={bodyRef}
      className="sb-inbox-drawer"
      backdropClassName="sb-inbox-drawer__scrim"
    >
      <form
        className="sb-inbox-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={onKeyDown}
      >
        <header className="sb-inbox-composer__head">
          <div className="sb-inbox-composer__title">
            <span className="sb-inbox-composer__chan" aria-hidden="true">
              {isEmail ? <MailIcon size={15} /> : <MessageIcon size={15} />}
            </span>
            <span className="sb-inbox-composer__title-text">
              Reply <span className="sb-inbox-composer__lead">{item.leadName}</span>
            </span>
          </div>
          <button
            type="button"
            className="sb-iconbtn sb-iconbtn--sm"
            onClick={onClose}
            aria-label="Close composer"
          >
            <XIcon size={16} />
          </button>
        </header>

        <div className="sb-inbox-composer__fields">
          <div className="sb-inbox-composer__field">
            <span className="sb-inbox-composer__label" id={toId}>
              To
            </span>
            <span className="sb-inbox-composer__to" aria-labelledby={toId}>
              {item.contactName} · {item.toAddress}
            </span>
          </div>

          {isEmail ? (
            <div className="sb-inbox-composer__field">
              <label className="sb-inbox-composer__label" htmlFor={subjectId}>
                Subject
              </label>
              <Input
                id={subjectId}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                autoComplete="off"
              />
            </div>
          ) : null}

          <div className="sb-inbox-composer__field sb-inbox-composer__field--grow">
            <label className="sb-inbox-composer__label" htmlFor={bodyId}>
              Message
            </label>
            <textarea
              id={bodyId}
              ref={bodyRef}
              className="sb-inbox-composer__body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={`Write your reply to ${item.contactName}…`}
              spellCheck
            />
          </div>

          {errorMessage ? (
            <p className="sb-inbox-composer__error" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </div>

        <footer className="sb-inbox-composer__foot">
          <span className="sb-inbox-composer__hint" aria-hidden="true">
            <Kbd>{IS_MAC ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>Enter</Kbd>
            to send
          </span>
          <div className="sb-inbox-composer__foot-actions">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={sending} disabled={!canSend}>
              <SendIcon size={14} /> Send
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
