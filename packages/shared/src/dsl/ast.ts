/**
 * Typed AST for the Smart View DSL (CONTRACTS §C3), expressed as zod
 * discriminated unions. The zod schema is the runtime contract; the TS types are
 * inferred from it (never hand-written separately), matching the C-intro rule.
 *
 * `custom.<key>` fields carry their resolved {@link FieldType} (from the caller
 * field catalog) so the compiler can pick the right jsonb cast without re-reading
 * the catalog shape.
 */
import { z } from 'zod';

import { BUILTIN_FIELD_NAMES, VALUE_CMPS } from './fields.ts';

export const RELATIVE_UNITS = ['h', 'd', 'w', 'mo'] as const;
export type RelativeUnit = (typeof RELATIVE_UNITS)[number];

export const NAMED_RELDATES = ['today', 'this_week', 'this_month'] as const;

export const fieldTypeSchema = z.enum(['text', 'number', 'date', 'bool', 'user', 'select']);

// ---- Fields ----------------------------------------------------------------

export const builtinFieldSchema = z.object({
  kind: z.literal('builtin'),
  name: z.enum(BUILTIN_FIELD_NAMES as [string, ...string[]]),
});

export const customFieldSchema = z.object({
  kind: z.literal('custom'),
  key: z.string(),
  type: fieldTypeSchema,
});

export const fieldRefSchema = z.discriminatedUnion('kind', [builtinFieldSchema, customFieldSchema]);
export type FieldRef = z.infer<typeof fieldRefSchema>;

// ---- Values ----------------------------------------------------------------

export const relativeSchema = z.discriminatedUnion('form', [
  z.object({
    form: z.literal('relative'),
    n: z.number().int().nonnegative(),
    unit: z.enum(RELATIVE_UNITS),
  }),
  z.object({ form: z.literal('named'), name: z.enum(NAMED_RELDATES) }),
]);
export type Relative = z.infer<typeof relativeSchema>;

export const stringValueSchema = z.object({ kind: z.literal('string'), value: z.string() });
export const numberValueSchema = z.object({ kind: z.literal('number'), value: z.number() });
export const boolValueSchema = z.object({ kind: z.literal('bool'), value: z.boolean() });
export const dateValueSchema = z.object({ kind: z.literal('date'), value: z.string() });
export const reldateValueSchema = z.object({ kind: z.literal('reldate'), rel: relativeSchema });
export const meValueSchema = z.object({ kind: z.literal('me') });

/** Scalar values usable in a `field cmp value` predicate (no `me`). */
export const scalarValueSchema = z.discriminatedUnion('kind', [
  stringValueSchema,
  numberValueSchema,
  boolValueSchema,
  dateValueSchema,
  reldateValueSchema,
]);
export type ScalarValue = z.infer<typeof scalarValueSchema>;

/** Values usable inside a membership `in (...)` list (`me` allowed). */
export const membershipValueSchema = z.discriminatedUnion('kind', [
  stringValueSchema,
  numberValueSchema,
  boolValueSchema,
  meValueSchema,
]);
export type MembershipValue = z.infer<typeof membershipValueSchema>;

// ---- Predicates ------------------------------------------------------------

export const fieldPredSchema = z.object({
  kind: z.literal('field'),
  field: fieldRefSchema,
  cmp: z.enum(VALUE_CMPS),
  value: scalarValueSchema,
});

export const presencePredSchema = z.object({
  kind: z.literal('presence'),
  field: fieldRefSchema,
  op: z.enum(['is_set', 'is_not_set']),
});

export const membershipPredSchema = z.object({
  kind: z.literal('membership'),
  field: fieldRefSchema,
  values: z.array(membershipValueSchema).min(1),
});

export const ACTIVITY_TYPES_DSL = [
  'call',
  'email',
  'inbound_email',
  'sms',
  'note',
  'task_completed',
  'sequence',
  'in_sequence',
] as const;
export type ActivityTypeDsl = (typeof ACTIVITY_TYPES_DSL)[number];

export const withinSchema = z.object({
  n: z.number().int().nonnegative(),
  unit: z.enum(RELATIVE_UNITS),
});

// Invariant (sequenceName present iff activity === 'in_sequence') is enforced by
// the parser; it is not expressed as a zod `.refine` here because a refined
// schema is a ZodEffects and cannot participate in a discriminated union.
export const activityPredSchema = z.object({
  kind: z.literal('activity'),
  op: z.enum(['has', 'no']),
  activity: z.enum(ACTIVITY_TYPES_DSL),
  sequenceName: z.string().optional(),
  within: withinSchema.optional(),
});

export const textPredSchema = z.object({ kind: z.literal('text'), query: z.string() });

// ---- Expressions (recursive) ----------------------------------------------

export type Expr =
  | z.infer<typeof fieldPredSchema>
  | z.infer<typeof presencePredSchema>
  | z.infer<typeof membershipPredSchema>
  | z.infer<typeof activityPredSchema>
  | z.infer<typeof textPredSchema>
  | { kind: 'not'; expr: Expr }
  | { kind: 'and'; left: Expr; right: Expr }
  | { kind: 'or'; left: Expr; right: Expr };

export const exprSchema = z.lazy(() =>
  z.discriminatedUnion('kind', [
    fieldPredSchema,
    presencePredSchema,
    membershipPredSchema,
    activityPredSchema,
    textPredSchema,
    notSchema,
    andSchema,
    orSchema,
  ]),
) as unknown as z.ZodType<Expr>;

export const notSchema = z.object({ kind: z.literal('not'), expr: exprSchema });
export const andSchema = z.object({
  kind: z.literal('and'),
  left: exprSchema,
  right: exprSchema,
});
export const orSchema = z.object({
  kind: z.literal('or'),
  left: exprSchema,
  right: exprSchema,
});

/** The root of every parsed Smart View. */
export type Ast = Expr;
export const astSchema = exprSchema;

// ---- Caller-supplied custom field catalog (CONTRACTS §C1 shape) -----------

// DSL-local view of the C1 custom_field_defs shape ({key, entity, type,
// options}). Kept local (not re-exported through the package barrel) so it does
// not collide with the fuller DB-row `CustomFieldDef` in domain.ts; the shapes
// are structurally compatible for the fields the DSL reads.
export const customFieldDefSchema = z.object({
  key: z.string(),
  entity: z.enum(['lead', 'contact', 'opportunity']),
  type: fieldTypeSchema,
  options: z.array(z.unknown()).nullable().optional(),
});
export type CustomFieldDef = z.infer<typeof customFieldDefSchema>;
