import { sql } from 'drizzle-orm';

import { contacts, leads, suppressions, type Db } from '../../db/index.ts';

/**
 * Dedupe matching (Task 4f, per build-guide §3/§8). An incoming row matches an
 * existing lead by, in priority order: exact contact email, company domain
 * (derived from lead url + contact email domains), then fuzzy company name
 * (pg_trgm trigram similarity — installed by Task 1e). Exact keys are held in an
 * in-memory index built once from the pre-import snapshot; the fuzzy pass is a
 * pg_trgm query so the match semantics are Postgres', not a JS re-implementation.
 *
 * The index is a snapshot: it is built before any writes and never mutated by
 * the import, which is what makes dry-run and commit reach identical decisions
 * (the planner layers in-file matches on top; see plan.ts).
 */

// Free/consumer email providers — a shared inbox domain is not a company domain,
// so email-derived domain matching skips these (url domains are still trusted).
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
]);

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function normalizeHost(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (h === '' || !h.includes('.')) return null;
  return h;
}

/** Registrable-ish domain from a URL (adds a scheme, strips `www.`/path). */
export function domainFromUrl(url: string): string | null {
  const raw = url.trim();
  if (raw === '') return null;
  const withScheme = SCHEME_RE.test(raw) ? raw : `http://${raw}`;
  try {
    return normalizeHost(new URL(withScheme).hostname);
  } catch {
    return null;
  }
}

/** Company domain from an email address; free-provider domains yield null. */
export function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const dom = normalizeHost(email.slice(at + 1));
  if (dom === null || FREE_EMAIL_DOMAINS.has(dom)) return null;
  return dom;
}

/** Candidate company domains for a row, url first then non-free email domain. */
export function deriveDomains(url: string | null, email: string | null): string[] {
  const out: string[] = [];
  if (url !== null) {
    const d = domainFromUrl(url);
    if (d !== null) out.push(d);
  }
  if (email !== null) {
    const d = domainFromEmail(email);
    if (d !== null && !out.includes(d)) out.push(d);
  }
  return out;
}

// --- Existing-lead index ----------------------------------------------------

export interface ExistingIndex {
  /** Existing lead id whose contact has this exact email, or null. */
  matchByEmail(email: string): string | null;
  /** Existing lead id owning this company domain, or null. */
  matchByDomain(domain: string): string | null;
  /** True when the email has an active (unreleased) suppression. */
  isSuppressed(email: string): boolean;
  /** Existing lead id whose name is `>= threshold` similar (pg_trgm), or null. */
  matchByFuzzyName(db: Db, name: string, threshold: number): Promise<string | null>;
}

interface JsonEmail {
  email?: unknown;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return (result as { rows: Record<string, unknown>[] }).rows;
}

/**
 * Load the pre-import snapshot into memory: domain→lead and email→lead maps plus
 * the active email-suppression set. One pass over live leads/contacts — bounded
 * by the existing dataset size (acceptable for an admin batch import; a
 * persisted normalized-domain index would remove the scan at large scale).
 */
export async function buildExistingIndex(db: Db): Promise<ExistingIndex> {
  const domainToLeadId = new Map<string, string>();
  const emailToLeadId = new Map<string, string>();
  const suppressed = new Set<string>();

  const leadRows = rowsOf(
    await db.execute(sql`SELECT id, url FROM ${leads} WHERE deleted_at IS NULL`),
  );
  for (const row of leadRows) {
    const id = String(row['id']);
    const url = row['url'];
    if (typeof url === 'string') {
      const d = domainFromUrl(url);
      if (d !== null && !domainToLeadId.has(d)) domainToLeadId.set(d, id);
    }
  }

  const contactRows = rowsOf(
    await db.execute(sql`SELECT lead_id, emails FROM ${contacts} WHERE deleted_at IS NULL`),
  );
  for (const row of contactRows) {
    const leadId = String(row['lead_id']);
    const emails = row['emails'];
    const list: JsonEmail[] = Array.isArray(emails)
      ? (emails as JsonEmail[])
      : typeof emails === 'string'
        ? (JSON.parse(emails) as JsonEmail[])
        : [];
    for (const entry of list) {
      if (typeof entry.email !== 'string') continue;
      const email = entry.email.toLowerCase();
      if (!emailToLeadId.has(email)) emailToLeadId.set(email, leadId);
      const d = domainFromEmail(email);
      if (d !== null && !domainToLeadId.has(d)) domainToLeadId.set(d, leadId);
    }
  }

  const suppRows = rowsOf(
    await db.execute(
      sql`SELECT value FROM ${suppressions} WHERE kind = 'email' AND released_at IS NULL`,
    ),
  );
  for (const row of suppRows) {
    if (typeof row['value'] === 'string') suppressed.add(row['value'].toLowerCase());
  }

  return {
    matchByEmail(email) {
      return emailToLeadId.get(email.toLowerCase()) ?? null;
    },
    matchByDomain(domain) {
      return domainToLeadId.get(domain.toLowerCase()) ?? null;
    },
    isSuppressed(email) {
      return suppressed.has(email.toLowerCase());
    },
    async matchByFuzzyName(db2, name, threshold) {
      const nameLower = normalizeName(name);
      if (nameLower === '') return null;
      const result = await db2.execute(sql`
        SELECT id
        FROM ${leads}
        WHERE deleted_at IS NULL
          AND similarity(lower(name), ${nameLower}) >= ${threshold}
        ORDER BY similarity(lower(name), ${nameLower}) DESC, id ASC
        LIMIT 1
      `);
      const rows = rowsOf(result);
      const first = rows[0];
      return first === undefined ? null : String(first['id']);
    },
  };
}

// --- Batched fuzzy name matching -------------------------------------------

/** Canonical fuzzy-match key for a company name (trim + lowercase). */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve the best existing-lead trigram match for MANY candidate names in one
 * round-trip (used by the dry-run planner so a 10k-row import is a single fuzzy
 * query, not one-per-row). Returns `normalizeName(candidate) -> existing leadId`
 * for candidates scoring `>= threshold`. Only the pre-import snapshot is
 * consulted (deleted_at IS NULL); in-file near-duplicates are intentionally not
 * fuzzy-matched (that would be O(n²) and non-deterministic) — in-file dedupe is
 * exact-key only (see plan.ts).
 *
 * `similarity() >= threshold` is index-independent (the GIN trgm index backs the
 * `%` operator, not this) so cost is a seq scan of `leads` per distinct
 * candidate — fine against the bounded existing set an admin import dedupes
 * against; a persisted normalized-name index is the scale fix (see the snapshot
 * note above).
 */
export async function batchFuzzyMatch(
  db: Db,
  names: readonly string[],
  threshold: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = [...new Set(names.map(normalizeName).filter((n) => n !== ''))];
  if (distinct.length === 0) return out;

  // Candidates ride as a single JSON param (drizzle expands a JS array into
  // comma-separated params, not a `text[]`); JSON is escaping-safe for names
  // containing commas/quotes/braces.
  const result = await db.execute(sql`
    SELECT c.n AS candidate, m.id AS lead_id
    FROM json_array_elements_text(${JSON.stringify(distinct)}::json) AS c(n)
    CROSS JOIN LATERAL (
      SELECT ${leads.id} AS id
      FROM ${leads}
      WHERE ${leads.deletedAt} IS NULL
        AND similarity(lower(${leads.name}), c.n) >= ${threshold}
      ORDER BY similarity(lower(${leads.name}), c.n) DESC, ${leads.id} ASC
      LIMIT 1
    ) AS m
  `);
  for (const row of rowsOf(result)) {
    const candidate = row['candidate'];
    const leadId = row['lead_id'];
    if (typeof candidate === 'string' && typeof leadId === 'string') out.set(candidate, leadId);
  }
  return out;
}
