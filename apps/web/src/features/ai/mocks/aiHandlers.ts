import { http, HttpResponse } from 'msw';
import type { Activity } from '@switchboard/shared';
import { astToDsl, parse, ParseError, type DslCustomFieldDef } from '@switchboard/shared';
import { db } from '../../../mocks/fixtures.ts';
import { aiStore, callById, callTranscript, callsForLead, noteById } from '../data/store.ts';

/*
 * Additive MSW handlers for the AI surface (tasks 3e/3g). Shapes mirror the REAL
 * routes in apps/api/src/routes/ai.ts EXACTLY (§C7 camelCase, §C8 error envelope),
 * and the §I-AI invariant is enforced HERE, server-side, so a caller that skips the
 * UI still cannot write a final AI record without a recorded confirm:
 *
 *  - `generate` writes a DRAFT note and NO timeline event;
 *  - `confirm` is the SOLE draft→final transition, REQUIRES `confirmedBy`, and lands
 *    exactly one `note_added` carrying it;
 *  - NL→Smart View re-parses the model DSL with the SAME parser as the builder and
 *    400s (rawDsl + position) on invalid text — never a saved guess.
 *
 * Registered like the other feature handler arrays: `server.use(...aiHandlers)` in
 * tests, spread into the worker/server list at merge (see routeWiring). Writes hit
 * the module-scope `aiStore`; confirm also appends to the shared timeline `db`.
 */

const api = (path: string): string => `*/api/v1${path}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorJson(status: number, code: string, message: string, details?: unknown) {
  const body =
    details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return HttpResponse.json(body, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** Append a C4 activity to the shared timeline store (newest-first, like comms). */
function appendActivity(input: {
  leadId: string;
  contactId?: string | null;
  userId?: string | null;
  type: string;
  payload: Record<string, unknown>;
}): Activity {
  const now = new Date().toISOString();
  const activity: Activity = {
    id: crypto.randomUUID(),
    leadId: input.leadId,
    contactId: input.contactId ?? null,
    userId: input.userId ?? null,
    type: input.type,
    occurredAt: now,
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
  };
  const existing = db.activitiesByLead.get(input.leadId);
  if (existing) existing.unshift(activity);
  else db.activitiesByLead.set(input.leadId, [activity]);
  return activity;
}

// ── Deterministic mock-AI derivations (mirror providers/ai/mock-ai-provider.ts) ──

function firstSentence(text: string): string {
  const match = text.match(/[^.!?]*[.!?]/);
  return (match?.[0] ?? text).trim();
}

function deriveSummary(
  transcript: string,
  leadName: string | undefined,
): { summary: string; actionItems: string[] } {
  const who = leadName !== undefined && leadName.length > 0 ? ` with ${leadName}` : '';
  const summary = `Call${who} covered the customer's current evaluation status and next steps. ${firstSentence(
    transcript,
  )}`;
  const actionItems: string[] = [];
  const lower = transcript.toLowerCase();
  if (lower.includes('quote')) actionItems.push('Send the revised quote');
  if (lower.includes('follow-up') || lower.includes('follow up') || lower.includes('next week')) {
    actionItems.push('Schedule a follow-up');
  }
  if (actionItems.length === 0) actionItems.push('Log call outcome and next step');
  return { summary, actionItems };
}

/** Intent line for a fresh draft, chosen from keywords in the instruction. */
function intentLine(directive: string): string {
  const d = directive.toLowerCase();
  if (/\b(intro|introduc|first touch|reach ?out|cold)\b/.test(d)) {
    return "I'm reaching out because I think we can help your team keep calls, email, and follow-up in one place instead of scattered across tabs.";
  }
  if (/\b(follow[- ]?up|following up|checking in|nudge|circle back)\b/.test(d)) {
    return "I'm following up on my last note — I didn't want this to slip through the cracks.";
  }
  if (/\b(pricing|price|quote|cost|budget)\b/.test(d)) {
    return "Happy to walk you through pricing and map the right plan to your team's size.";
  }
  if (/\b(demo|walkthrough|show)\b/.test(d)) {
    return 'I would love to show you a short demo tailored to how your team actually works.';
  }
  if (/\b(renew|renewal|expand|upsell)\b/.test(d)) {
    return 'Your renewal is coming up, and I want to make sure the plan still fits how your team is using us.';
  }
  return 'I wanted to reach out and see whether there might be a fit for your team this quarter.';
}

/** Closing line for a rewrite, flavored by the requested tone. */
function rewriteClose(directive: string): string {
  const d = directive.toLowerCase();
  if (/\b(short|shorter|concise|brief|tighten|trim)\b/.test(d)) {
    return "Keeping this short — happy to send more detail if it's useful.";
  }
  if (/\b(warm|warmer|friendly|casual|personable)\b/.test(d)) {
    return 'No pressure at all — I just wanted to reconnect.';
  }
  if (/\b(formal|professional)\b/.test(d)) {
    return 'Please let me know if this aligns with your priorities.';
  }
  return 'Let me know what you think.';
}

/**
 * Strip {{merge.tags}} and tidy the whitespace/punctuation they leave behind.
 * The composer now sends RENDERED text, so tags only reach here when a tag is
 * unresolved — the AI must never echo raw template syntax back into a draft.
 */
function stripTags(text: string): string {
  return text
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/[ \t]+([,.;!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** First 1–2 sentences of the current draft, for a believable rewrite base. */
function condense(text: string): string {
  // Tags are stripped FIRST — the "." inside {{contact.firstName}} would
  // otherwise split mid-tag and echo broken fragments like "{{lead." back.
  const clean = stripTags(text).replace(/\s+/g, ' ');
  // Drop a leading greeting; the rewrite shell supplies its own (no "Hi… Hi…").
  const ungreeted = clean.replace(/^(hi|hello|hey)\b[^,.!\n]{0,40}[,.!]\s*/i, '');
  const base = ungreeted.length > 0 ? ungreeted : clean;
  const sentences = base.match(/[^.!?]+[.!?]/g) ?? [base.trim()];
  return sentences.slice(0, 2).join(' ').trim();
}

/**
 * Believable canned draft (§C2 `{subject?, body}`). This MSW layer is deliberately
 * richer than the API's minimal mock provider — the shape is identical, so real mode
 * is unaffected; only the demo prose improves. `priorBody` (the composer's current
 * text, passed via threadCtx) switches DRAFT → REWRITE.
 */
function deriveDraft(
  instruction: string,
  subject: string | undefined,
  priorBody: string | undefined,
): { subject?: string; body: string } {
  const directive = instruction.trim();
  const cleanSubject = subject !== undefined ? stripTags(subject) : '';
  const replySubject =
    cleanSubject.length > 0
      ? cleanSubject.startsWith('Re:')
        ? cleanSubject
        : `Re: ${cleanSubject}`
      : undefined;

  let body: string;
  if (priorBody !== undefined && priorBody.trim().length > 0) {
    // Rewrite: polish the existing draft and apply the requested tone. If the
    // draft was nothing but unresolved tags, fall back to a fresh intent line.
    const gist = condense(priorBody);
    const core = gist.length > 0 ? gist : intentLine(directive);
    body = `Hi there,\n\n${core}\n\n${rewriteClose(directive)}\n\nBest,\n`;
  } else {
    body = `Hi there,\n\n${intentLine(directive)}\n\nWould you be open to a quick 15 minutes this week?\n\nBest,\n`;
  }
  return replySubject === undefined ? { body } : { subject: replySubject, body };
}

/** Query → DSL heuristic (mirrors the mock AI provider). Always valid DSL. */
function deriveDsl(query: string): string {
  const q = query.toLowerCase();
  if (/\b(won|closed[- ]won)\b/.test(q)) return 'status = "Won"';
  const noEmail = q.match(/no (?:email|emails?|touch|contact)[^0-9]*(\d+)\s*(day|days|week|weeks)/);
  if (noEmail) {
    const n = noEmail[1];
    const unit = noEmail[2]?.startsWith('week') ? 'w' : 'd';
    return `no email within ${n}${unit}`;
  }
  if (q.includes('do not call') || q.includes('dnc')) return 'dnc = true';
  return `matches ${JSON.stringify(query)}`;
}

function parserCatalog(catalog: unknown): DslCustomFieldDef[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.custom)) return [];
  const out: DslCustomFieldDef[] = [];
  for (const raw of catalog.custom) {
    if (isRecord(raw) && typeof raw.key === 'string' && typeof raw.type === 'string') {
      out.push({ key: raw.key, entity: 'lead', type: raw.type as DslCustomFieldDef['type'] });
    }
  }
  return out;
}

export const aiHandlers = [
  // ── Calls by lead (demo scaffold; see api/ai.ts contract-friction note) ───────
  http.get(api('/calls'), ({ request }) => {
    const leadId = new URL(request.url).searchParams.get('leadId');
    if (!leadId) return errorJson(400, 'VALIDATION_FAILED', 'Query "leadId" is required');
    return HttpResponse.json(callsForLead(leadId));
  }),

  // ── NL → Smart View: derive DSL, re-parse, 400 on invalid (§7) ────────────────
  http.post(api('/ai/smart-view'), async ({ request }) => {
    const body = await readJson(request);
    const query = body && typeof body.query === 'string' ? body.query : '';
    if (query.trim() === '') return errorJson(400, 'VALIDATION_FAILED', 'query is required');

    // `raw:` pins the model's raw DSL verbatim (mirrors MockAIProvider.scriptSmartView,
    // which can emit INVALID DSL) so the "invalid = visible error" guardrail is real.
    const rawDsl = query.startsWith('raw:') ? query.slice(4).trim() : deriveDsl(query);
    const fieldCatalog = parserCatalog(body?.catalog);
    try {
      const ast = parse(rawDsl, { fieldCatalog });
      return HttpResponse.json({ dsl: astToDsl(ast), ast });
    } catch (err) {
      if (err instanceof ParseError) {
        return errorJson(400, 'VALIDATION_FAILED', 'AI produced invalid DSL', {
          rawDsl,
          parseError: err.message,
          position: err.position,
        });
      }
      throw err;
    }
  }),

  // ── AI email draft (returned to composer; never auto-sent, §I-AI) ─────────────
  http.post(api('/ai/email-drafts'), async ({ request }) => {
    const body = await readJson(request);
    const instruction = body && typeof body.instruction === 'string' ? body.instruction : '';
    if (instruction.trim() === '') {
      return errorJson(400, 'VALIDATION_FAILED', 'instruction is required');
    }
    const threadCtx = isRecord(body?.threadCtx) ? body.threadCtx : undefined;
    const subject =
      threadCtx && typeof threadCtx.subject === 'string' ? threadCtx.subject : undefined;
    // The composer passes its current text as the last thread message → rewrite mode.
    const messages =
      threadCtx && Array.isArray(threadCtx.recentMessages) ? threadCtx.recentMessages : [];
    const last = messages.at(-1);
    const priorBody = isRecord(last) && typeof last.body === 'string' ? last.body : undefined;
    return HttpResponse.json(deriveDraft(instruction, subject, priorBody));
  }),

  // ── AI call summary: generate a DRAFT note only, NO timeline event (§I-AI) ─────
  http.post(api('/ai/call-summaries'), async ({ request }) => {
    const body = await readJson(request);
    const callId = body && typeof body.callId === 'string' ? body.callId : '';
    if (!UUID_RE.test(callId)) return errorJson(400, 'VALIDATION_FAILED', 'callId must be a uuid');
    const call = callById(callId);
    if (!call) return errorJson(404, 'NOT_FOUND', `call ${callId} not found`);

    const audioRef = typeof body?.audioRef === 'string' ? body.audioRef : call.transcriptRef;
    if (audioRef === null || audioRef === undefined || audioRef.length === 0) {
      return errorJson(
        400,
        'VALIDATION_FAILED',
        `call ${callId} has no recording or transcript to summarize`,
      );
    }

    const lead = db.leads.find((l) => l.id === call.leadId);
    const transcript = callTranscript(callId) || 'The call recording was transcribed.';
    const { summary, actionItems } = deriveSummary(transcript, lead?.name);
    const noteId = crypto.randomUUID();
    // Draft only: author is null (the AI is not a user) and there is NO activity.
    aiStore.notes.push({
      noteId,
      callId,
      leadId: call.leadId,
      contactId: call.contactId,
      summary,
      actionItems,
      status: 'draft',
      confirmedBy: null,
    });
    return HttpResponse.json({
      noteId,
      leadId: call.leadId,
      contactId: call.contactId,
      summary,
      actionItems,
      status: 'draft',
      aiGenerated: true,
    });
  }),

  // ── Confirm: the SOLE draft→final transition (§I-AI) ──────────────────────────
  http.post(api('/ai/call-summaries/:noteId/confirm'), async ({ params, request }) => {
    const noteId = String(params.noteId);
    if (!UUID_RE.test(noteId)) return errorJson(400, 'VALIDATION_FAILED', 'invalid note id');
    const body = await readJson(request);
    const confirmedBy = body && typeof body.confirmedBy === 'string' ? body.confirmedBy : '';
    // Missing/blank confirmedBy is rejected — no final without a recorded user (§I-AI).
    if (!UUID_RE.test(confirmedBy)) {
      return errorJson(400, 'VALIDATION_FAILED', 'confirmedBy is required');
    }
    const note = noteById(noteId);
    if (!note) return errorJson(404, 'NOT_FOUND', `ai summary note ${noteId} not found`);
    if (note.status === 'final') {
      return errorJson(409, 'CONFLICT', `ai summary note ${noteId} is already final`);
    }

    note.status = 'final';
    note.confirmedBy = confirmedBy;
    const activity = appendActivity({
      leadId: note.leadId,
      contactId: note.contactId,
      userId: confirmedBy,
      type: 'note_added',
      payload: { noteId, aiGenerated: true, confirmedBy },
    });
    return HttpResponse.json({ noteId, status: 'final', activityId: activity.id, confirmedBy });
  }),
];
