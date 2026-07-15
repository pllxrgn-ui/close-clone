import { describe, expect, test } from 'vitest';
import { MergeRenderError, renderTemplate, type MergeContext } from './merge.ts';

/**
 * Merge-tag renderer (task 2d). Tags resolve from lead/contact/user context; an
 * unresolved REQUIRED tag is a hard failure (never sent with raw braces); and the
 * substitution is injection-safe — values are HTML-escaped in html output and are
 * NEVER re-scanned for further tags, so a field value cannot smuggle markup or a
 * second merge tag into another rep's view.
 */

function ctx(overrides: Partial<MergeContext> = {}): MergeContext {
  return {
    lead: { name: 'Acme Corp', url: 'https://acme.test', description: null, custom: { tier: 'gold' } },
    contact: { name: 'Dana Reyes', title: 'VP Eng', email: 'dana@acme.test', phone: null },
    user: { name: 'Rep One', email: 'rep@switchboard.test' },
    ...overrides,
  };
}

describe('renderTemplate — resolution', () => {
  test('resolves lead/contact/user tags in subject and body', () => {
    const out = renderTemplate(
      { subject: 'Hi {{contact.name}} at {{lead.name}}', body: 'From {{user.name}} — {{contact.email}}' },
      ctx(),
    );
    expect(out.subject).toBe('Hi Dana Reyes at Acme Corp');
    expect(out.body).toBe('From Rep One — dana@acme.test');
    expect(out.body).not.toContain('{{');
  });

  test('resolves lead custom fields', () => {
    const out = renderTemplate({ body: 'Tier: {{lead.custom.tier}}' }, ctx());
    expect(out.body).toBe('Tier: gold');
  });

  test('tolerates surrounding whitespace inside the braces', () => {
    const out = renderTemplate({ body: '{{  lead.name  }}' }, ctx());
    expect(out.body).toBe('Acme Corp');
  });

  test('applies a | fallback when the field is empty', () => {
    const out = renderTemplate({ body: 'Hello {{contact.title | there}}' }, {
      ...ctx(),
      contact: { name: 'X', title: null, email: 'x@y.z', phone: null },
    });
    expect(out.body).toBe('Hello there');
  });
});

describe('renderTemplate — required-tag failure (VALIDATION_FAILED)', () => {
  test('throws MergeRenderError listing unresolved tags, never emitting braces', () => {
    let err: unknown;
    try {
      renderTemplate({ subject: 'x', body: 'Hi {{contact.title}} — {{lead.custom.missing}}' }, {
        ...ctx(),
        contact: { name: 'X', title: null, email: 'x@y.z', phone: null },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MergeRenderError);
    expect((err as MergeRenderError).unresolved).toEqual(
      expect.arrayContaining(['contact.title', 'lead.custom.missing']),
    );
  });

  test('an unknown field path is unresolved', () => {
    expect(() => renderTemplate({ body: '{{lead.bogus}}' }, ctx())).toThrow(MergeRenderError);
  });

  test('a contact tag with no contact in context is unresolved', () => {
    expect(() => renderTemplate({ body: '{{contact.name}}' }, { ...ctx(), contact: null })).toThrow(
      MergeRenderError,
    );
  });
});

describe('renderTemplate — injection safety', () => {
  test('html mode escapes markup in field values', () => {
    const out = renderTemplate({ body: 'Name: {{contact.name}}' }, {
      ...ctx(),
      contact: { name: '<script>alert(1)</script>', title: 't', email: 'e@x.y', phone: null },
    }, { format: 'html' });
    expect(out.body).toBe('Name: &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.body).not.toContain('<script>');
  });

  test('a value containing a merge tag is NOT re-expanded (single pass)', () => {
    // A malicious contact name that looks like a tag must stay literal data and
    // must not resolve to the rep's email in another rep's rendered view.
    const out = renderTemplate({ body: '{{contact.name}}' }, {
      ...ctx(),
      contact: { name: '{{user.email}}', title: 't', email: 'e@x.y', phone: null },
    });
    expect(out.body).toBe('{{user.email}}');
    expect(out.body).not.toContain('rep@switchboard.test');
  });

  test('html mode escapes quotes and ampersands in values', () => {
    const out = renderTemplate({ body: '{{contact.name}}' }, {
      ...ctx(),
      contact: { name: `A&B "co" 'x'`, title: 't', email: 'e@x.y', phone: null },
    }, { format: 'html' });
    expect(out.body).toBe('A&amp;B &quot;co&quot; &#39;x&#39;');
  });

  test('text mode does not escape but also does not re-expand', () => {
    const out = renderTemplate({ body: '{{contact.name}}' }, {
      ...ctx(),
      contact: { name: 'A & B <tag> {{lead.name}}', title: 't', email: 'e@x.y', phone: null },
    });
    expect(out.body).toBe('A & B <tag> {{lead.name}}');
  });
});
