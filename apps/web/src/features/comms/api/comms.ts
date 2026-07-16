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

export function listSequenceEnrollments(
  sequenceId?: string,
  signal?: AbortSignal,
): Promise<SequenceEnrollment[]> {
  const query = sequenceId ? { sequenceId } : undefined;
  return apiRequest<SequenceEnrollment[]>('/sequence-enrollments', {
    ...(query ? { query } : {}),
    ...(signal ? { signal } : {}),
  });
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

export function enrollInSequence(
  sequenceId: string,
  input: { leadId: string; contactId: string },
): Promise<SequenceEnrollment> {
  return apiRequest<SequenceEnrollment>(`/sequences/${sequenceId}/enroll`, {
    method: 'POST',
    body: input,
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
