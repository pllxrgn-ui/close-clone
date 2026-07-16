import { and, eq, ne, sql } from 'drizzle-orm';
import { leads, users, type Db } from '../../db/index.ts';
import { resolveContactByPhone } from './phone.ts';

/**
 * Inbound-call routing (CONTRACTS §C7 `/wh/twilio/voice`; task 3b acceptance:
 * "inbound routing owner→ring-group→voicemail"). A ringing inbound call is routed
 * to, in order:
 *   1. the matched lead's OWNER (if the number maps to a lead and the owner is an
 *      active user);
 *   2. a fallback RING GROUP (active users, owner excluded) rung in parallel;
 *   3. VOICEMAIL (always the terminal fallback — a caller can always leave a
 *      message, even from an unknown number).
 *
 * The routing DECISION (`resolveInboundRouting`) is separated from the TwiML
 * RENDERING (`renderVoiceTwiml`) so the tiering is unit-testable without XML. Dial
 * targets are Twilio Client identities equal to the CRM user id — the same
 * `identity` the browser SDK registers with (`createCallToken`).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

const DEFAULT_RING_GROUP_LIMIT = 10;

export interface RoutingTier {
  kind: 'owner' | 'ring_group';
  /** CRM user id = the Twilio Client identity to dial. */
  userId: string;
}

export interface RoutingPlan {
  leadId: string | null;
  contactId: string | null;
  /** The highest-priority tier that has a target (or `voicemail` if none). */
  primary: 'owner' | 'ring_group' | 'voicemail';
  /** Ordered dial targets: the owner (if any) first, then the ring group. */
  tiers: RoutingTier[];
  /** Always true — voicemail is the terminal fallback. */
  voicemail: true;
}

/**
 * Resolves the fallback ring group. Default: active users other than the owner
 * (deterministic order, capped). Injectable so an org can later supply an explicit
 * group (there is no ring-group table in C1 — active-reps-minus-owner is the
 * documented v1 rule; see report friction).
 */
export interface RingGroupResolver {
  resolve(db: Db, ctx: { ownerId: string | null; leadId: string | null }): Promise<string[]>;
}

export class ActiveUsersRingGroup implements RingGroupResolver {
  private readonly limit: number;
  constructor(limit: number = DEFAULT_RING_GROUP_LIMIT) {
    this.limit = limit;
  }
  async resolve(db: Db, ctx: { ownerId: string | null; leadId: string | null }): Promise<string[]> {
    const base = db
      .select({ id: users.id })
      .from(users)
      .where(
        ctx.ownerId === null
          ? eq(users.isActive, true)
          : and(eq(users.isActive, true), ne(users.id, ctx.ownerId)),
      )
      .orderBy(users.name, users.id)
      .limit(this.limit);
    const rows = await base;
    return rows.map((r) => r.id);
  }
}

export interface InboundRoutingDeps {
  ringGroup?: RingGroupResolver;
}

/**
 * Decide how an inbound call from `fromNumber` should be routed. Never throws for
 * an unknown number — it falls through to the ring group / voicemail.
 */
export async function resolveInboundRouting(
  db: Db,
  fromNumber: string,
  deps: InboundRoutingDeps = {},
): Promise<RoutingPlan> {
  const ringGroupResolver = deps.ringGroup ?? new ActiveUsersRingGroup();
  const match = await resolveContactByPhone(db, fromNumber);

  let ownerId: string | null = null;
  if (match !== null) {
    const ownerRows = await db
      .select({ ownerId: leads.ownerId, active: users.isActive })
      .from(leads)
      .leftJoin(users, eq(users.id, leads.ownerId))
      .where(and(eq(leads.id, match.leadId), sql`${leads.deletedAt} is null`))
      .limit(1);
    const owner = ownerRows[0];
    if (owner?.ownerId != null && owner.active === true) ownerId = owner.ownerId;
  }

  const tiers: RoutingTier[] = [];
  if (ownerId !== null) tiers.push({ kind: 'owner', userId: ownerId });
  const group = await ringGroupResolver.resolve(db, {
    ownerId,
    leadId: match?.leadId ?? null,
  });
  for (const userId of group) tiers.push({ kind: 'ring_group', userId });

  const primary: RoutingPlan['primary'] =
    tiers[0]?.kind ?? 'voicemail';
  return {
    leadId: match?.leadId ?? null,
    contactId: match?.contactId ?? null,
    primary,
    tiers,
    voicemail: true,
  };
}

export interface VoiceTwimlOptions {
  /** Recording status callback for the voicemail `<Record>` (C7 `/wh/twilio/status`). */
  voicemailActionUrl: string;
  /** Per-tier dial ring timeout (seconds). */
  dialTimeoutSeconds?: number;
  /** Spoken voicemail prompt. */
  voicemailPrompt?: string;
  /** Max voicemail length (seconds). */
  voicemailMaxLengthSeconds?: number;
}

const DEFAULT_DIAL_TIMEOUT_S = 20;
const DEFAULT_VOICEMAIL_MAX_S = 120;
const DEFAULT_VOICEMAIL_PROMPT = 'Please leave a message after the tone.';

/** Render a routing plan to the TwiML Twilio expects from `/wh/twilio/voice`. */
export function renderVoiceTwiml(plan: RoutingPlan, opts: VoiceTwimlOptions): string {
  const timeout = opts.dialTimeoutSeconds ?? DEFAULT_DIAL_TIMEOUT_S;
  const maxLength = opts.voicemailMaxLengthSeconds ?? DEFAULT_VOICEMAIL_MAX_S;
  const prompt = opts.voicemailPrompt ?? DEFAULT_VOICEMAIL_PROMPT;

  const owners = plan.tiers.filter((t) => t.kind === 'owner');
  const ringGroup = plan.tiers.filter((t) => t.kind === 'ring_group');

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];
  // Tier 1: the owner (one Dial so the call falls through on no-answer).
  for (const owner of owners) {
    lines.push(
      `  <Dial timeout="${timeout}" answerOnBridge="true"><Client>${escapeXml(
        owner.userId,
      )}</Client></Dial>`,
    );
  }
  // Tier 2: the ring group, rung in parallel in a single Dial.
  if (ringGroup.length > 0) {
    const clients = ringGroup.map((t) => `<Client>${escapeXml(t.userId)}</Client>`).join('');
    lines.push(`  <Dial timeout="${timeout}" answerOnBridge="true">${clients}</Dial>`);
  }
  // Tier 3: voicemail (always).
  lines.push(`  <Say>${escapeXml(prompt)}</Say>`);
  lines.push(
    `  <Record maxLength="${maxLength}" playBeep="true" recordingStatusCallback="${escapeXml(
      opts.voicemailActionUrl,
    )}" recordingStatusCallbackEvent="completed"/>`,
  );
  lines.push('</Response>');
  return lines.join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
