import type { Task } from '@switchboard/shared';
import { apiRequest } from '../../../api/client.ts';
import type { InboxChannel, InboxQueueResponse, InboxStats } from '../model/types.ts';
import { nowIso } from '../model/time.ts';

/*
 * Typed client for the Inbox surface. Every call goes through the shared C7 fetch
 * wrapper (`apiRequest`), so responses are camelCase JSON and non-2xx bodies
 * surface as typed `ApiError`s (C8). Actions with a C7 route use it (emails/send,
 * sms/send, tasks PATCH); the composed queue read + review/snooze actions use
 * inbox-scoped routes (flagged as contract friction in the task report).
 */

function withSignal(signal?: AbortSignal): { signal: AbortSignal } | Record<string, never> {
  return signal ? { signal } : {};
}

export function getInboxQueue(signal?: AbortSignal): Promise<InboxQueueResponse> {
  return apiRequest<InboxQueueResponse>('/inbox', withSignal(signal));
}

export function getInboxStats(signal?: AbortSignal): Promise<InboxStats> {
  return apiRequest<InboxStats>('/inbox/stats', withSignal(signal));
}

export interface SentMessage {
  id: string;
  threadId: string;
  direction: 'out';
  to: string;
  subject: string | null;
  sentAt: string;
}

export interface SendReplyInput {
  threadId: string;
  channel: InboxChannel;
  to: string;
  subject: string | null;
  body: string;
  leadId: string;
}

/** Send a reply — routes to POST /emails/send or POST /sms/send per channel (C7). */
export function sendReply(input: SendReplyInput): Promise<SentMessage> {
  if (input.channel === 'email') {
    return apiRequest<SentMessage>('/emails/send', {
      method: 'POST',
      body: {
        threadId: input.threadId,
        to: input.to,
        subject: input.subject,
        body: input.body,
        leadId: input.leadId,
      },
    });
  }
  return apiRequest<SentMessage>('/sms/send', {
    method: 'POST',
    body: {
      threadId: input.threadId,
      to: input.to,
      body: input.body,
      leadId: input.leadId,
    },
  });
}

/** Complete a task via PATCH /tasks/:id (C7 tasks CRUD). */
export function completeTask(taskId: string): Promise<Task> {
  return apiRequest<Task>(`/tasks/${taskId}`, {
    method: 'PATCH',
    body: { completedAt: nowIso() },
  });
}

export interface ReviewResult {
  id: string;
  state: string;
  disposition: string | null;
}

export function approveReview(intentId: string): Promise<ReviewResult> {
  return apiRequest<ReviewResult>(`/inbox/reviews/${intentId}/approve`, { method: 'POST' });
}

export function skipReview(intentId: string): Promise<ReviewResult> {
  return apiRequest<ReviewResult>(`/inbox/reviews/${intentId}/skip`, { method: 'POST' });
}

export interface SnoozeResult {
  id: string;
  snoozedUntil: string;
}

export function snoozeItem(itemId: string): Promise<SnoozeResult> {
  return apiRequest<SnoozeResult>('/inbox/snooze', { method: 'POST', body: { itemId } });
}
