/**
 * Golden DSL query set (Task 1d). Each case is a DSL string executed against the
 * loaded 5k golden fixture on PGlite; the expected lead-id set is derived by the
 * independent {@link ../dsl-golden/reference.ts} evaluator, never by compiler
 * snapshots.
 *
 * Coverage per the task spec: every builtin field with representative
 * comparators; custom.* across all five C1 types incl. presence; membership
 * (incl. `me`); every activity type has/no × with/without `within`;
 * in_sequence(name); matches FTS; relative dates h/d/w/mo + named anchors;
 * boolean combos with not + nesting; dollars semantics; empty/full edges;
 * keyword case-insensitivity.
 */

export interface GoldenCase {
  readonly name: string;
  readonly dsl: string;
  /** Case must match zero leads (edge coverage) — asserted. */
  readonly expectEmpty?: boolean;
  /** Case must match all 5000 leads (edge coverage) — asserted. */
  readonly expectFull?: boolean;
}

/** Values derived from the loaded fixture so cases can hit exact rows. */
export interface DerivedValues {
  /** ctx.currentUserId (a fixture owner) — `me`. */
  readonly meOwnerId: string;
  /** A different fixture owner id. */
  readonly otherOwnerId: string;
  /** Exact whole-dollar value of a known fixture opportunity. */
  readonly exactValueDollars: number;
  /** Exact email of a known fixture contact. */
  readonly exactEmail: string;
  /** Exact `custom.employees` value of a known fixture lead. */
  readonly exactEmployees: number;
}

export function buildCases(v: DerivedValues): GoldenCase[] {
  return [
    // --- name (text) --------------------------------------------------------
    { name: 'name exact match', dsl: 'name = "Acme Labs"' },
    { name: 'name != exact', dsl: 'name != "Acme Labs"' },
    { name: 'name contains (case-insensitive)', dsl: 'name contains "WIND"' },
    { name: 'name starts_with (case-insensitive)', dsl: 'name starts_with "acme"' },
    { name: 'name = no such lead (empty edge)', dsl: 'name = "ZZZ No Such Company"', expectEmpty: true },

    // --- status (select) ----------------------------------------------------
    { name: 'status equals', dsl: 'status = "Won"' },
    { name: 'status not equals pair', dsl: 'status != "Won" and status != "Lost"' },
    { name: 'status membership', dsl: 'status in ("Won", "Lost")' },
    { name: 'status = unknown label (empty edge)', dsl: 'status = "Archived"', expectEmpty: true },

    // --- owner (user) -------------------------------------------------------
    { name: 'owner equals literal uuid', dsl: `owner = "${v.otherOwnerId}"` },
    { name: 'owner in (me)', dsl: 'owner in (me)' },
    { name: 'owner in (me, other)', dsl: `owner in (me, "${v.otherOwnerId}")` },
    { name: 'owner != literal uuid', dsl: `owner != "${v.otherOwnerId}"` },

    // --- created / updated (date) -------------------------------------------
    { name: 'created after absolute date', dsl: 'created > 2025-01-01' },
    { name: 'created on-or-before absolute date', dsl: 'created <= 2025-01-01' },
    { name: 'created within 90d (reldate d)', dsl: 'created > 90d ago' },
    { name: 'created within 12mo (reldate mo)', dsl: 'created >= 12mo ago' },
    { name: 'created this_month (empty edge: fixture stops before June)', dsl: 'created >= this_month', expectEmpty: true },
    { name: 'updated is_set (full edge)', dsl: 'updated is_set', expectFull: true },

    // --- last_contacted / last_inbound / next_task_due (nullable dates) ------
    { name: 'last_contacted is_set', dsl: 'last_contacted is_set' },
    { name: 'last_contacted since absolute date', dsl: 'last_contacted >= 2026-05-01' },
    { name: 'last_contacted stale (NULL excluded by <)', dsl: 'last_contacted < 30d ago' },
    { name: 'last_contacted within 96h (reldate h)', dsl: 'last_contacted >= 96h ago' },
    { name: 'last_inbound within 2w (reldate w)', dsl: 'last_inbound >= 2w ago' },
    { name: 'last_inbound is_not_set', dsl: 'last_inbound is_not_set' },
    { name: 'next_task_due overdue (today anchor)', dsl: 'next_task_due < today' },
    { name: 'next_task_due window (today .. absolute)', dsl: 'next_task_due >= today and next_task_due < 2026-06-20' },
    { name: 'next_task_due from this_week', dsl: 'next_task_due >= this_week' },
    { name: 'next_task_due is_set', dsl: 'next_task_due is_set' },

    // --- dnc (bool) -----------------------------------------------------------
    { name: 'dnc true', dsl: 'dnc = true' },
    { name: 'dnc false', dsl: 'dnc = false' },
    { name: 'dnc != true (same set as false)', dsl: 'dnc != true' },

    // --- opportunity.value (number; DOLLARS → cents, D-007) -------------------
    { name: 'opportunity.value > 25000 dollars', dsl: 'opportunity.value > 25000' },
    { name: 'opportunity.value <= 100 dollars', dsl: 'opportunity.value <= 100' },
    { name: 'opportunity.value exact dollars of a fixture opp', dsl: `opportunity.value = ${v.exactValueDollars}` },
    { name: 'opportunity.value != 50 (some opp differs)', dsl: 'opportunity.value != 50' },
    { name: 'opportunity.value beyond max (empty edge)', dsl: 'opportunity.value > 50000', expectEmpty: true },
    { name: 'opportunity.value is_set (has any opp)', dsl: 'opportunity.value is_set' },
    { name: 'opportunity.value is_not_set', dsl: 'opportunity.value is_not_set' },

    // --- opportunity.stage / close_date ---------------------------------------
    { name: 'opportunity.stage equals', dsl: 'opportunity.stage = "Proposal"' },
    { name: 'opportunity.stage not equals', dsl: 'opportunity.stage != "Closed"' },
    { name: 'opportunity.stage membership', dsl: 'opportunity.stage in ("Discovery", "Negotiation")' },
    { name: 'opportunity.close_date before absolute', dsl: 'opportunity.close_date < 2026-06-01' },
    { name: 'opportunity.close_date from today (reldate vs DATE column)', dsl: 'opportunity.close_date >= today' },
    { name: 'opportunity.close_date is_set', dsl: 'opportunity.close_date is_set' },

    // --- contact.* -------------------------------------------------------------
    { name: 'contact.email exact (jsonb containment)', dsl: `contact.email = "${v.exactEmail}"` },
    { name: 'contact.email != exact (NOT EXISTS containment)', dsl: `contact.email != "${v.exactEmail}"` },
    { name: 'contact.email contains domain root', dsl: 'contact.email contains "acme"' },
    { name: 'contact.email starts_with first name', dsl: 'contact.email starts_with "ava."' },
    { name: 'contact.phone contains digits', dsl: 'contact.phone contains "555"' },
    { name: 'contact.phone starts_with country code (full edge)', dsl: 'contact.phone starts_with "+1"', expectFull: true },
    { name: 'contact.phone is_not_set (empty edge)', dsl: 'contact.phone is_not_set', expectEmpty: true },
    { name: 'contact.title equals', dsl: 'contact.title = "CEO"' },
    { name: 'contact.title contains (case-insensitive)', dsl: 'contact.title contains "sales"' },
    { name: 'contact.title is_set (full edge)', dsl: 'contact.title is_set', expectFull: true },

    // --- custom.* — all five C1 types -----------------------------------------
    // select
    { name: 'custom select equals', dsl: 'custom.industry = "fintech"' },
    { name: 'custom select not equals', dsl: 'custom.industry != "saas"' },
    { name: 'custom select membership', dsl: 'custom.industry in ("fintech", "media")' },
    { name: 'custom select is_set (full edge: always generated)', dsl: 'custom.industry is_set', expectFull: true },
    // text
    { name: 'custom text equals', dsl: 'custom.tier = "enterprise"' },
    { name: 'custom text contains', dsl: 'custom.tier contains "market"' },
    { name: 'custom text starts_with', dsl: 'custom.tier starts_with "enter"' },
    // number
    { name: 'custom number greater', dsl: 'custom.employees > 2500' },
    { name: 'custom number small band', dsl: 'custom.employees <= 10' },
    { name: 'custom number membership', dsl: `custom.employees in (${v.exactEmployees}, 2500)` },
    { name: 'custom number is_set (full edge)', dsl: 'custom.employees is_set', expectFull: true },
    // date
    { name: 'custom date before today', dsl: 'custom.renewal_date < today' },
    { name: 'custom date from absolute', dsl: 'custom.renewal_date >= 2026-06-01' },
    { name: 'custom date within 6mo back-window', dsl: 'custom.renewal_date > 3mo ago' },
    { name: 'custom date is_set', dsl: 'custom.renewal_date is_set' },
    { name: 'custom date is_not_set', dsl: 'custom.renewal_date is_not_set' },
    // user
    { name: 'custom user equals literal uuid', dsl: `custom.csm = "${v.otherOwnerId}"` },
    { name: 'custom user in (me)', dsl: 'custom.csm in (me)' },
    { name: 'custom user is_not_set', dsl: 'custom.csm is_not_set' },

    // --- activity predicates: every type, has/no × with/without within --------
    { name: 'has call', dsl: 'has call' },
    { name: 'has call within 2w', dsl: 'has call within 2w' },
    { name: 'no call', dsl: 'no call' },
    { name: 'no call within 30d', dsl: 'no call within 30 d' },
    { name: 'has email', dsl: 'has email' },
    { name: 'has email within 1w', dsl: 'has email within 1 w' },
    { name: 'no email within 72h', dsl: 'no email within 72 h' },
    { name: 'has inbound_email (spine email_received — golden-surfaced fix)', dsl: 'has inbound_email' },
    { name: 'has inbound_email within 2w', dsl: 'has inbound_email within 2 w' },
    { name: 'no inbound_email', dsl: 'no inbound_email' },
    { name: 'has sms', dsl: 'has sms' },
    { name: 'has sms within 1mo', dsl: 'has sms within 1 mo' },
    { name: 'no sms', dsl: 'no sms' },
    { name: 'has note', dsl: 'has note' },
    { name: 'has note within 2w', dsl: 'has note within 2 w' },
    { name: 'no note within 1w', dsl: 'no note within 1 w' },
    { name: 'has task_completed', dsl: 'has task_completed' },
    { name: 'has task_completed within 3w', dsl: 'has task_completed within 3 w' },
    { name: 'no task_completed', dsl: 'no task_completed' },
    { name: 'has sequence (bare: any enrollment event)', dsl: 'has sequence' },
    { name: 'has sequence within 2mo', dsl: 'has sequence within 2 mo' },
    { name: 'no sequence', dsl: 'no sequence' },
    { name: 'has in_sequence Onboarding', dsl: 'has in_sequence("Onboarding")' },
    { name: 'no in_sequence Onboarding', dsl: 'no in_sequence("Onboarding")' },
    { name: 'has in_sequence Renewal Push within 2w', dsl: 'has in_sequence("Renewal Push") within 2 w' },
    { name: 'has in_sequence unknown name (empty edge)', dsl: 'has in_sequence("Nonexistent")', expectEmpty: true },

    // --- matches (FTS) ----------------------------------------------------------
    { name: 'matches industry token', dsl: 'matches "fintech"' },
    { name: 'matches company root', dsl: 'matches "Northwind"' },
    { name: 'matches multi-token AND', dsl: 'matches "acme fintech"' },
    { name: 'matches nothing (empty edge)', dsl: 'matches "zzznomatch"', expectEmpty: true },

    // --- boolean combos, not, nesting -------------------------------------------
    { name: 'and combo: status + custom number', dsl: 'status = "Qualified" and custom.employees > 1000' },
    { name: 'or group and presence', dsl: '(status = "Won" or status = "Lost") and opportunity.value is_set' },
    { name: 'not on comparison', dsl: 'not dnc = true' },
    { name: 'not on activity + presence combo', dsl: 'not (has call within 30 d) and last_inbound is_set' },
    { name: 'not over nullable column comparison (never-contacted match the complement)', dsl: 'not last_contacted < 30d ago' },
    { name: 'not over custom date comparison (missing keys match the complement)', dsl: 'not custom.renewal_date < today' },
    { name: 'three-level nesting', dsl: 'status = "Potential" and (custom.industry = "saas" or custom.industry = "fintech") and not dnc = true' },
    { name: 'not over or-group with membership', dsl: 'not (status in ("Won", "Lost") or dnc = true)' },
    { name: 'or of empties (empty edge)', dsl: 'name = "ZZZ No Such Company" or status = "Archived"', expectEmpty: true },

    // --- keyword case-insensitivity ---------------------------------------------
    { name: 'uppercase keywords: AND / NOT / TRUE', dsl: 'Status = "Won" AND NOT Dnc = TRUE' },
    { name: 'uppercase keywords: HAS/WITHIN/unit', dsl: 'HAS CALL WITHIN 2W' },
    { name: 'uppercase keywords: IN (ME)', dsl: 'OWNER IN (ME)' },
    { name: 'uppercase keywords: MATCHES', dsl: 'MATCHES "fintech"' },
    { name: 'uppercase keywords: IS_NOT_SET', dsl: 'Custom.renewal_date IS_NOT_SET' },
  ];
}
