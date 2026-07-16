import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.ts';

/**
 * Phone-number helpers for the telephony ingress/dial paths (task 3b). Twilio
 * delivers E.164 (`+13055550147`); stored `contacts.phones` numbers may carry
 * formatting. Matching compares the trailing 10 digits (the US NANP significant
 * digits) so `+1 (305) 555-0147`, `3055550147`, and `+13055550147` all resolve to
 * the same contact — a documented v1 approximation (non-NANP numbers with a shared
 * 10-digit suffix could collide; revisit only with a rep-facing complaint).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Trailing-10-digit match key for a phone number (empty when < 10 digits). */
export function phoneMatchKey(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

export interface ContactMatch {
  leadId: string;
  contactId: string;
}

/**
 * Resolve the (live) contact + lead a phone number belongs to, or null. Matches on
 * the trailing-10-digit key against every number in `contacts.phones`; both the
 * contact and its lead must be non-soft-deleted. Deterministic (oldest contact
 * first) when several match.
 */
export async function resolveContactByPhone(db: Db, phone: string): Promise<ContactMatch | null> {
  const key = phoneMatchKey(phone);
  if (key === '') return null;
  const result = await db.execute(sql`
    SELECT c.id AS contact_id, c.lead_id AS lead_id
    FROM contacts c
    JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
    CROSS JOIN LATERAL jsonb_array_elements(c.phones) AS elem
    WHERE c.deleted_at IS NULL
      AND right(regexp_replace(elem->>'phone', '[^0-9]', '', 'g'), 10) = ${key}
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT 1
  `);
  const rows = (result as { rows: Record<string, unknown>[] }).rows;
  const row = rows[0];
  if (row === undefined) return null;
  return { leadId: String(row['lead_id']), contactId: String(row['contact_id']) };
}
