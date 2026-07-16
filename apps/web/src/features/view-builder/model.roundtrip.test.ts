/*
 * The round-trip invariant (CONTRACTS §C3, task ACCEPT): the visual builder and
 * the raw DSL never diverge because they share one AST.
 *
 *   builder → builderToAst → astToDsl → parse  ≡ (deep-equal)  builderToAst(builder)
 *
 * Since a builder leaf IS an AST leaf and `builderToAst` emits the canonical
 * left-associative shape the parser rebuilds, this reduces to the shared
 * package's proven `parse(astToDsl(a)) ≡ a`. The risk the builder adds is
 * emitting a *type-invalid* leaf the parser rejects — so the generator below
 * builds only type-valid leaves using the SAME rule mirror the UI uses
 * (catalog.ts), making this suite the enforcement that the mirror matches the
 * real parser.
 *
 * Property-style over a seeded generator (no fast-check dependency in web; the
 * repo already hand-rolls a mulberry32 PRNG for its fixtures) plus one fixed
 * case per C3 predicate kind / value kind.
 */
import { describe, expect, test } from 'vitest';
import type {
  ActivityTypeDsl,
  Ast,
  DslCustomFieldDef,
  FieldRef,
  FieldType,
  MembershipValue,
  RelativeUnit,
  ScalarValue,
  ValueCmp,
} from '@switchboard/shared';
import { ACTIVITY_TYPES_DSL, astToDsl, NAMED_RELDATES, parse } from '@switchboard/shared';
import { BUILTIN_FIELDS, BUILTIN_FIELD_NAMES } from '@switchboard/shared';
import { cmpAllowed, membershipAllowed } from './catalog.ts';
import {
  builderToAst,
  newGroup,
  newLeaf,
  rootFromAst,
  wrapInNot,
  type BuilderNode,
  type LeafExpr,
} from './model.ts';

// ── Fixed lead-entity catalog (mirrors the shared property-test catalog) ──────
const CATALOG: DslCustomFieldDef[] = [
  { key: 'industry', entity: 'lead', type: 'text', options: null },
  { key: 'employees', entity: 'lead', type: 'number', options: null },
  { key: 'renewal_date', entity: 'lead', type: 'date', options: null },
  { key: 'tier', entity: 'lead', type: 'select', options: ['gold', 'silver'] },
  { key: 'csm', entity: 'lead', type: 'user', options: null },
];
const opts = { fieldCatalog: CATALOG };

// ── Deterministic PRNG (mulberry32) ───────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
const int = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

// Strings that exercise quoting/escaping and keyword-as-content.
const STRINGS = [
  '',
  'Acme',
  'hello world',
  'a"b',
  'c\\d',
  'multi\nline',
  'café',
  "O'Brien",
  'has and or not',
  'in_sequence("x")',
];
const UNITS: readonly RelativeUnit[] = ['h', 'd', 'w', 'mo'];

interface FieldDesc {
  ref: FieldRef;
  type: FieldType;
}
const BUILTIN_DESCS: FieldDesc[] = BUILTIN_FIELD_NAMES.map((name) => ({
  ref: { kind: 'builtin', name },
  type: BUILTIN_FIELDS[name],
}));
const CUSTOM_DESCS: FieldDesc[] = CATALOG.map((d) => ({
  ref: { kind: 'custom', key: d.key, type: d.type },
  type: d.type,
}));
const ALL_DESCS = [...BUILTIN_DESCS, ...CUSTOM_DESCS];
const MEMBER_DESCS = ALL_DESCS.filter((d) => membershipAllowed(d.type));

const VALUE_CMP_POOL: readonly ValueCmp[] = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'contains',
  'starts_with',
];

function scalarForType(rng: () => number, type: FieldType): ScalarValue {
  switch (type) {
    case 'text':
    case 'select':
    case 'user':
      return { kind: 'string', value: pick(rng, STRINGS) };
    case 'number':
      return { kind: 'number', value: int(rng, 0, 999_999) };
    case 'bool':
      return { kind: 'bool', value: rng() < 0.5 };
    case 'date':
      if (rng() < 0.5) {
        return {
          kind: 'date',
          value: `20${int(rng, 10, 35)}-${pad(int(rng, 1, 12))}-${pad(int(rng, 1, 28))}`,
        };
      }
      return rng() < 0.5
        ? {
            kind: 'reldate',
            rel: { form: 'relative', n: int(rng, 0, 999), unit: pick(rng, UNITS) },
          }
        : { kind: 'reldate', rel: { form: 'named', name: pick(rng, NAMED_RELDATES) } };
  }
}
const pad = (n: number): string => String(n).padStart(2, '0');

function memberValueForType(rng: () => number, type: FieldType): MembershipValue {
  if (type === 'number') return { kind: 'number', value: int(rng, 0, 999_999) };
  if (type === 'user' && rng() < 0.4) return { kind: 'me' };
  return { kind: 'string', value: pick(rng, STRINGS) };
}

function randomLeaf(rng: () => number): LeafExpr {
  const roll = rng();
  if (roll < 0.4) {
    const desc = pick(rng, ALL_DESCS);
    const cmp = pick(
      rng,
      VALUE_CMP_POOL.filter((c) => cmpAllowed(desc.type, c)),
    );
    return { kind: 'field', field: desc.ref, cmp, value: scalarForType(rng, desc.type) };
  }
  if (roll < 0.55) {
    const desc = pick(rng, ALL_DESCS);
    return { kind: 'presence', field: desc.ref, op: rng() < 0.5 ? 'is_set' : 'is_not_set' };
  }
  if (roll < 0.7) {
    const desc = pick(rng, MEMBER_DESCS);
    const n = int(rng, 1, 4);
    const values = Array.from({ length: n }, () => memberValueForType(rng, desc.type));
    return { kind: 'membership', field: desc.ref, values };
  }
  if (roll < 0.9) {
    const activity = pick(rng, ACTIVITY_TYPES_DSL) as ActivityTypeDsl;
    const leaf: LeafExpr = { kind: 'activity', op: rng() < 0.5 ? 'has' : 'no', activity };
    const withName =
      activity === 'in_sequence' ? { ...leaf, sequenceName: pick(rng, STRINGS) } : leaf;
    return rng() < 0.5
      ? { ...withName, within: { n: int(rng, 0, 999), unit: pick(rng, UNITS) } }
      : withName;
  }
  return { kind: 'text', query: pick(rng, STRINGS) };
}

function randomNode(rng: () => number, depth: number): BuilderNode {
  if (depth <= 0 || rng() < 0.55) {
    const leaf = newLeaf(randomLeaf(rng));
    return rng() < 0.15 ? wrapInNot(leaf, leaf.id) : leaf;
  }
  const roll = rng();
  if (roll < 0.2) {
    const child = randomNode(rng, depth - 1);
    return wrapInNot(child, child.id);
  }
  const op = rng() < 0.5 ? 'and' : 'or';
  const count = int(rng, 1, 4);
  const children = Array.from({ length: count }, () => randomNode(rng, depth - 1));
  return newGroup(op, children);
}

/** A random root: always a group with ≥1 clause (matches the editor invariant). */
function randomRoot(rng: () => number): BuilderNode {
  const count = int(rng, 1, 4);
  const children = Array.from({ length: count }, () => randomNode(rng, 3));
  return newGroup(rng() < 0.5 ? 'and' : 'or', children);
}

describe('round-trip: builder → astToDsl → parse ≡ AST (property, seeded)', () => {
  test('holds for 600 random type-valid builder models', () => {
    const rng = mulberry32(0x5eed42);
    for (let i = 0; i < 600; i += 1) {
      const model = randomRoot(rng);
      const ast = builderToAst(model);
      expect(ast).not.toBeNull();
      if (ast === null) continue;

      const dsl = astToDsl(ast);
      let reparsed: Ast;
      try {
        reparsed = parse(dsl, opts);
      } catch (err) {
        throw new Error(
          `iteration ${i}: parse failed for dsl=${JSON.stringify(dsl)}: ${String(err)}`,
        );
      }
      expect(reparsed, `iteration ${i} dsl=${JSON.stringify(dsl)}`).toEqual(ast);
    }
  });

  test('raw edits rehydrate the builder losslessly and toggling builder↔DSL never drifts', () => {
    const rng = mulberry32(0x1234abc);
    for (let i = 0; i < 300; i += 1) {
      const model = randomRoot(rng);
      const ast = builderToAst(model);
      if (ast === null) continue;
      // Rehydrate once: DSL → parse → builder → fold. This yields the canonical
      // normal form (same-op chains flatten + re-fold left-associatively), which
      // is SEMANTICALLY identical to `ast` (and/or are associative).
      const normal1 = builderToAst(rootFromAst(parse(astToDsl(ast), opts)));
      expect(normal1).not.toBeNull();
      if (normal1 === null) continue;
      // The rehydrated builder and its DSL agree exactly (never diverge, C3).
      expect(parse(astToDsl(normal1), opts), `iteration ${i} round-trip`).toEqual(normal1);
      // Toggling builder→DSL→builder a second time is a fixed point (no drift).
      const normal2 = builderToAst(rootFromAst(parse(astToDsl(normal1), opts)));
      expect(normal2, `iteration ${i} idempotent`).toEqual(normal1);
    }
  });
});

// ── Fixed case per C3 predicate kind / value kind ────────────────────────────
// Each starts from DSL, builds the visual model, folds back, and asserts the
// reparsed AST is identical — proving every construct the UI can build survives
// the builder ⇄ DSL boundary.
const FIXED_CASES: ReadonlyArray<{ name: string; dsl: string }> = [
  // fieldPred — text comparators
  { name: 'field/text equals', dsl: 'name = "Acme"' },
  { name: 'field/text not-equals', dsl: 'name != "Acme"' },
  { name: 'field/text contains', dsl: 'name contains "Acme"' },
  { name: 'field/text starts_with', dsl: 'name starts_with "Ac"' },
  // fieldPred — number
  { name: 'field/number gt (whole dollars)', dsl: 'opportunity.value > 5000' },
  { name: 'field/number zero', dsl: 'custom.employees = 0' },
  { name: 'field/number lte', dsl: 'custom.employees <= 250' },
  // fieldPred — date exact + relative + named
  { name: 'field/date exact', dsl: 'created > 2026-01-01' },
  { name: 'field/reldate N-units-ago', dsl: 'last_contacted > 7d ago' },
  { name: 'field/reldate today', dsl: 'next_task_due < today' },
  { name: 'field/reldate this_week', dsl: 'updated >= this_week' },
  { name: 'field/reldate this_month', dsl: 'created = this_month' },
  // fieldPred — bool / select / user
  { name: 'field/bool true', dsl: 'dnc = true' },
  { name: 'field/bool false', dsl: 'dnc = false' },
  { name: 'field/select', dsl: 'status = "Qualified"' },
  { name: 'field/user', dsl: 'owner = "user-123"' },
  // presencePred
  { name: 'presence is_set', dsl: 'next_task_due is_set' },
  { name: 'presence is_not_set', dsl: 'last_inbound is_not_set' },
  // membershipPred (incl. me chip)
  { name: 'membership/text list', dsl: 'name in ("Acme", "Globex")' },
  { name: 'membership/number list', dsl: 'custom.employees in (10, 50, 100)' },
  { name: 'membership/user me', dsl: 'owner in (me)' },
  { name: 'membership/user me + id', dsl: 'owner in (me, "user-9")' },
  { name: 'membership/select', dsl: 'status in ("Won", "Lost")' },
  // activityPred — each type, has/no, within, in_sequence
  { name: 'activity has call', dsl: 'has call' },
  { name: 'activity no email', dsl: 'no email' },
  { name: 'activity has inbound_email', dsl: 'has inbound_email' },
  { name: 'activity has sms', dsl: 'has sms' },
  { name: 'activity has note', dsl: 'has note' },
  { name: 'activity no task_completed', dsl: 'no task_completed' },
  { name: 'activity has sequence (bare)', dsl: 'has sequence' },
  { name: 'activity within', dsl: 'has call within 7d' },
  { name: 'activity in_sequence', dsl: 'has in_sequence("Onboarding")' },
  { name: 'activity in_sequence + within', dsl: 'no in_sequence("Winback") within 30d' },
  // textPred
  { name: 'text matches', dsl: 'matches "quarterly review"' },
  // combinators + nesting
  { name: 'and', dsl: 'has call and has email' },
  { name: 'or', dsl: 'has call or has email' },
  { name: 'not', dsl: 'not has call' },
  {
    name: 'nested precedence',
    dsl: 'status = "Qualified" and (owner in (me) or has inbound_email within 7d)',
  },
  { name: 'not over a group', dsl: 'not (has call and has email)' },
];

describe('round-trip: fixed case per predicate kind', () => {
  for (const { name, dsl } of FIXED_CASES) {
    test(name, () => {
      const ast = parse(dsl, opts);
      const model = rootFromAst(ast);
      const folded = builderToAst(model);
      expect(folded).not.toBeNull();
      expect(folded).toEqual(ast);
      // and the serialized-then-reparsed form is identical
      expect(parse(astToDsl(folded as Ast), opts)).toEqual(ast);
    });
  }
});
