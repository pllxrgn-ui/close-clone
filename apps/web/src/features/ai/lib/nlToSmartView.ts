import {
  parse,
  ParseError,
  type Ast,
  type DslCustomFieldDef,
  type Position,
  type SmartViewFieldCatalog,
} from '@switchboard/shared';
import { ApiError } from '../../../api/errors.ts';
import { nlToSmartView } from '../api/ai.ts';

/*
 * NL → Smart View, client side (§7 / §I-AI). The AI route returns DSL TEXT; this
 * module RE-PARSES that text with the SAME `parse()` the Smart View builder uses for
 * hand-typed queries, gated by the SAME field catalog. That makes the client parser
 * the authority: an invalid suggestion becomes a visible, position-carrying error —
 * never a silent guess, and never a saved view. The AST returned is the one the
 * CLIENT parsed (not the server payload), so preview + save consume a value the UI
 * itself validated.
 */

export interface NlSmartViewOk {
  ok: true;
  /** The AI's DSL text that parsed cleanly. */
  dsl: string;
  /** The AST the client parser produced from {@link dsl} (the authority). */
  ast: Ast;
}

export interface NlSmartViewInvalid {
  ok: false;
  /** The raw DSL the model produced (shown so the error is never a silent guess). */
  rawDsl: string;
  /** Human-readable parse error. */
  error: string;
  /** Source position of the error, when known. */
  position?: Position;
}

export type NlSmartViewResult = NlSmartViewOk | NlSmartViewInvalid;

/** Map the feature's field catalog to the parser's lead-entity custom-field defs. */
export function toParserCatalog(catalog: SmartViewFieldCatalog): DslCustomFieldDef[] {
  return catalog.custom.map((c) => ({ key: c.key, entity: 'lead', type: c.type }));
}

interface InvalidDslDetails {
  rawDsl: string;
  parseError?: string;
  position?: Position;
}

function readInvalidDetails(details: unknown): InvalidDslDetails | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as Record<string, unknown>;
  if (typeof record.rawDsl !== 'string') return null;
  const out: InvalidDslDetails = { rawDsl: record.rawDsl };
  if (typeof record.parseError === 'string') out.parseError = record.parseError;
  if (isPosition(record.position)) out.position = record.position;
  return out;
}

function isPosition(value: unknown): value is Position {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.line === 'number' &&
    typeof record.col === 'number' &&
    typeof record.offset === 'number'
  );
}

/**
 * Ask the AI for a Smart View, then re-parse its DSL as the authority.
 *
 * - success → the client-parsed AST (never the server's payload);
 * - the server's `VALIDATION_FAILED` (AI emitted invalid DSL) → a visible invalid
 *   result carrying the raw DSL + message + position;
 * - a server "success" whose DSL the client parser rejects → also invalid (defense
 *   in depth: the UI never trusts unparseable text);
 * - anything else (e.g. `PROVIDER_ERROR`) → rethrown for the caller to surface.
 */
export async function requestNlSmartView(
  query: string,
  catalog: SmartViewFieldCatalog,
  signal?: AbortSignal,
): Promise<NlSmartViewResult> {
  const fieldCatalog = toParserCatalog(catalog);
  let rawDsl: string;
  try {
    const res = await nlToSmartView({ query, catalog }, signal);
    rawDsl = res.dsl;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
      const details = readInvalidDetails(err.details);
      if (details !== null) {
        return {
          ok: false,
          rawDsl: details.rawDsl,
          error: details.parseError ?? err.message,
          ...(details.position !== undefined ? { position: details.position } : {}),
        };
      }
    }
    throw err;
  }

  // Client authority: re-parse the AI's DSL text with the shared parser.
  try {
    const ast = parse(rawDsl, { fieldCatalog });
    return { ok: true, dsl: rawDsl, ast };
  } catch (err) {
    if (err instanceof ParseError) {
      return { ok: false, rawDsl, error: err.message, position: err.position };
    }
    throw err;
  }
}
