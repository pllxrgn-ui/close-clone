import type {
  Ast,
  Call,
  EmailDraft,
  EmailThreadContext,
  SmartViewFieldCatalog,
} from '@switchboard/shared';
import { BUILTIN_FIELD_NAMES } from '@switchboard/shared';
import { apiRequest } from '../../../api/client.ts';

/*
 * Typed REST wrappers for the AI feature surface. Shapes match the REAL routes in
 * apps/api/src/routes/ai.ts EXACTLY (CONTRACTS §I-AI, ARCHITECTURE §7), so MSW is a
 * drop-in for the demo and real mode works unchanged at cutover:
 *
 *   POST /ai/smart-view          → { dsl, ast }            (invalid DSL = 400 VALIDATION_FAILED)
 *   POST /ai/email-drafts        → { subject?, body }      (never auto-sent — the human sends)
 *   POST /ai/call-summaries      → CallSummaryDraft        (a DRAFT note; no timeline event)
 *   POST /ai/call-summaries/:id/confirm → ConfirmResult    (the SOLE draft→final transition)
 *
 * The wrappers are thin — the server owns the contract; this names the routes and
 * threads AbortSignals through the shared apiRequest client (C8 errors are parsed).
 */

// ── NL → Smart View ──────────────────────────────────────────────────────────

/** Raw success payload of POST /ai/smart-view (the DSL text is re-parsed by the UI). */
export interface NlSmartViewResponse {
  dsl: string;
  ast: Ast;
}

export function nlToSmartView(
  input: { query: string; catalog?: SmartViewFieldCatalog },
  signal?: AbortSignal,
): Promise<NlSmartViewResponse> {
  return apiRequest<NlSmartViewResponse>('/ai/smart-view', {
    method: 'POST',
    body: input,
    ...(signal ? { signal } : {}),
  });
}

// ── AI email draft / rewrite ─────────────────────────────────────────────────

export function draftEmailWithAi(
  input: { instruction: string; threadCtx?: EmailThreadContext },
  signal?: AbortSignal,
): Promise<EmailDraft> {
  return apiRequest<EmailDraft>('/ai/email-drafts', {
    method: 'POST',
    body: input,
    ...(signal ? { signal } : {}),
  });
}

// ── AI call summary (draft → confirm) ────────────────────────────────────────

/** POST /ai/call-summaries result — a DRAFT note; nothing final, no timeline event. */
export interface CallSummaryDraft {
  noteId: string;
  leadId: string;
  contactId: string | null;
  summary: string;
  actionItems: string[];
  status: 'draft';
  aiGenerated: true;
}

/** POST /ai/call-summaries/:id/confirm result — the recorded human confirmation. */
export interface CallSummaryConfirmResult {
  noteId: string;
  status: 'final';
  activityId: string;
  confirmedBy: string;
}

export function generateCallSummary(
  input: { callId: string; audioRef?: string },
  signal?: AbortSignal,
): Promise<CallSummaryDraft> {
  return apiRequest<CallSummaryDraft>('/ai/call-summaries', {
    method: 'POST',
    body: input,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Confirm an AI summary draft (§I-AI). `confirmedBy` is REQUIRED — the recorded
 * user action that flips the draft to final and lands `note_added` on the timeline.
 * In production the composition root binds it from the session; the demo passes the
 * signed-in fixture user (the documented actor-from-body deploy seam, D-032).
 */
export function confirmCallSummary(
  noteId: string,
  input: { confirmedBy: string },
): Promise<CallSummaryConfirmResult> {
  return apiRequest<CallSummaryConfirmResult>(
    `/ai/call-summaries/${encodeURIComponent(noteId)}/confirm`,
    { method: 'POST', body: input },
  );
}

// ── Calls list (for the summary seam) ────────────────────────────────────────
//
// NOTE (contract friction): C7 exposes calls dial/patch/dialer/voicemail but NO
// GET list-by-lead. The summary seam needs a callId with a transcript to act on, so
// the demo serves GET /calls?leadId= from the AI mock (returning C1 Call DTOs). The
// summarize/confirm routes it then calls ARE the real C7 routes; only the list is a
// demo scaffold that a future real GET /calls would drop straight into.
export function listLeadCalls(leadId: string, signal?: AbortSignal): Promise<Call[]> {
  return apiRequest<Call[]>('/calls', {
    query: { leadId },
    ...(signal ? { signal } : {}),
  });
}

// ── Smart View field catalog (builtins + org custom fields) ──────────────────

interface AdminCustomFieldRow {
  entity: 'lead' | 'contact' | 'opportunity';
  key: string;
  label: string;
  type: string;
}

const CATALOG_FIELD_TYPES = ['text', 'number', 'date', 'select', 'user'] as const;
type CatalogFieldType = (typeof CATALOG_FIELD_TYPES)[number];

function isCatalogFieldType(value: string): value is CatalogFieldType {
  return (CATALOG_FIELD_TYPES as readonly string[]).includes(value);
}

/**
 * Build the field catalog handed to NL→Smart View: builtin field names plus the
 * org's lead custom fields, so the model references only real fields AND the UI's
 * re-parse gates `custom.<key>` against the same catalog. A failed custom-field
 * fetch degrades to builtins-only (still a usable NL box).
 */
export async function fetchSmartViewCatalog(signal?: AbortSignal): Promise<SmartViewFieldCatalog> {
  const builtins = [...BUILTIN_FIELD_NAMES];
  try {
    const rows = await apiRequest<AdminCustomFieldRow[]>('/admin/custom-fields', {
      ...(signal ? { signal } : {}),
    });
    const custom = rows
      .filter((r) => r.entity === 'lead' && isCatalogFieldType(r.type))
      .map((r) => ({ key: r.key, type: r.type as CatalogFieldType, label: r.label }));
    return { builtins, custom };
  } catch {
    return { builtins, custom: [] };
  }
}
