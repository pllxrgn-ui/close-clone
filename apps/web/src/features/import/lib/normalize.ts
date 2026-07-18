/*
 * Normalization helpers shared by the demo-mode planner and the dedupe index, so
 * a candidate row and an existing lead are keyed identically. Mirrors the server
 * engine's intent (services/imports/dedupe.ts `deriveDomains` / `normalizeName`):
 * domain matching is host-based, name matching is punctuation-insensitive.
 */

/** Bare lowercased host of a url (scheme, path, query, and a leading www removed). */
export function hostFromUrl(url: string | null): string {
  if (!url) return '';
  let s = url.trim();
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.toLowerCase().replace(/^www\./, '');
  return s;
}

/** Lowercased domain part of an email address, or '' when malformed. */
export function emailDomain(email: string | null): string {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/** Unique, non-empty domains a row contributes (from its url and its email). */
export function deriveDomains(url: string | null, email: string | null): string[] {
  const out: string[] = [];
  const host = hostFromUrl(url);
  if (host) out.push(host);
  const mail = emailDomain(email);
  if (mail && !out.includes(mail)) out.push(mail);
  return out;
}

/** Punctuation-insensitive, whitespace-collapsed lowercase company name key. */
export function normalizeName(name: string | null): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
