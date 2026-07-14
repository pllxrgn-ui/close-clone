/**
 * Smart View DSL (CONTRACTS §C3) — the single query authority.
 *
 * Public API: lexer → recursive-descent parser → zod-typed AST → parameterized
 * SQL compiler, plus the `astToDsl` serializer with the normative round-trip
 * `parse(astToDsl(a)) ≡ a`. All user literals compile to `$n` parameters; no
 * user value is ever spliced into SQL text.
 */

export { GRAMMAR_VERSION, DSL_GRAMMAR_VERSION } from './version.ts';

export { parse, type ParseOptions } from './parser.ts';
export { astToDsl } from './serialize.ts';
export {
  compile,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SORTABLE_FIELDS,
  type CompileContext,
  type CompileOptions,
  type CompiledQuery,
  type Cursor,
  type SortField,
  type SortSpec,
} from './compile.ts';

export { ParseError, type Position } from './errors.ts';

export {
  astSchema,
  exprSchema,
  fieldRefSchema,
  scalarValueSchema,
  membershipValueSchema,
  ACTIVITY_TYPES_DSL,
  RELATIVE_UNITS,
  NAMED_RELDATES,
  type Ast,
  type Expr,
  type FieldRef,
  type ScalarValue,
  type MembershipValue,
  type Relative,
  type RelativeUnit,
  type ActivityTypeDsl,
} from './ast.ts';

// The DSL-local custom-field catalog type is exported under a DSL-specific name
// to avoid colliding with the fuller DB-row `CustomFieldDef` from domain.ts
// (both flow through the package barrel).
export {
  customFieldDefSchema as dslCustomFieldDefSchema,
  type CustomFieldDef as DslCustomFieldDef,
} from './ast.ts';

export {
  BUILTIN_FIELDS,
  BUILTIN_FIELD_NAMES,
  VALUE_CMPS,
  PRESENCE_CMPS,
  type FieldType,
  type ValueCmp,
  type PresenceCmp,
  type BuiltinFieldName,
} from './fields.ts';
