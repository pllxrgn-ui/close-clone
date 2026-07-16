/*
 * Raw DSL editor (CONTRACTS §C3). Parses on every change with the same parser
 * the builder uses, so the two never diverge. A parse failure is shown with its
 * position — the offending source line plus a caret at (line, col) — and Apply
 * is enabled only on a clean parse, at which point the AST is lifted up and the
 * visual builder rehydrates from it.
 */
import { useId, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { Ast, DslCustomFieldDef, Position } from '@switchboard/shared';
import { ParseError, parse } from '@switchboard/shared';
import { Button, Textarea } from '../../ui/index.ts';
import { AlertIcon, CheckIcon } from './icons.tsx';

interface ParseState {
  ast: Ast | null;
  error: { message: string; position: Position } | null;
}

function parseState(text: string, fieldCatalog: readonly DslCustomFieldDef[]): ParseState {
  try {
    return { ast: parse(text, { fieldCatalog }), error: null };
  } catch (err) {
    if (err instanceof ParseError) {
      // Strip the trailing "(line X, col Y)" the message already carries; the
      // caret renders the position visually.
      const message = err.message.replace(/\s*\(line \d+, col \d+\)\s*$/, '');
      return { ast: null, error: { message, position: err.position } };
    }
    throw err;
  }
}

export function RawDslPanel({
  initialDsl,
  fieldCatalog,
  onApply,
}: {
  initialDsl: string;
  fieldCatalog: readonly DslCustomFieldDef[];
  onApply: (ast: Ast) => void;
}): JSX.Element {
  const [text, setText] = useState(initialDsl);
  const errorId = useId();
  const state = useMemo(() => parseState(text, fieldCatalog), [text, fieldCatalog]);
  const dirty = text !== initialDsl;

  return (
    <div className="sb-vb-dsl">
      <div className="sb-vb-dsl__bar">
        <label htmlFor={`${errorId}-ta`} className="sb-vb-dsl__label">
          Query DSL
        </label>
        <Button
          size="sm"
          variant="primary"
          disabled={state.ast === null || !dirty}
          onClick={() => {
            if (state.ast !== null) onApply(state.ast);
          }}
        >
          Apply to builder
        </Button>
      </div>

      <Textarea
        id={`${errorId}-ta`}
        className="sb-vb-dsl__input"
        aria-label="Smart View DSL"
        invalid={state.error !== null}
        aria-describedby={state.error ? errorId : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {state.error ? (
        <div id={errorId} className="sb-vb-dsl__error" role="alert">
          <span className="sb-vb-dsl__error-head">
            <AlertIcon size={14} />
            <span>
              Line {state.error.position.line}, column {state.error.position.col}:{' '}
              {state.error.message}
            </span>
          </span>
          <ErrorCaret text={text} position={state.error.position} />
        </div>
      ) : (
        <p className="sb-vb-dsl__ok">
          <CheckIcon size={14} /> Parses cleanly
          {dirty ? '' : ' · in sync with the builder'}
        </p>
      )}
    </div>
  );
}

/** Render the offending source line with a caret under the error column. */
function ErrorCaret({ text, position }: { text: string; position: Position }): JSX.Element {
  const lines = text.split('\n');
  const lineText = lines[position.line - 1] ?? '';
  const caret = `${' '.repeat(Math.max(0, position.col - 1))}^`;
  return (
    <pre className="sb-vb-dsl__caret" aria-hidden="true">
      {lineText}
      {'\n'}
      {caret}
    </pre>
  );
}
