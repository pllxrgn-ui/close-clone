import type { Contact, Lead, User } from '@switchboard/shared';

/*
 * Merge-tag resolution — the pure core the composer builds on. A template body
 * (or subject, or snippet) carries `{{ dotted.key }}` tags; resolution against a
 * flat MergeContext turns each into either a resolved value or a visible
 * UNRESOLVED token. The composer renders unresolved tokens in the amber "draft"
 * state and disables Send while any remain (parallels the server merge-tag gate
 * proven in Task 2d — an unresolved tag must never reach a recipient).
 *
 * Deliberately dependency-free and side-effect-free so it is exhaustively unit
 * testable; the UI layer only maps segments → DOM.
 */

/** A flat map of dotted merge keys to their resolved string value. */
export type MergeContext = Record<string, string>;

export type MergeSegment =
  | { kind: 'text'; value: string }
  | { kind: 'tag'; raw: string; key: string; resolved: boolean; value: string };

/** One entry in the insertable/known-tag catalog (drives the composer legend). */
export interface MergeTagInfo {
  key: string;
  label: string;
  example: string;
}

/**
 * The tags the mock data can resolve. Order is display order in the picker.
 * (The real API's field catalog is broader; this is the demo-resolvable subset.)
 */
export const MERGE_TAG_CATALOG: readonly MergeTagInfo[] = [
  { key: 'contact.first_name', label: 'Contact first name', example: 'Sam' },
  { key: 'contact.name', label: 'Contact full name', example: 'Sam Patel' },
  { key: 'contact.email', label: 'Contact email', example: 'sam@northlabs.example.com' },
  { key: 'lead.name', label: 'Company', example: 'North Labs' },
  { key: 'owner.name', label: 'Your name', example: 'Ben Reyes' },
];

// Tags are `{{ key }}`; key is dotted lower identifiers. Whitespace tolerant.
const TAG_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** True when a context value counts as present (non-empty after trim). */
function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Split `text` into literal + tag segments, resolving each tag against `ctx`.
 * A tag is resolved iff its key is present in `ctx` with a non-empty value;
 * unknown keys and empty values are both unresolved (Send stays blocked).
 */
export function parseMergeTemplate(text: string, ctx: MergeContext): MergeSegment[] {
  const segments: MergeSegment[] = [];
  let lastIndex = 0;
  // Fresh regex state per call (TAG_RE is global/stateful).
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(text)) !== null) {
    const [raw, key] = match;
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    const resolvedValue = ctx[key ?? ''];
    if (isPresent(resolvedValue)) {
      segments.push({ kind: 'tag', raw, key: key ?? '', resolved: true, value: resolvedValue });
    } else {
      segments.push({ kind: 'tag', raw, key: key ?? '', resolved: false, value: '' });
    }
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

/** The distinct unresolved keys in a segment list (deduped, in first-seen order). */
export function unresolvedKeys(segments: MergeSegment[]): string[] {
  const seen = new Set<string>();
  for (const seg of segments) {
    if (seg.kind === 'tag' && !seg.resolved) seen.add(seg.key);
  }
  return [...seen];
}

/** True when the text has at least one tag that cannot be resolved from ctx. */
export function hasUnresolved(text: string, ctx: MergeContext): boolean {
  return unresolvedKeys(parseMergeTemplate(text, ctx)).length > 0;
}

/**
 * Flatten to a plain string with resolved tags substituted. Unresolved tags are
 * kept verbatim (`{{key}}`) — callers must gate Send on {@link hasUnresolved}
 * so an unresolved tag never actually ships.
 */
export function renderMergeTemplate(text: string, ctx: MergeContext): string {
  return parseMergeTemplate(text, ctx)
    .map((seg) => (seg.kind === 'text' ? seg.value : seg.resolved ? seg.value : seg.raw))
    .join('');
}

/** First whitespace-delimited token of a name, or '' when absent. */
export function firstName(name: string | null | undefined): string {
  if (!name) return '';
  return name.trim().split(/\s+/)[0] ?? '';
}

/** Primary email for a contact (first entry), or '' when none. */
export function primaryEmail(contact: Pick<Contact, 'emails'> | null | undefined): string {
  return contact?.emails?.[0]?.email ?? '';
}

/**
 * Build the resolution context from the records the composer already holds.
 * Missing pieces (e.g. no contact selected yet) map to '' so their tags read as
 * unresolved rather than silently blank.
 */
export function buildMergeContext(input: {
  lead: Pick<Lead, 'name'> | null | undefined;
  contact: Pick<Contact, 'name' | 'emails'> | null | undefined;
  owner: Pick<User, 'name'> | null | undefined;
}): MergeContext {
  const { lead, contact, owner } = input;
  return {
    'lead.name': lead?.name ?? '',
    company: lead?.name ?? '',
    'contact.name': contact?.name ?? '',
    'contact.first_name': firstName(contact?.name),
    'contact.email': primaryEmail(contact),
    'owner.name': owner?.name ?? '',
    'sender.name': owner?.name ?? '',
  };
}
