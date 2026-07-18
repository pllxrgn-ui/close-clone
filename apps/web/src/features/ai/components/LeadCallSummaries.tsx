import { useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Call } from '@switchboard/shared';
import { Button, EmptyState, ErrorState, Skeleton } from '../../../ui/index.ts';
import { ApiError } from '../../../api/errors.ts';
import { useAuth } from '../../../auth/AuthProvider.tsx';
import { useToast } from '../../../feedback/index.ts';
import { confirmCallSummary, generateCallSummary, listLeadCalls } from '../api/ai.ts';
import type { CallSummaryDraft } from '../api/ai.ts';
import { CheckIcon, NoteIcon, PhoneIcon, SparklesIcon } from '../icons.tsx';
import '../ai.css';

/*
 * The lead-page call-summary seam (§I-AI). For each recorded call with a transcript,
 * "Summarize" asks the AI for a DRAFT note (nothing final, no timeline event). The
 * rep reviews it and CONFIRMS — only then does it become final and land `note_added`
 * on the timeline, carrying `confirmedBy`. Without a signed-in user there is nobody
 * to record as the confirmer, so confirm is disabled.
 *
 * Lead-page seam (see routeWiring): mount on the lead detail page, e.g.
 *   <LeadCallSummaries leadId={leadId} />
 * It fetches its own data (GET /calls?leadId=) and invalidates the lead timeline on
 * confirm so the new note appears without a reload.
 */

const MAX_CALLS = 6;

export function LeadCallSummaries({ leadId }: { leadId: string }): JSX.Element {
  const callsQuery = useQuery({
    queryKey: ['ai-lead-calls', leadId],
    queryFn: ({ signal }) => listLeadCalls(leadId, signal),
  });

  return (
    <section className="ai-calls" aria-label="AI call summaries">
      <header className="ai-calls__head">
        <h2 className="ai-calls__title">
          <SparklesIcon size={14} /> Call summaries
        </h2>
      </header>
      <Body query={callsQuery} leadId={leadId} onRetry={() => void callsQuery.refetch()} />
    </section>
  );
}

function Body({
  query,
  leadId,
  onRetry,
}: {
  query: ReturnType<typeof useQuery<Call[]>>;
  leadId: string;
  onRetry: () => void;
}): JSX.Element {
  if (query.isPending) return <Skeleton height={72} />;
  if (query.isError) {
    return (
      <ErrorState
        title="Couldn’t load calls"
        description={query.error instanceof ApiError ? query.error.message : undefined}
        onRetry={onRetry}
      />
    );
  }
  const calls = query.data.slice(0, MAX_CALLS);
  if (calls.length === 0) {
    return (
      <EmptyState
        title="No recorded calls"
        description="Calls with a recording or transcript can be summarized by AI here."
      />
    );
  }
  return (
    <ul className="ai-calls__list">
      {calls.map((call) => (
        <li key={call.id} className="ai-call">
          <CallRow call={call} leadId={leadId} />
        </li>
      ))}
    </ul>
  );
}

function CallRow({ call, leadId }: { call: Call; leadId: string }): JSX.Element {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CallSummaryDraft | null>(null);
  const [finalized, setFinalized] = useState(false);

  const summarize = useMutation({
    mutationFn: () => generateCallSummary({ callId: call.id }),
    onSuccess: (result) => setDraft(result),
  });

  const confirm = useMutation({
    mutationFn: (noteId: string) => {
      if (!user) throw new ApiError('UNAUTHENTICATED', 'Sign in to confirm', 401);
      return confirmCallSummary(noteId, { confirmedBy: user.id });
    },
    onSuccess: () => {
      setFinalized(true);
      void queryClient.invalidateQueries({ queryKey: ['lead-timeline', leadId] });
      void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      toast('AI summary confirmed');
    },
  });

  const hasTranscript = call.transcriptRef !== null;

  return (
    <>
      <div className="ai-call__row">
        <span className="ai-call__meta">
          <span className="ai-call__dir">
            <PhoneIcon size={14} />
            {call.direction === 'inbound' ? 'Inbound call' : 'Outbound call'}
          </span>
          <span className="ai-call__when">{formatWhen(call.startedAt)}</span>
          {call.durationS !== null ? (
            <span className="ai-call__when">{formatDuration(call.durationS)}</span>
          ) : null}
        </span>
        {!draft && !finalized ? (
          <span className="ai-call__summarize">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => summarize.mutate()}
              loading={summarize.isPending}
              disabled={!hasTranscript}
              {...(!hasTranscript ? { title: 'No transcript yet' } : {})}
            >
              <SparklesIcon size={14} /> Summarize
            </Button>
          </span>
        ) : null}
      </div>

      {!hasTranscript && !draft && !finalized ? (
        <p className="ai-call__hint">No transcript yet — nothing to summarize.</p>
      ) : null}

      {summarize.isError ? (
        <p className="ai-draft__error" role="alert">
          {summarize.error instanceof ApiError
            ? summarize.error.message
            : 'Could not summarize the call.'}
        </p>
      ) : null}

      {draft && !finalized ? (
        <div className="ai-summary" aria-label="AI summary draft">
          <div className="ai-summary__head">
            <span className="ai-draftpill">
              <SparklesIcon size={12} /> AI draft
            </span>
          </div>
          <p className="ai-summary__body">{draft.summary}</p>
          {draft.actionItems.length > 0 ? (
            <ul className="ai-summary__items">
              {draft.actionItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          ) : null}
          <p className="ai-summary__note">Review before it lands on the timeline.</p>
          {confirm.isError ? (
            <p className="ai-draft__error" role="alert">
              {confirm.error instanceof ApiError
                ? confirm.error.message
                : 'Could not confirm the summary.'}
            </p>
          ) : null}
          {!user ? <p className="ai-summary__note">Sign in to confirm this summary.</p> : null}
          <div className="ai-summary__actions">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => confirm.mutate(draft.noteId)}
              loading={confirm.isPending}
              disabled={!user}
              {...(!user ? { title: 'Sign in to confirm' } : {})}
            >
              <CheckIcon size={14} /> Confirm &amp; add to timeline
            </Button>
          </div>
        </div>
      ) : null}

      {finalized && draft ? (
        <div className="ai-summary ai-summary--final" aria-label="AI summary added to timeline">
          <div className="ai-summary__head">
            <span className="ai-call__dir">
              <CheckIcon size={14} /> Added to the timeline
            </span>
            <NoteIcon size={14} />
          </div>
          <p className="ai-summary__body">{draft.summary}</p>
        </div>
      ) : null}
    </>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
