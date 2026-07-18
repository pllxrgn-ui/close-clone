/*
 * Builds the pre-import dedupe snapshot the planner queries — the demo-mode
 * equivalent of the server's `buildExistingIndex` (services/imports/dedupe.ts),
 * derived from a read-only view of the mock leads/contacts. Email → lead and
 * domain → lead are exact maps (first row wins); company-name matching runs the
 * trigram fuzzy matcher over the lead corpus. Suppression is a case-insensitive
 * set lookup.
 */
import { bestFuzzyMatch, type FuzzyCandidate } from './fuzzy.ts';
import { emailDomain, hostFromUrl, normalizeName } from './normalize.ts';
import type { ExistingIndex } from './planner.ts';

export interface IndexLead {
  id: string;
  name: string;
  url: string | null;
}
export interface IndexContact {
  leadId: string;
  emails: readonly string[];
}

export function buildExistingIndex(
  leads: readonly IndexLead[],
  contacts: readonly IndexContact[],
  suppressed: ReadonlySet<string>,
): ExistingIndex {
  const emailToLead = new Map<string, string>();
  const domainToLead = new Map<string, string>();
  const corpus: FuzzyCandidate[] = [];

  for (const lead of leads) {
    const host = hostFromUrl(lead.url);
    if (host && !domainToLead.has(host)) domainToLead.set(host, lead.id);
    const key = normalizeName(lead.name);
    if (key) corpus.push({ key, id: lead.id });
  }
  for (const contact of contacts) {
    for (const raw of contact.emails) {
      const email = raw.trim().toLowerCase();
      if (email && !emailToLead.has(email)) emailToLead.set(email, contact.leadId);
      const dom = emailDomain(email);
      if (dom && !domainToLead.has(dom)) domainToLead.set(dom, contact.leadId);
    }
  }

  const suppressedLower = new Set<string>();
  for (const s of suppressed) suppressedLower.add(s.toLowerCase());

  return {
    matchByEmail: (email) => emailToLead.get(email.toLowerCase()) ?? null,
    matchByDomain: (domain) => domainToLead.get(domain.toLowerCase()) ?? null,
    matchByName: (name, threshold) => bestFuzzyMatch(name, corpus, threshold),
    isSuppressed: (email) => suppressedLower.has(email.toLowerCase()),
  };
}
