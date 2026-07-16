import type {
  Contact,
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  Snippet,
  Template,
} from '@switchboard/shared';
import { apiRequest } from '../../../api/client.ts';
import type { OutboxMessage } from '../data/store.ts';

/** A lead's contacts (served by the leads feature's `/contacts?leadId=` handler). */
export function listLeadContacts(leadId: string, signal?: AbortSignal): Promise<Contact[]> {
  return apiRequest<Contact[]>('/contacts', {
    query: { leadId },
    ...(signal ? { signal } : {}),
  });
}

/*
 * Typed REST wrappers for the comms endpoints (CONTRACTS §C7). Thin — the mock
 * (commsHandlers) and, later, the real API own the shapes; this just names the
 * routes and threads AbortSignals through the shared apiRequest client.
 */

export function listTemplates(signal?: AbortSignal): Promise<Template[]> {
  return apiRequest<Template[]>('/templates', signal ? { signal } : {});
}

export function listSnippets(signal?: AbortSignal): Promise<Snippet[]> {
  return apiRequest<Snippet[]>('/snippets', signal ? { signal } : {});
}

/** Lead-scoped list of suppressed recipient emails (lowercased) — the rail signal. */
export function listSuppressedRecipients(
  leadId: string,
  signal?: AbortSignal,
): Promise<{ emails: string[] }> {
  return apiRequest<{ emails: string[] }>('/emails/suppressed-recipients', {
    query: { leadId },
    ...(signal ? { signal } : {}),
  });
}

export interface SendEmailInput {
  leadId: string;
  contactId: string | null;
  to: string[];
  subject: string;
  body: string;
}

export function sendEmail(input: SendEmailInput): Promise<{ message: OutboxMessage }> {
  return apiRequest<{ message: OutboxMessage }>('/emails/send', { method: 'POST', body: input });
}

export function listSequences(signal?: AbortSignal): Promise<Sequence[]> {
  return apiRequest<Sequence[]>('/sequences', signal ? { signal } : {});
}

export function listSequenceSteps(
  sequenceId?: string,
  signal?: AbortSignal,
): Promise<SequenceStep[]> {
  const query = sequenceId ? { sequenceId } : undefined;
  return apiRequest<SequenceStep[]>('/sequence-steps', {
    ...(query ? { query } : {}),
    ...(signal ? { signal } : {}),
  });
}

/** Bare enrollment row returned by the real `GET /sequences/:id/enrollments`
 *  (CONTRACTS §C7 `enrollmentsForSequence`): ids + lifecycle state, no display
 *  names. The `sequenceId` is the one queried (attached client-side). */
export interface SequenceEnrollmentRow {
  id: string;
  sequenceId: string;
  leadId: string;
  contactId: string;
  state: SequenceEnrollment['state'];
  pausedReason: string | null;
}

/** Real path (CONTRACTS §C7): `GET /sequences/:id/enrollments` → `{ items }`. */
export function listSequenceEnrollments(
  sequenceId: string,
  signal?: AbortSignal,
): Promise<SequenceEnrollmentRow[]> {
  return apiRequest<{ items: Omit<SequenceEnrollmentRow, 'sequenceId'>[] }>(
    `/sequences/${sequenceId}/enrollments`,
    signal ? { signal } : {},
  ).then((res) => res.items.map((row) => ({ ...row, sequenceId })));
}

/** Enriched enrollment row for the detail roster (enrollment + display names). */
export interface EnrollmentRow {
  id: string;
  sequenceId: string;
  leadId: string;
  contactId: string;
  state: SequenceEnrollment['state'];
  pausedReason: string | null;
  updatedAt: string;
  leadName: string;
  contactName: string;
  contactEmail: string;
}

export function listSequenceRoster(
  sequenceId: string,
  signal?: AbortSignal,
): Promise<EnrollmentRow[]> {
  return apiRequest<EnrollmentRow[]>(`/sequences/${sequenceId}/roster`, signal ? { signal } : {});
}

/** Enrolled target in the real bulk-enroll result (carries the new enrollment id). */
export interface EnrolledTarget {
  leadId: string;
  contactId: string;
  enrollmentId: string;
}

/** Skipped target in the real bulk-enroll result (soft-deleted / already-enrolled). */
export interface SkippedTarget {
  leadId: string;
  contactId: string;
  reason: string;
}

/** Real `POST /sequences/:id/enroll` result (CONTRACTS §C7 `EnrollResult`). */
export interface EnrollResult {
  enrolled: EnrolledTarget[];
  skipped: SkippedTarget[];
}

/**
 * Enroll ONE contact via the real bulk route: the engine only exposes a bulk
 * `{ targets: [...] }` enroll (which owns intent scheduling + the send-time
 * never-event rails), so a single enroll is a 1-element targets array. The result
 * reports the target under `enrolled` (with its new enrollment id) or `skipped`
 * (with a reason such as `already_enrolled`) — a duplicate/soft-deleted target is
 * NOT an HTTP error, so callers branch on the arrays, not a thrown status.
 */
export function enrollInSequence(
  sequenceId: string,
  target: { leadId: string; contactId: string },
): Promise<EnrollResult> {
  return apiRequest<EnrollResult>(`/sequences/${sequenceId}/enroll`, {
    method: 'POST',
    body: { targets: [target] },
  });
}

export function setEnrollmentState(
  enrollmentId: string,
  input: { state: 'active' | 'paused'; pausedReason?: string },
): Promise<SequenceEnrollment> {
  return apiRequest<SequenceEnrollment>(`/sequence-enrollments/${enrollmentId}`, {
    method: 'PATCH',
    body: input,
  });
}
