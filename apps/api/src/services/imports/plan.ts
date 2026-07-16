import { isBlankRecord, type CsvRecord } from './csv.ts';
import { deriveDomains, normalizeName, type ExistingIndex } from './dedupe.ts';
import { buildHeaderIndex, mapRecord, type MappedRow, type MappingContext } from './mapping.ts';
import {
  emptyCounts,
  type DedupeConfig,
  type ImportMapping,
  type ImportPlan,
  type MatchType,
  type PlannedContact,
  type PlannedLead,
  type RowError,
  type RowPlan,
} from './types.ts';

/**
 * Dry-run planner (Task 4f). Consumes the parsed record stream and, with the
 * pre-import dedupe snapshot + batched fuzzy matches, decides every row's
 * disposition (create-lead / create-contact / dedupe-hit+action / error / empty)
 * and pre-assigns the ids the committer will write. It performs NO database
 * writes — the same `ImportPlan` is persisted to `imports.dry_run_result` and
 * replayed verbatim at commit, which is what makes dedupe decisions identical in
 * dry-run and commit (CONTRACTS acceptance: "identical in dry-run and commit").
 *
 * Dedupe priority per row: existing contact-email (exact) → existing company
 * domain → existing fuzzy company name → in-file email → in-file domain. Fuzzy
 * matching is snapshot-only (never in-file); in-file dedupe is exact-key only so
 * decisions stay deterministic and off the O(n²) path.
 *
 * Import-safe for direct `node` execution (no enums / namespaces).
 */

/** Resolves best existing-lead fuzzy matches for a batch of candidate names. */
export type FuzzyResolver = (names: string[], threshold: number) => Promise<Map<string, string>>;

export interface PlanDeps {
  mapping: ImportMapping;
  dedupe: DedupeConfig;
  ctx: MappingContext;
  /** In-memory pre-import snapshot (email/domain/suppression lookups). */
  existing: ExistingIndex;
  /** Batched fuzzy resolver (wired to `batchFuzzyMatch` in production). */
  fuzzy: FuzzyResolver;
  newLeadId: () => string;
  newContactId: () => string;
}

interface CollectedRow {
  rowIndex: number;
  blank: boolean;
  mapped: MappedRow | null;
}

function missingNameError(): RowError {
  return {
    column: null,
    target: null,
    code: 'missing_lead_name',
    message: 'row has no lead name and no dedupe match to attach to',
    value: null,
  };
}

/** True when a mapped contact carries any usable data worth importing. */
function contactHasData(mapped: MappedRow): boolean {
  const c = mapped.contact;
  return c.name !== null || c.email !== null || c.phone !== null || c.title !== null;
}

function buildPlannedLead(id: string, mapped: MappedRow): PlannedLead {
  const l = mapped.lead;
  return {
    id,
    name: l.name,
    url: l.url,
    description: l.description,
    dnc: l.dnc ?? false,
    statusId: l.statusId,
    ownerId: l.ownerId,
    custom: l.custom,
  };
}

function buildPlannedContact(id: string, mapped: MappedRow, suppressed: boolean): PlannedContact {
  const c = mapped.contact;
  // contacts.name is NOT NULL: fall back through email/phone/title.
  const name = c.name ?? c.email ?? c.phone ?? c.title ?? 'Unknown';
  return { id, name, title: c.title, email: c.email, phone: c.phone, suppressed };
}

interface Match {
  leadId: string;
  matchType: MatchType;
}

/**
 * Build the full import plan from the parsed records. The first record is the
 * header row; every subsequent record is a 1-based data row.
 */
export async function buildPlan(
  records: AsyncIterable<CsvRecord>,
  deps: PlanDeps,
): Promise<ImportPlan> {
  const { mapping, dedupe, ctx, existing, fuzzy, newLeadId, newContactId } = deps;
  const warnings: string[] = [];

  // --- Phase 1: header + streaming map --------------------------------------
  const iter = records[Symbol.asyncIterator]();
  const firstResult = await iter.next();
  if (firstResult.done === true) {
    return { version: 1, counts: emptyCounts(), rows: [], warnings: ['file has no header row'] };
  }
  const { index, duplicates } = buildHeaderIndex(firstResult.value);
  for (const dup of duplicates) warnings.push(`duplicate header "${dup}" — first occurrence used`);
  for (const col of mapping.columns) {
    if (col.target !== 'ignore' && !index.has(col.source.trim())) {
      warnings.push(`mapped source header "${col.source}" is not present in the file`);
    }
  }

  const collected: CollectedRow[] = [];
  let rowIndex = 0;
  for (;;) {
    const next = await iter.next();
    if (next.done === true) break;
    rowIndex += 1;
    const record = next.value;
    if (isBlankRecord(record)) {
      collected.push({ rowIndex, blank: true, mapped: null });
      continue;
    }
    collected.push({ rowIndex, blank: false, mapped: mapRecord(record, index, mapping, ctx) });
  }

  // --- Phase 2: one batched fuzzy query for all candidate names -------------
  let fuzzyMap = new Map<string, string>();
  if (dedupe.matchOn.fuzzyName) {
    const names: string[] = [];
    for (const row of collected) {
      if (row.mapped && row.mapped.errors.length === 0 && row.mapped.lead.name !== null) {
        names.push(row.mapped.lead.name);
      }
    }
    fuzzyMap = await fuzzy(names, dedupe.fuzzyNameThreshold);
  }

  // --- Phase 3: sequential planning (in-memory, layers in-file matches) -----
  const counts = emptyCounts();
  const rows: RowPlan[] = [];
  const inFileEmail = new Map<string, string>();
  const inFileDomain = new Map<string, string>();

  const registerInFile = (leadId: string, email: string | null, domains: string[]): void => {
    if (email !== null && !inFileEmail.has(email)) inFileEmail.set(email, leadId);
    for (const d of domains) if (!inFileDomain.has(d)) inFileDomain.set(d, leadId);
  };

  const findMatch = (
    email: string | null,
    domains: string[],
    leadName: string | null,
  ): Match | null => {
    if (dedupe.matchOn.email && email !== null) {
      const hit = existing.matchByEmail(email);
      if (hit !== null) return { leadId: hit, matchType: 'email' };
    }
    if (dedupe.matchOn.domain) {
      for (const d of domains) {
        const hit = existing.matchByDomain(d);
        if (hit !== null) return { leadId: hit, matchType: 'domain' };
      }
    }
    if (dedupe.matchOn.fuzzyName && leadName !== null) {
      const hit = fuzzyMap.get(normalizeName(leadName));
      if (hit !== undefined) return { leadId: hit, matchType: 'fuzzy-name' };
    }
    if (dedupe.matchOn.email && email !== null) {
      const hit = inFileEmail.get(email);
      if (hit !== undefined) return { leadId: hit, matchType: 'email' };
    }
    if (dedupe.matchOn.domain) {
      for (const d of domains) {
        const hit = inFileDomain.get(d);
        if (hit !== undefined) return { leadId: hit, matchType: 'domain' };
      }
    }
    return null;
  };

  const countMatch = (t: MatchType): void => {
    if (t === 'email') counts.matchedByEmail += 1;
    else if (t === 'domain') counts.matchedByDomain += 1;
    else counts.matchedByFuzzyName += 1;
  };

  const emptyPlan = (i: number): RowPlan => ({
    rowIndex: i,
    outcome: 'empty',
    action: null,
    matchType: null,
    leadCreated: false,
    contactCreated: false,
    targetLeadId: null,
    lead: null,
    contact: null,
    errors: [],
    suppressedEmails: [],
  });

  const errorPlan = (i: number, errors: RowError[]): RowPlan => ({
    rowIndex: i,
    outcome: 'error',
    action: null,
    matchType: null,
    leadCreated: false,
    contactCreated: false,
    targetLeadId: null,
    lead: null,
    contact: null,
    errors,
    suppressedEmails: [],
  });

  for (const row of collected) {
    counts.totalRows += 1;

    if (row.blank || row.mapped === null) {
      counts.emptyRows += 1;
      rows.push(emptyPlan(row.rowIndex));
      continue;
    }
    const mapped = row.mapped;
    if (mapped.errors.length > 0) {
      counts.errorRows += 1;
      rows.push(errorPlan(row.rowIndex, mapped.errors));
      continue;
    }

    const email = mapped.contact.email;
    const domains = deriveDomains(mapped.lead.url, mapped.contact.email);
    const leadName = mapped.lead.name;
    const suppressed = email !== null && existing.isSuppressed(email);
    const hasContact = contactHasData(mapped);
    const match = findMatch(email, domains, leadName);

    // --- No dedupe match: create a lead (requires a name) -------------------
    if (match === null) {
      if (leadName === null) {
        counts.errorRows += 1;
        rows.push(errorPlan(row.rowIndex, [missingNameError()]));
        continue;
      }
      const leadId = newLeadId();
      const contact = hasContact ? buildPlannedContact(newContactId(), mapped, suppressed) : null;
      registerInFile(leadId, email, domains);
      counts.leadsCreated += 1;
      if (contact !== null) counts.contactsCreated += 1;
      if (contact !== null && suppressed) counts.suppressedContacts += 1;
      rows.push({
        rowIndex: row.rowIndex,
        outcome: 'create',
        action: null,
        matchType: null,
        leadCreated: true,
        contactCreated: contact !== null,
        targetLeadId: leadId,
        lead: buildPlannedLead(leadId, mapped),
        contact,
        errors: [],
        suppressedEmails: contact !== null && suppressed && email !== null ? [email] : [],
      });
      continue;
    }

    // --- Dedupe match: apply the configured action -------------------------
    countMatch(match.matchType);

    if (dedupe.action === 'skip') {
      counts.dedupeSkipped += 1;
      rows.push({
        rowIndex: row.rowIndex,
        outcome: 'dedupe',
        action: 'skip',
        matchType: match.matchType,
        leadCreated: false,
        contactCreated: false,
        targetLeadId: match.leadId,
        lead: null,
        contact: null,
        errors: [],
        suppressedEmails: [],
      });
      continue;
    }

    if (dedupe.action === 'create-anyway') {
      if (leadName === null) {
        // Undo the match count — this row is an error, not a matched create.
        if (match.matchType === 'email') counts.matchedByEmail -= 1;
        else if (match.matchType === 'domain') counts.matchedByDomain -= 1;
        else counts.matchedByFuzzyName -= 1;
        counts.errorRows += 1;
        rows.push(errorPlan(row.rowIndex, [missingNameError()]));
        continue;
      }
      const leadId = newLeadId();
      const contact = hasContact ? buildPlannedContact(newContactId(), mapped, suppressed) : null;
      registerInFile(leadId, email, domains);
      counts.leadsCreated += 1;
      counts.dedupeCreateAnyway += 1;
      if (contact !== null) counts.contactsCreated += 1;
      if (contact !== null && suppressed) counts.suppressedContacts += 1;
      rows.push({
        rowIndex: row.rowIndex,
        outcome: 'create',
        action: 'create-anyway',
        matchType: match.matchType,
        leadCreated: true,
        contactCreated: contact !== null,
        targetLeadId: leadId,
        lead: buildPlannedLead(leadId, mapped),
        contact,
        errors: [],
        suppressedEmails: contact !== null && suppressed && email !== null ? [email] : [],
      });
      continue;
    }

    // action === 'merge-fields': attach to the matched lead, fill empty fields.
    // A match BY email means the contact email already lives on that lead, so no
    // new contact is created (avoids a duplicate contact); domain/fuzzy matches
    // attach the (new-to-that-lead) contact.
    counts.dedupeMerged += 1;
    const createContact = hasContact && match.matchType !== 'email';
    const contact = createContact ? buildPlannedContact(newContactId(), mapped, suppressed) : null;
    if (contact !== null) counts.contactsCreated += 1;
    if (contact !== null && suppressed) counts.suppressedContacts += 1;
    rows.push({
      rowIndex: row.rowIndex,
      outcome: 'dedupe',
      action: 'merge-fields',
      matchType: match.matchType,
      leadCreated: false,
      contactCreated: contact !== null,
      targetLeadId: match.leadId,
      lead: buildPlannedLead(match.leadId, mapped),
      contact,
      errors: [],
      suppressedEmails: contact !== null && suppressed && email !== null ? [email] : [],
    });
  }

  return { version: 1, counts, rows, warnings };
}
