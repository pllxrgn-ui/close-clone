import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { astArb, TEST_CATALOG } from './arbitrary.ts';
import { compile, type CompileContext, type SortField } from './compile.ts';
import { parse } from './parser.ts';
import { astToDsl } from './serialize.ts';

const CTX: CompileContext = {
  currentUserId: '11111111-1111-1111-1111-111111111111',
  orgTimezone: 'America/New_York',
  fieldCatalog: TEST_CATALOG,
  now: new Date('2026-07-14T16:00:00Z'),
};
const opts = { fieldCatalog: TEST_CATALOG };

const compileDsl = (dsl: string, options = {}) => compile(parse(dsl, opts), CTX, options);

describe('compile â€” shape & parameters', () => {
  it('emits a keyset-paginated, parameterized SELECT', () => {
    const { sql, params } = compileDsl('name contains "acme"');
    expect(sql).toContain('SELECT leads.id');
    expect(sql).toContain('FROM leads');
    expect(sql).toContain('leads.deleted_at IS NULL');
    expect(sql).toContain('ORDER BY leads.created_at DESC, leads.id DESC');
    expect(sql).toMatch(/LIMIT \$\d+$/);
    expect(params).toContain('%acme%');
    // default limit param present.
    expect(params).toContain(50);
  });

  it('binds me to the current user', () => {
    const { sql, params } = compileDsl('owner in (me)');
    expect(params).toContain(CTX.currentUserId);
    expect(sql).toContain('leads.owner_id =');
  });

  it('maps has_call within to the denormalized column', () => {
    const { sql } = compileDsl('has call within 7d');
    expect(sql).toContain('leads.last_call_at >=');
    expect(sql).not.toContain('EXISTS');
  });

  it('maps no call (no window) to a NULL check', () => {
    expect(compileDsl('no call').sql).toContain('leads.last_call_at IS NULL');
  });

  it('maps general activity predicates to EXISTS on activities', () => {
    const { sql, params } = compileDsl('has note within 30d');
    expect(sql).toContain('EXISTS (SELECT 1 FROM activities a');
    expect(params).toContain('note_added');
  });

  it('emits two-valued predicates so `not` is an exact set complement (golden-surfaced, Task 1d)', () => {
    // Nullable denorm column under a windowed has: guard against SQL NULL
    // (NULL >= x is NULL; NOT NULL is still NULL → rows silently dropped).
    const hasWin = compileDsl('not (has call within 7 d)');
    expect(hasWin.sql).toContain('(leads.last_call_at IS NOT NULL AND leads.last_call_at >=');

    // Nullable lead column comparison.
    const nullableCol = compileDsl('last_contacted < 30d ago');
    expect(nullableCol.sql).toContain('(leads.last_contacted_at IS NOT NULL AND leads.last_contacted_at <');

    // NOT NULL columns stay unguarded (sargable, no noise).
    expect(compileDsl('created > 7d ago').sql).not.toContain('leads.created_at IS NOT NULL');

    // Custom-field accessor: a missing key must not become NULL.
    const custom = compileDsl('custom.employees >= 100');
    expect(custom.sql).toContain('(leads.custom ->> $1) IS NOT NULL AND');

    // status compiles to EXISTS (never a NULL-able scalar-subquery comparison),
    // with != as its exact complement.
    const eq = compileDsl('status = "Won"');
    expect(eq.sql).toContain('EXISTS (SELECT 1 FROM lead_statuses ls');
    const ne = compileDsl('status != "Won"');
    expect(ne.sql).toContain('NOT EXISTS (SELECT 1 FROM lead_statuses ls');
  });

  it('maps inbound_email to email_received spine events, not last_inbound_at (golden-surfaced, Task 1d)', () => {
    // `leads.last_inbound_at` is cross-channel (advances on sms_received too,
    // CONTRACTS §C1), so it cannot answer the email-specific predicate.
    const has = compileDsl('has inbound_email within 30d');
    expect(has.sql).toContain('EXISTS (SELECT 1 FROM activities a');
    expect(has.params).toContain('email_received');
    expect(has.sql).not.toContain('last_inbound_at');

    const no = compileDsl('no inbound_email');
    expect(no.sql).toContain('NOT EXISTS');
    expect(no.params).toContain('email_received');
    expect(no.sql).not.toContain('last_inbound_at');
  });

  it('maps in_sequence to sequence_enrollments joined by name', () => {
    const { sql, params } = compileDsl('has in_sequence("Onboarding")');
    expect(sql).toContain('FROM sequence_enrollments se JOIN sequences sq');
    expect(params).toContain('Onboarding');
  });

  it('maps contact.* to EXISTS on contacts with jsonb containment', () => {
    const { sql, params } = compileDsl('contact.email = "a@b.com"');
    expect(sql).toContain('FROM contacts c');
    expect(sql).toContain('c.emails @>');
    expect(params).toContain(JSON.stringify([{ email: 'a@b.com' }]));
  });

  it('maps custom fields to jsonb accessors with the catalog cast; key is a param', () => {
    const num = compileDsl('custom.employees >= 100');
    expect(num.sql).toContain('(leads.custom ->> $1)::numeric >=');
    expect(num.params[0]).toBe('employees');
    expect(num.params).toContain(100);

    const dt = compileDsl('custom.renewal_date < 2026-01-01');
    expect(dt.sql).toContain('::timestamptz');
  });

  it('maps matches to a full-text search clause', () => {
    const { sql, params } = compileDsl('matches "quarterly review"');
    expect(sql).toContain('leads.search_tsv @@ websearch_to_tsquery');
    expect(params).toContain('quarterly review');
  });

  it('resolves relative dates against ctx.now/timezone into params', () => {
    const { params } = compileDsl('created > 7d ago');
    const iso = params.find((p) => typeof p === 'string' && p.startsWith('2026-07-07'));
    expect(iso).toBeDefined();
  });
});

describe('compile â€” opportunity.value dollar semantics (CONTRACTS C3 / D-007)', () => {
  it('treats the literal as whole dollars and compares against value_cents (×100)', () => {
    const { sql, params } = compileDsl('opportunity.value > 5000');
    expect(sql).toContain('o.value_cents >');
    expect(params).toContain(500000);
    // The raw dollar literal must never reach the params — only cents.
    expect(params).not.toContain(5000);
  });

  it('applies ×100 across comparators', () => {
    expect(compileDsl('opportunity.value = 1000').params).toContain(100000);
    expect(compileDsl('opportunity.value <= 250').params).toContain(25000);
    expect(compileDsl('opportunity.value != 0').params).toContain(0);
  });

  it('applies ×100 inside membership lists', () => {
    const { params } = compileDsl('opportunity.value in (1000, 2500)');
    expect(params).toContain(100000);
    expect(params).toContain(250000);
  });

  it('rounds sub-dollar literals to integer cents', () => {
    // 5000.50 * 100 in IEEE754 is 500049.99999999994; Math.round → 500050.
    expect(compileDsl('opportunity.value >= 5000.50').params).toContain(500050);
  });
});

describe('compile â€” pagination options', () => {
  it('honors sort and clamps limit to [1,200]', () => {
    const { sql, params } = compileDsl('dnc = true', {
      sort: { field: 'name', direction: 'asc' },
      limit: 5000,
    });
    expect(sql).toContain('ORDER BY leads.name ASC, leads.id ASC');
    expect(params).toContain(200);
  });

  it('emits a keyset WHERE clause from a cursor', () => {
    const { sql, params } = compileDsl('dnc = true', {
      sort: { field: 'created', direction: 'desc' },
      cursor: { sortValue: '2026-01-01T00:00:00Z', id: 'abc' },
    });
    expect(sql).toContain('(leads.created_at, leads.id) < (');
    expect(params).toContain('2026-01-01T00:00:00Z');
    expect(params).toContain('abc');
  });

  it('rejects an unknown sort field', () => {
    const badSort = { sort: { field: 'evil' as SortField, direction: 'asc' as const } };
    expect(() => compile(parse('dnc = true', opts), CTX, badSort)).toThrow(/invalid sort field/);
  });
});

describe('compile â€” every literal is a placeholder; nothing string-spliced', () => {
  it('contains exactly N placeholders for N params', () => {
    fc.assert(
      fc.property(astArb, (ast) => {
        const { sql, params } = compile(ast, CTX, {});
        const placeholders = new Set((sql.match(/\$\d+/g) ?? []).map((m) => m));
        // Every param index 1..N appears at least once.
        for (let i = 1; i <= params.length; i++) {
          expect(placeholders.has(`$${i}`)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('compile â€” HOSTILE INPUTS appear only in params', () => {
  // A unique sentinel guarantees the payload can never coincidentally match a
  // fragment of the fixed SQL template, so `not.toContain` is a true splice test.
  const hostileCore = fc.string({ maxLength: 40 });
  const hostileArb = fc
    .tuple(
      fc.constantFrom(
        `'; DROP TABLE leads;--`,
        `" OR 1=1 --`,
        `\\'; DELETE FROM users; --`,
        `%'||(SELECT secret FROM x)||'%`,
        `Ω≈ç√∫˜µ`,
        `a"b\\c'd`,
        `) OR (SELECT 1)=1 --`,
      ),
      hostileCore,
    )
    .map(([meta, rand]) => `SENTINEL_7f3a_${meta}${rand}`);

  const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  it('string values: hostile content lands only in params (2000 runs)', () => {
    fc.assert(
      fc.property(hostileArb, (payload) => {
        for (const dsl of [
          `name = ${quote(payload)}`,
          `matches ${quote(payload)}`,
          `contact.email contains ${quote(payload)}`,
          `custom.industry = ${quote(payload)}`,
          `has in_sequence(${quote(payload)})`,
        ]) {
          const { sql, params } = compile(parse(dsl, opts), CTX, {});
          expect(sql).not.toContain('SENTINEL_7f3a_');
          expect(params.some((p) => typeof p === 'string' && p.includes('SENTINEL_7f3a_'))).toBe(
            true,
          );
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('raw fuzz: parses cleanly or compiles to consistent placeholders (1500 runs)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 160 }), (raw) => {
        let ast;
        try {
          ast = parse(raw, opts);
        } catch {
          return; // clean parse failure is acceptable
        }
        // If it parsed, it must compile and serialize without throwing, and every
        // param must be referenced by a $n placeholder in the SQL text.
        const { sql, params } = compile(ast, CTX, {});
        for (let i = 1; i <= params.length; i++) {
          expect(sql.includes(`$${i}`)).toBe(true);
        }
        expect(() => astToDsl(ast)).not.toThrow();
      }),
      { numRuns: 1500 },
    );
  });
});
