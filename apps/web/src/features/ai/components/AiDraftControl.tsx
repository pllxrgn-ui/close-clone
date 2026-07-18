import { useState } from 'react';
import type { JSX } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { EmailDraft, EmailThreadContext } from '@switchboard/shared';
import { Button, Field, Textarea } from '../../../ui/index.ts';
import { ApiError } from '../../../api/errors.ts';
import { draftEmailWithAi } from '../api/ai.ts';
import { SparklesIcon, RewriteIcon, CheckIcon, CloseIcon } from '../icons.tsx';
import '../ai.css';

/*
 * The AI draft/rewrite affordance for the email composer (§I-AI). It fills the
 * composer through `onApply`; it has NO send capability — the human presses Send.
 * A generated draft is ALWAYS shown for review first; nothing is inserted until the
 * rep clicks Insert.
 *
 * Composer seam: mounted inside features/comms Composer's ComposeForm as a
 * full-width block under the Message field (NOT in the footer — the panel needs
 * room). Feed it the RENDERED subject/body — renderMergeTemplate(subject, ctx) —
 * so the AI sees what the rep sees and drafts come back tag-free:
 *   <AiDraftControl subject={rendered.subject} body={rendered.body} onApply={(d) => {
 *     if (d.subject !== undefined) setSubject(d.subject);
 *     setBody(d.body);
 *   }} />
 */

export interface AiDraftControlProps {
  /** The composer's current subject (context for rewrite / Re: subject). */
  subject: string;
  /** The composer's current body — non-empty enables Rewrite. */
  body: string;
  /** Apply the AI draft into the composer. The human still sends (§I-AI). */
  onApply: (draft: { subject?: string; body: string }) => void;
  /** Disable the affordance (e.g. while the composer is still loading). */
  disabled?: boolean;
}

type Mode = 'draft' | 'rewrite';

const REWRITE_DEFAULT = 'Make it clearer and a little warmer, and tighten it up.';

export function AiDraftControl({
  subject,
  body,
  onApply,
  disabled = false,
}: AiDraftControlProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('draft');
  const [instruction, setInstruction] = useState('');
  const [draft, setDraft] = useState<EmailDraft | null>(null);

  const hasBody = body.trim().length > 0;

  const mutation = useMutation({
    mutationFn: (): Promise<EmailDraft> => {
      const recentMessages: EmailThreadContext['recentMessages'] =
        mode === 'rewrite' && hasBody ? [{ from: 'You (current draft)', body }] : [];
      const threadCtx: EmailThreadContext = {
        ...(subject.trim().length > 0 ? { subject: subject.trim() } : {}),
        recentMessages,
      };
      return draftEmailWithAi({ instruction: instruction.trim(), threadCtx });
    },
    onSuccess: (result) => setDraft(result),
  });

  function openPanel(next: Mode): void {
    setMode(next);
    setInstruction(next === 'rewrite' ? REWRITE_DEFAULT : '');
    setDraft(null);
    mutation.reset();
    setOpen(true);
  }

  function close(): void {
    setOpen(false);
    setDraft(null);
    mutation.reset();
  }

  function apply(): void {
    if (!draft) return;
    onApply({
      ...(draft.subject !== undefined ? { subject: draft.subject } : {}),
      body: draft.body,
    });
    close();
  }

  if (!open) {
    return (
      <div className="ai-draft__triggers">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => openPanel('draft')}
          disabled={disabled}
        >
          <SparklesIcon size={14} /> Draft with AI
        </Button>
        {hasBody ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openPanel('rewrite')}
            disabled={disabled}
          >
            <RewriteIcon size={14} /> Rewrite
          </Button>
        ) : null}
      </div>
    );
  }

  const errorMessage =
    mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? 'Could not draft the email.'
        : null;

  return (
    <section className="ai-draft__panel" aria-label="AI email assistant">
      <header className="ai-draft__panel-head">
        <span className="ai-draft__panel-title">
          <SparklesIcon size={14} /> {mode === 'rewrite' ? 'Rewrite with AI' : 'Draft with AI'}
        </span>
        <button
          type="button"
          className="ai-draft__close"
          aria-label="Close AI assistant"
          onClick={close}
        >
          <CloseIcon size={14} />
        </button>
      </header>

      {draft === null ? (
        <>
          <Field
            label={
              mode === 'rewrite' ? 'How should the AI rewrite it?' : 'What should the AI write?'
            }
            hint={
              mode === 'rewrite'
                ? 'It rewrites your current draft — you review the result.'
                : 'Describe the email; the AI drafts it for you to review and send.'
            }
          >
            <Textarea
              value={instruction}
              rows={3}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={
                mode === 'rewrite'
                  ? 'e.g. make it shorter and more direct'
                  : 'e.g. friendly first-touch intro about saving reps time'
              }
              spellCheck
            />
          </Field>
          {errorMessage ? (
            <p className="ai-draft__error" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <div className="ai-draft__actions">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => mutation.mutate()}
              loading={mutation.isPending}
              disabled={instruction.trim().length === 0}
            >
              <SparklesIcon size={14} /> Generate draft
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="ai-draft__preview" aria-label="AI draft preview">
            {draft.subject !== undefined ? (
              <div className="ai-draft__preview-subject">
                <span className="ai-draft__preview-label">Subject</span>
                <span className="ai-draft__preview-subject-text">{draft.subject}</span>
              </div>
            ) : null}
            <div className="ai-draft__preview-body">{draft.body}</div>
          </div>
          <p className="ai-draft__note">You review and send — the AI never sends for you.</p>
          <div className="ai-draft__actions">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Discard
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => mutation.mutate()}
              loading={mutation.isPending}
            >
              <RewriteIcon size={14} /> Regenerate
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={apply}>
              <CheckIcon size={14} /> Insert into email
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
