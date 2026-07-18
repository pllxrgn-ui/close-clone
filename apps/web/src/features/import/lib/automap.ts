/*
 * Smart column auto-mapping for the Map step's first render: guess a target for
 * each header from its name, so a well-formed export is mapped on arrival and the
 * operator only fixes exceptions. Alias table for builtins → lead/contact fields,
 * then a fall-through match against the lead custom-field keys/labels, else
 * `ignore`. A builtin target is never assigned twice (the second header ignores).
 */
import { IGNORE_TARGET } from './mapping.ts';
import { normalizeName } from './normalize.ts';
import type { ImportColumn } from '../types.ts';

/** Normalized header → builtin target string. */
const ALIASES: Record<string, string> = {
  company: 'lead.name',
  'company name': 'lead.name',
  account: 'lead.name',
  'account name': 'lead.name',
  organization: 'lead.name',
  organisation: 'lead.name',
  business: 'lead.name',
  name: 'lead.name',
  website: 'lead.url',
  'web site': 'lead.url',
  url: 'lead.url',
  domain: 'lead.url',
  site: 'lead.url',
  homepage: 'lead.url',
  description: 'lead.description',
  about: 'lead.description',
  summary: 'lead.description',
  dnc: 'lead.dnc',
  'do not contact': 'lead.dnc',
  'do not call': 'lead.dnc',
  status: 'lead.status',
  'lead status': 'lead.status',
  stage: 'lead.status',
  owner: 'lead.owner',
  'account owner': 'lead.owner',
  'lead owner': 'lead.owner',
  rep: 'lead.owner',
  'assigned to': 'lead.owner',
  assignee: 'lead.owner',
  contact: 'contact.name',
  'contact name': 'contact.name',
  'full name': 'contact.name',
  person: 'contact.name',
  'primary contact': 'contact.name',
  title: 'contact.title',
  'job title': 'contact.title',
  role: 'contact.title',
  position: 'contact.title',
  email: 'contact.email',
  'email address': 'contact.email',
  'e mail': 'contact.email',
  'e mail address': 'contact.email',
  'contact email': 'contact.email',
  'work email': 'contact.email',
  phone: 'contact.phone',
  'phone number': 'contact.phone',
  mobile: 'contact.phone',
  telephone: 'contact.phone',
  tel: 'contact.phone',
  cell: 'contact.phone',
  'contact phone': 'contact.phone',
};

export interface AutoMapCustomField {
  key: string;
  label: string;
}

/** Guess a target for every header; a builtin is claimed at most once. */
export function autoMap(
  headers: readonly string[],
  customFields: readonly AutoMapCustomField[],
): ImportColumn[] {
  const customByNorm = new Map<string, string>();
  for (const f of customFields) {
    customByNorm.set(normalizeName(f.key), `custom.${f.key}`);
    customByNorm.set(normalizeName(f.label), `custom.${f.key}`);
  }

  const usedBuiltins = new Set<string>();
  return headers.map((source) => {
    const norm = normalizeName(source);
    const alias = ALIASES[norm];
    if (alias !== undefined) {
      if (usedBuiltins.has(alias)) return { source, target: IGNORE_TARGET };
      usedBuiltins.add(alias);
      return { source, target: alias };
    }
    const custom = customByNorm.get(norm);
    if (custom !== undefined) return { source, target: custom };
    return { source, target: IGNORE_TARGET };
  });
}
