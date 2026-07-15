/**
 * Merge-tag renderer (task 2d, CONTRACTS §C6 send-safety spirit).
 *
 * Templates and one-off bodies carry `{{ field }}` merge tags that resolve from a
 * lead / contact / user context at SEND time. Two hard rules:
 *
 *   1. An unresolved REQUIRED tag is a failure (`MergeRenderError` →
 *      VALIDATION_FAILED). A message is NEVER sent with a raw `{{tag}}` the author
 *      meant to fill — the renderer throws instead of emitting braces.
 *   2. Substitution is injection-safe. Field values (which can be attacker-
 *      controlled — e.g. a contact name set by an external party) are HTML-escaped
 *      in `html` output, and are NEVER re-scanned for further tags in ANY mode
 *      (single pass). So a value cannot smuggle `<script>` or a second merge tag
 *      (`{{user.email}}`) into another rep's rendered view of a shared template.
 *
 * The template TEXT itself is authored content (the layout) and is emitted
 * verbatim; only the substituted VALUES are treated as untrusted data. This is the
 * standard "template = code, values = data" separation.
 *
 * Tag grammar: `{{ path }}` or `{{ path | fallback }}`. `path` is a dotted field
 * reference (`lead.name`, `contact.email`, `user.name`, `lead.custom.<key>`).
 * `fallback` (optional) is literal text used when the field resolves empty.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface MergeLead {
  name: string;
  url?: string | null;
  description?: string | null;
  custom?: Record<string, unknown> | null;
}

export interface MergeContact {
  name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface MergeUser {
  name?: string | null;
  email?: string | null;
}

export interface MergeContext {
  lead: MergeLead;
  contact?: MergeContact | null;
  user?: MergeUser | null;
}

export type RenderFormat = 'text' | 'html';

/** Unresolved required merge tag(s): maps to VALIDATION_FAILED at the route. */
export class MergeRenderError extends Error {
  readonly unresolved: string[];
  constructor(unresolved: string[]) {
    super(`unresolved merge tag(s): ${unresolved.join(', ')}`);
    this.name = 'MergeRenderError';
    this.unresolved = unresolved;
  }
}

// `[^{}]` keeps a tag from swallowing an adjacent `{{`/`}}`; the value inserted in
// its place is never matched again because String.replace does a single pass.
const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Resolve a dotted field path against the context. Returns the string value (may
 * be empty) or `null` when the path is unknown / the branch of context is absent.
 * An empty-but-known field returns `''` (the caller decides fallback vs. error).
 */
function resolveField(path: string, ctx: MergeContext): string | null {
  const segments = path.split('.').map((s) => s.trim());
  const head = segments[0];

  if (head === 'lead') {
    const key = segments[1];
    if (key === 'name') return ctx.lead.name;
    if (key === 'url') return asString(ctx.lead.url);
    if (key === 'description') return asString(ctx.lead.description);
    if (key === 'custom') {
      const customKey = segments.slice(2).join('.');
      if (customKey.length === 0) return null;
      const custom = ctx.lead.custom ?? {};
      if (!Object.prototype.hasOwnProperty.call(custom, customKey)) return null;
      return asString(custom[customKey]);
    }
    return null;
  }

  if (head === 'contact') {
    const contact = ctx.contact;
    if (contact === null || contact === undefined) return null;
    const key = segments[1];
    if (key === 'name') return asString(contact.name);
    if (key === 'title') return asString(contact.title);
    if (key === 'email') return asString(contact.email);
    if (key === 'phone') return asString(contact.phone);
    return null;
  }

  if (head === 'user') {
    const user = ctx.user;
    if (user === null || user === undefined) return null;
    const key = segments[1];
    if (key === 'name') return asString(user.name);
    if (key === 'email') return asString(user.email);
    return null;
  }

  return null;
}

/** Render one string, collecting unresolved tag paths into `unresolved`. */
function renderOne(
  template: string,
  ctx: MergeContext,
  format: RenderFormat,
  unresolved: string[],
): string {
  return template.replace(TAG_RE, (_match, inner: string) => {
    const pipe = inner.indexOf('|');
    const path = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const hasFallback = pipe >= 0;
    const fallback = hasFallback ? inner.slice(pipe + 1).trim() : '';

    const resolved = resolveField(path, ctx);
    let value: string;
    if (resolved !== null && resolved.length > 0) {
      value = resolved;
    } else if (hasFallback) {
      value = fallback;
    } else {
      unresolved.push(path);
      return '';
    }
    return format === 'html' ? escapeHtml(value) : value;
  });
}

export interface RenderInput {
  subject?: string | null;
  body: string;
}

export interface RenderOptions {
  format?: RenderFormat;
}

export interface RenderedTemplate {
  subject?: string;
  body: string;
}

/**
 * Render a subject + body against the merge context. Throws {@link MergeRenderError}
 * (never emits raw braces) if ANY required tag is unresolved across either field.
 * `format: 'html'` HTML-escapes substituted values; the default `'text'` does not
 * (text/plain cannot execute), but neither mode re-expands substituted values.
 */
export function renderTemplate(
  input: RenderInput,
  ctx: MergeContext,
  options: RenderOptions = {},
): RenderedTemplate {
  const format: RenderFormat = options.format ?? 'text';
  const unresolved: string[] = [];

  const hasSubject = input.subject !== null && input.subject !== undefined;
  const subject = hasSubject ? renderOne(input.subject as string, ctx, format, unresolved) : undefined;
  const body = renderOne(input.body, ctx, format, unresolved);

  if (unresolved.length > 0) throw new MergeRenderError(unresolved);

  return subject === undefined ? { body } : { subject, body };
}
