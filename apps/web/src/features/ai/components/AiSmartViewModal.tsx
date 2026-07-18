import { useRef, useState } from 'react';
import type { JSX, RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { BUILTIN_FIELD_NAMES, type Lead, type SmartViewFieldCatalog } from '@switchboard/shared';
import { Button, Field, Input, Spinner } from '../../../ui/index.ts';
import { Modal } from '../../../ui/Modal.tsx';
import { ApiError } from '../../../api/errors.ts';
import { createSmartView, previewSmartView } from '../../../api/smartViews.ts';
import { leadStatusesQuery, usersQuery } from '../../../api/refQueries.ts';
import { fetchSmartViewCatalog } from '../api/ai.ts';
import { requestNlSmartView, type NlSmartViewResult } from '../lib/nlToSmartView.ts';
import { AlertTriangleIcon, ArrowRightIcon, CloseIcon, SparklesIcon } from '../icons.tsx';
import '../ai.css';

/*
 * NL → Smart View (§7 / §I-AI). A natural-language box calls POST /ai/smart-view,
 * which returns DSL TEXT; the UI RE-PARSES that text with the SAME parser the builder
 * uses (lib/nlToSmartView), so the client is the authority — invalid DSL is a visible,
 * position-carrying error, never a silent guess. On a clean parse the compiled preview
 * (count-estimate + first rows) is shown, and the view is saved/run ONLY when the user
 * explicitly clicks Create — never auto-applied.
 *
 * Keyboard-summoned overlay → the plain Modal primitive is already 0ms (DESIGN §4).
 */

const EXAMPLES = ['leads with no touch in 2 weeks', 'won deals', 'do not contact leads'] as const;

export interface AiSmartViewModalProps {
  open: boolean;
  onClose: () => void;
}

export function AiSmartViewModal({ open, onClose }: AiSmartViewModalProps): JSX.Element {
  const inputRef = useRef<HTMLElement | null>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Ask AI for a Smart View"
      className="ai-nlv"
      backdropClassName="sb-overlay--center"
      initialFocusRef={inputRef}
    >
      <Body onClose={onClose} inputRef={inputRef} />
    </Modal>
  );
}

function Body({
  onClose,
  inputRef,
}: {
  onClose: () => void;
  inputRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<NlSmartViewResult | null>(null);
  const [name, setName] = useState('');

  const catalogQuery = useQuery({
    queryKey: ['ai-smartview-catalog'],
    queryFn: ({ signal }) => fetchSmartViewCatalog(signal),
    retry: false,
    staleTime: 60_000,
  });
  const catalog: SmartViewFieldCatalog = catalogQuery.data ?? {
    builtins: [...BUILTIN_FIELD_NAMES],
    custom: [],
  };

  const ask = useMutation({
    mutationFn: () => requestNlSmartView(query.trim(), catalog),
    onSuccess: (result) => {
      setOutcome(result);
      if (result.ok) setName(defaultName(query));
    },
  });

  function submit(): void {
    if (query.trim().length === 0) return;
    setOutcome(null);
    ask.mutate();
  }

  function useExample(example: string): void {
    setQuery(example);
    setOutcome(null);
    ask.reset();
    inputRef.current?.focus();
  }

  const askError =
    ask.error instanceof ApiError
      ? ask.error.message
      : ask.error
        ? 'The AI request failed. Try rephrasing.'
        : null;

  return (
    <>
      <header className="ai-nlv__head">
        <h2 className="ai-nlv__title">
          <span className="ai-nlv__title-accent">
            <SparklesIcon size={18} />
          </span>
          Ask AI for a Smart View
        </h2>
        <button type="button" className="ai-draft__close" aria-label="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </header>

      <div className="ai-nlv__body">
        <form
          className="ai-nlv__form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Describe the view in plain English">
            <Input
              ref={inputRef as RefObject<HTMLInputElement>}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. leads with no touch in 2 weeks"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            loading={ask.isPending}
            disabled={query.trim().length === 0}
          >
            <SparklesIcon size={14} /> Ask AI
          </Button>
        </form>

        <div className="ai-nlv__examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="ai-nlv__example"
              onClick={() => useExample(ex)}
            >
              {ex}
            </button>
          ))}
        </div>

        {askError ? (
          <p className="ai-draft__error" role="alert">
            {askError}
          </p>
        ) : null}

        {outcome && !outcome.ok ? <InvalidPanel outcome={outcome} /> : null}

        {outcome && outcome.ok ? <ReadyPanel dsl={outcome.dsl} ast={outcome.ast} /> : null}
      </div>

      <footer className="ai-nlv__foot">
        {outcome && outcome.ok ? (
          <SaveBar
            name={name}
            onName={setName}
            dsl={outcome.dsl}
            onCancel={onClose}
            onSaved={(id) => {
              void queryClient.invalidateQueries({ queryKey: ['smart-views'] });
              navigate(`/views/${id}`);
              onClose();
            }}
          />
        ) : (
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
      </footer>
    </>
  );
}

function InvalidPanel({
  outcome,
}: {
  outcome: Extract<NlSmartViewResult, { ok: false }>;
}): JSX.Element {
  return (
    <div className="ai-nlv__invalid" role="alert">
      <span className="ai-nlv__invalid-head">
        <AlertTriangleIcon size={16} /> The AI suggested invalid DSL
      </span>
      <p className="ai-nlv__invalid-msg">
        <code className="ai-nlv__invalid-code">{outcome.rawDsl}</code>
      </p>
      {/* The parse error message already carries the (line, col) position. */}
      <p className="ai-nlv__invalid-msg">{errorWithPosition(outcome.error, outcome.position)}</p>
      <p className="ai-summary__note">Rephrase your request — nothing is saved until it parses.</p>
    </div>
  );
}

function ReadyPanel({ dsl, ast }: { dsl: string; ast: unknown }): JSX.Element {
  const statusesQuery = useQuery(leadStatusesQuery());
  const usersRefQuery = useQuery(usersQuery());
  const preview = useQuery({
    queryKey: ['ai-nlv-preview', dsl],
    queryFn: () => previewSmartView({ ast, limit: 8 }),
    retry: false,
  });

  const statusLabels = new Map((statusesQuery.data ?? []).map((s) => [s.id, s.label]));
  const userNames = new Map((usersRefQuery.data ?? []).map((u) => [u.id, u.name]));

  return (
    <>
      <div className="ai-nlv__dsl">
        <span className="ai-nlv__dsl-label">Smart View DSL (re-parsed by the builder)</span>
        <code className="ai-nlv__dsl-code">{dsl}</code>
      </div>

      {preview.isError ? (
        <p className="ai-draft__error" role="alert">
          {preview.error instanceof ApiError ? preview.error.message : 'Preview failed.'}
        </p>
      ) : preview.isPending ? (
        <div className="ai-nlv__count">
          <Spinner label="Compiling preview" />
        </div>
      ) : (
        <>
          <p className="ai-nlv__count">
            <span className="ai-nlv__count-num">
              ≈{preview.data.countEstimate.toLocaleString()}
            </span>{' '}
            <span>leads</span>
          </p>
          {preview.data.items.length > 0 ? (
            <div className="ai-nlv__tablewrap">
              <table className="ai-nlv__table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Status</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Last contacted</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.data.items.slice(0, 8).map((lead: Lead) => (
                    <tr key={lead.id}>
                      <td>{lead.name}</td>
                      <td>{(lead.statusId && statusLabels.get(lead.statusId)) || '—'}</td>
                      <td>{(lead.ownerId && userNames.get(lead.ownerId)) || '—'}</td>
                      <td className="ai-nlv__num">{formatDate(lead.lastContactedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function SaveBar({
  name,
  onName,
  dsl,
  onCancel,
  onSaved,
}: {
  name: string;
  onName: (value: string) => void;
  dsl: string;
  onCancel: () => void;
  onSaved: (id: string) => void;
}): JSX.Element {
  const save = useMutation({
    mutationFn: () => createSmartView({ name: name.trim(), dsl }),
    onSuccess: (view) => onSaved(view.id),
  });

  return (
    <>
      <div className="ai-nlv__foot-name">
        <Field label="Name">
          <Input value={name} onChange={(e) => onName(e.target.value)} placeholder="View name" />
        </Field>
      </div>
      <div className="ai-nlv__foot-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={name.trim().length === 0}
        >
          <ArrowRightIcon size={14} /> Create Smart View
        </Button>
      </div>
    </>
  );
}

/** The parser message already carries (line, col); append only if it's missing. */
function errorWithPosition(message: string, position?: { line: number; col: number }): string {
  if (position && !/\(line \d+, col \d+\)/i.test(message)) {
    return `${message} (line ${position.line}, col ${position.col})`;
  }
  return message;
}

function defaultName(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, ' ');
  const capped = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
