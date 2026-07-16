import {
  parse,
  ParseError,
  type Ast,
  type DslCustomFieldDef,
  type Position,
} from '@switchboard/shared';
import {
  smartViewFieldCatalogSchema,
  type AIProvider,
  type SmartViewFieldCatalog,
} from '@switchboard/shared/providers';

/**
 * AI natural-language → Smart View (task 3g). ARCHITECTURE §7 / §I-AI: Haiku emits
 * DSL TEXT; that text is RE-PARSED by the SAME `parse()` the Smart View builder uses
 * for hand-typed queries. Invalid DSL becomes a visible, position-carrying error —
 * never a silent guess, and never a saved view. On success the parsed AST is returned
 * for the builder to confirm and save; this module never persists a smart_view row,
 * so the AI output cannot reach a saved record without the explicit user save.
 *
 * The provider receives only the field catalog (the minimum the feature needs, §7):
 * builtin field names plus the org's custom fields, so it references real fields.
 * The custom fields double as the parser's `fieldCatalog`, so a `custom.<key>` the
 * model invents that isn't in the catalog is a parse error, not an accepted guess.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface NlToSmartViewDeps {
  ai: AIProvider;
}

export interface NlToSmartViewInput {
  query: string;
  catalog: SmartViewFieldCatalog;
}

export interface NlToSmartViewOk {
  ok: true;
  /** The re-serialized DSL from the parsed AST is available via the builder; we
   *  return the model's raw DSL that successfully parsed plus the typed AST. */
  dsl: string;
  ast: Ast;
}

export interface NlToSmartViewInvalid {
  ok: false;
  /** The raw DSL the model produced (surfaced so the error is never a silent guess). */
  rawDsl: string;
  error: string;
  position?: Position;
}

export type NlToSmartViewResult = NlToSmartViewOk | NlToSmartViewInvalid;

export class NlToSmartViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NlToSmartViewError';
  }
}

export async function nlToSmartView(
  deps: NlToSmartViewDeps,
  input: NlToSmartViewInput,
): Promise<NlToSmartViewResult> {
  if (input.query.trim().length === 0) throw new NlToSmartViewError('query is required');
  const catalog = smartViewFieldCatalogSchema.parse(input.catalog);

  const suggestion = await deps.ai.nlToSmartView(input.query, catalog);
  const rawDsl = suggestion.dsl;

  // Re-parse with the SAME parser as user input, gated by the SAME custom-field
  // catalog. A parse error is surfaced verbatim — never swallowed into a guess.
  try {
    const ast = parse(rawDsl, { fieldCatalog: toParserCatalog(catalog) });
    return { ok: true, dsl: rawDsl, ast };
  } catch (err) {
    if (err instanceof ParseError) {
      return { ok: false, rawDsl, error: err.message, position: err.position };
    }
    throw err;
  }
}

/** Map the feature's field catalog to the parser's lead-entity custom-field defs. */
function toParserCatalog(catalog: SmartViewFieldCatalog): DslCustomFieldDef[] {
  return catalog.custom.map((c) => ({
    key: c.key,
    entity: 'lead',
    type: c.type,
  }));
}
