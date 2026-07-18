import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Ast } from '@switchboard/shared';

import { contacts, leads, leadStatuses, users, type Db } from '../../db/index.ts';
import { recordActivity, type ActivityWebhookEmitter } from '../activity/index.ts';
import { enrollContacts, type EnrollTarget } from '../sequences/index.ts';
import type { QueueDriver } from '../../queue/index.ts';
import {
  buildCompileContext,
  hydrateLeads,
  loadLeadFieldCatalog,
  parseRawAst,
  resolveTargetIds,
  SmartViewService,
  type RawQueryable,
} from '../smartviews/index.ts';
import { leadsToCsv, leadsToJson } from './csv.ts';

/**
 * Bulk-action engine (CONTRACTS §C7 `bulk`, Task R3). `POST /bulk` resolves a
 * target lead set by compiling a stored smart view's ast (or a passed ast)
 * through the SINGLE query authority (`@switchboard/shared`, C3 — the SAME
 * compiler preview + the list dialer use), then applies one action across it.
 *
 * Every mutation routes through the engine + the ActivityWriter — the C4 event is
 * emitted in the SAME transaction as the record change, never a raw
 * `INSERT INTO activities`. Compliance rails are honored, never bypassed (C6):
 *   - enroll skips DNC leads/contacts (I-DNC) before they ever reach the sequence
 *     engine, and the engine's own send-time re-check is the backstop;
 *   - DNC set/clear REQUIRE an audit reason (the rail's paper trail).
 *
 * The web bulk bar currently fans out client-side (PATCH /leads/:id + the enroll
 * route + a client CSV); this is the C7 server-side bulk it will bind to. See the
 * task report for that divergence.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export type BulkAction = 'assign' | 'set-status' | 'set-dnc' | 'clear-dnc' | 'enroll' | 'export';

const BULK_ACTIONS: readonly BulkAction[] = [
  'assign',
  'set-status',
  'set-dnc',
  'clear-dnc',
  'enroll',
  'export',
];

export interface BulkInput {
  /** Target set: a stored view's ast, OR a raw ast passed inline. Exactly one. */
  smartViewId?: string;
  ast?: unknown;
  action: BulkAction;
  params?: Record<string, unknown>;
}

export interface BulkActor {
  userId: string;
}

export interface MutationSummary {
  kind: 'mutation';
  updated: number;
  skipped: number;
  skipReasons: Record<string, number>;
}

export interface EnrollSummary {
  kind: 'enroll';
  enrolled: number;
  skipped: number;
  skipReasons: Record<string, number>;
}

export interface ExportSummary {
  kind: 'export';
  format: 'csv' | 'json';
  filename: string;
  count: number;
  content: string;
}

export type BulkSummary = MutationSummary | EnrollSummary | ExportSummary;

export interface BulkResult {
  /** Synthetic id for the (synchronous) job; nods to the C7 "→ job id" shape. */
  jobId: string;
  action: BulkAction;
  status: 'completed';
  /** Size of the resolved target set. */
  targetCount: number;
  /** True when the target set hit the safety cap and was truncated. */
  truncated: boolean;
  summary: BulkSummary;
}

// --- Errors ----------------------------------------------------------------

/** Bad bulk request (unknown action, missing params/reason). Maps to 400. */
export class BulkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkInputError';
  }
}

/** A referenced target (smart view) was not found. Maps to 404. */
export class BulkTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkTargetError';
  }
}

type LeadOpOutcome = { kind: 'updated' } | { kind: 'skipped'; reason: string };

// --- Param helpers ----------------------------------------------------------

function requireString(params: Record<string, unknown> | undefined, key: string): string {
  const v = params?.[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new BulkInputError(`${key} is required`);
  }
  return v;
}

// --- Service ----------------------------------------------------------------

export interface BulkServiceDeps {
  db: Db;
  /** Raw client for the compiler's `$n` SQL (see smartviews/support.ts). */
  client: RawQueryable;
  /** Org timezone; relative-date resolution anchors here (C3). */
  orgTimezone: string;
  /** Sequence wake-up queue (enroll enqueues per-intent jobs). */
  queue: QueueDriver;
  /** Injectable clock; anchors event `occurredAt` + enroll due dates. */
  now: () => Date;
  /** Fans bulk field/status/dnc changes onto activity.recorded webhooks. */
  emitter?: ActivityWebhookEmitter;
}

export class BulkService {
  private readonly db: Db;
  private readonly client: RawQueryable;
  private readonly orgTimezone: string;
  private readonly queue: QueueDriver;
  private readonly now: () => Date;
  private readonly emitter: ActivityWebhookEmitter | undefined;
  private readonly smartViews: SmartViewService;

  constructor(deps: BulkServiceDeps) {
    this.db = deps.db;
    this.client = deps.client;
    this.orgTimezone = deps.orgTimezone;
    this.queue = deps.queue;
    this.now = deps.now;
    this.emitter = deps.emitter;
    this.smartViews = new SmartViewService({
      db: deps.db,
      client: deps.client,
      orgTimezone: deps.orgTimezone,
    });
  }

  /** Run a bulk action over the resolved target set. */
  async run(input: BulkInput, actor: BulkActor): Promise<BulkResult> {
    if (!BULK_ACTIONS.includes(input.action)) {
      throw new BulkInputError(`unknown action "${String(input.action)}"`);
    }
    const ast = await this.resolveAst(input);
    const catalog = await loadLeadFieldCatalog(this.db);
    const ctx = buildCompileContext(actor.userId, this.orgTimezone, catalog, this.now());
    const { ids, truncated } = await resolveTargetIds(this.db, this.client, ast, ctx);

    const summary = await this.dispatch(input, actor, ids);
    return {
      jobId: randomUUID(),
      action: input.action,
      status: 'completed',
      targetCount: ids.length,
      truncated,
      summary,
    };
  }

  private async resolveAst(input: BulkInput): Promise<Ast> {
    if (input.smartViewId !== undefined) {
      const ast = await this.smartViews.astForView(input.smartViewId);
      if (ast === null) throw new BulkTargetError('smart view not found');
      return ast;
    }
    if (input.ast !== undefined) return parseRawAst(input.ast);
    throw new BulkInputError('provide smartViewId or ast');
  }

  private async dispatch(
    input: BulkInput,
    actor: BulkActor,
    ids: readonly string[],
  ): Promise<BulkSummary> {
    switch (input.action) {
      case 'assign':
        return this.assign(ids, actor, input.params);
      case 'set-status':
        return this.setStatus(ids, actor, input.params);
      case 'set-dnc':
        return this.setDnc(ids, actor, input.params, true);
      case 'clear-dnc':
        return this.setDnc(ids, actor, input.params, false);
      case 'enroll':
        return this.enroll(ids, actor, input.params);
      case 'export':
        return this.export(ids, input.params);
    }
  }

  // --- assign owner ---------------------------------------------------------

  private async assign(
    ids: readonly string[],
    actor: BulkActor,
    params: Record<string, unknown> | undefined,
  ): Promise<MutationSummary> {
    const ownerId = requireString(params, 'ownerId');
    const exists = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (exists[0] === undefined) throw new BulkInputError('ownerId does not reference a user');

    return this.runMutation(ids, (id) => this.applyAssign(id, ownerId, actor.userId));
  }

  private applyAssign(leadId: string, ownerId: string, userId: string): Promise<LeadOpOutcome> {
    return this.db.transaction(async (txRaw) => {
      const tx = txRaw as Db;
      const rows = await tx
        .select({ ownerId: leads.ownerId })
        .from(leads)
        .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
        .limit(1);
      const cur = rows[0];
      if (cur === undefined) return { kind: 'skipped', reason: 'not_found' } as const;
      if (cur.ownerId === ownerId) return { kind: 'skipped', reason: 'no_change' } as const;
      await tx.update(leads).set({ ownerId }).where(eq(leads.id, leadId));
      await recordActivity(
        tx,
        {
          leadId,
          userId,
          type: 'field_changed',
          occurredAt: this.now().toISOString(),
          payload: { field: 'owner', before: cur.ownerId, after: ownerId },
        },
        this.emitter,
      );
      return { kind: 'updated' } as const;
    });
  }

  // --- set status -----------------------------------------------------------

  private async setStatus(
    ids: readonly string[],
    actor: BulkActor,
    params: Record<string, unknown> | undefined,
  ): Promise<MutationSummary> {
    const statusId = requireString(params, 'statusId');
    const exists = await this.db
      .select({ id: leadStatuses.id })
      .from(leadStatuses)
      .where(eq(leadStatuses.id, statusId))
      .limit(1);
    if (exists[0] === undefined) throw new BulkInputError('statusId does not reference a status');

    return this.runMutation(ids, (id) => this.applyStatus(id, statusId, actor.userId));
  }

  private applyStatus(leadId: string, statusId: string, userId: string): Promise<LeadOpOutcome> {
    return this.db.transaction(async (txRaw) => {
      const tx = txRaw as Db;
      const rows = await tx
        .select({ statusId: leads.statusId })
        .from(leads)
        .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
        .limit(1);
      const cur = rows[0];
      if (cur === undefined) return { kind: 'skipped', reason: 'not_found' } as const;
      if (cur.statusId === statusId) return { kind: 'skipped', reason: 'no_change' } as const;
      await tx.update(leads).set({ statusId }).where(eq(leads.id, leadId));
      await recordActivity(
        tx,
        {
          leadId,
          userId,
          type: 'status_changed',
          occurredAt: this.now().toISOString(),
          payload: { statusId, from: cur.statusId, to: statusId },
        },
        this.emitter,
      );
      return { kind: 'updated' } as const;
    });
  }

  // --- DNC set / clear ------------------------------------------------------

  private setDnc(
    ids: readonly string[],
    actor: BulkActor,
    params: Record<string, unknown> | undefined,
    value: boolean,
  ): Promise<MutationSummary> {
    // Rail: a DNC set/clear MUST carry an audit reason (C1 audit_log.reason).
    const reason = requireString(params, 'reason');
    return this.runMutation(ids, (id) => this.applyDnc(id, value, reason, actor.userId));
  }

  private applyDnc(
    leadId: string,
    value: boolean,
    reason: string,
    userId: string,
  ): Promise<LeadOpOutcome> {
    return this.db.transaction(async (txRaw) => {
      const tx = txRaw as Db;
      const rows = await tx
        .select({ dnc: leads.dnc })
        .from(leads)
        .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
        .limit(1);
      const cur = rows[0];
      if (cur === undefined) return { kind: 'skipped', reason: 'not_found' } as const;
      if (cur.dnc === value) {
        return { kind: 'skipped', reason: value ? 'already_dnc' : 'not_dnc' } as const;
      }
      await tx.update(leads).set({ dnc: value }).where(eq(leads.id, leadId));
      await recordActivity(
        tx,
        {
          leadId,
          userId,
          type: value ? 'dnc_set' : 'dnc_cleared',
          occurredAt: this.now().toISOString(),
          payload: { scope: 'lead', reason },
        },
        this.emitter,
      );
      return { kind: 'updated' } as const;
    });
  }

  private async runMutation(
    ids: readonly string[],
    apply: (id: string) => Promise<LeadOpOutcome>,
  ): Promise<MutationSummary> {
    let updated = 0;
    const skipReasons: Record<string, number> = {};
    for (const id of ids) {
      const outcome = await apply(id);
      if (outcome.kind === 'updated') {
        updated += 1;
      } else {
        skipReasons[outcome.reason] = (skipReasons[outcome.reason] ?? 0) + 1;
      }
    }
    const skipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
    return { kind: 'mutation', updated, skipped, skipReasons };
  }

  // --- enroll ---------------------------------------------------------------

  private async enroll(
    ids: readonly string[],
    actor: BulkActor,
    params: Record<string, unknown> | undefined,
  ): Promise<EnrollSummary> {
    const sequenceId = requireString(params, 'sequenceId');
    const emailAccountId =
      typeof params?.['emailAccountId'] === 'string'
        ? (params['emailAccountId'] as string)
        : undefined;

    const skipReasons: Record<string, number> = {};
    const bump = (reason: string): void => {
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    };

    if (ids.length === 0) return { kind: 'enroll', enrolled: 0, skipped: 0, skipReasons };

    // First live contact per target lead, with both lead + contact DNC flags.
    const leadDncRows = await this.db
      .select({ id: leads.id, dnc: leads.dnc })
      .from(leads)
      .where(and(inArray(leads.id, [...ids]), isNull(leads.deletedAt)));
    const leadDnc = new Map(leadDncRows.map((r) => [r.id, r.dnc]));

    const contactRows = await this.db
      .select({ leadId: contacts.leadId, id: contacts.id, dnc: contacts.dnc })
      .from(contacts)
      .where(and(inArray(contacts.leadId, [...ids]), isNull(contacts.deletedAt)))
      .orderBy(asc(contacts.leadId), asc(contacts.createdAt), asc(contacts.id));
    const firstContact = new Map<string, { id: string; dnc: boolean }>();
    for (const c of contactRows) {
      if (!firstContact.has(c.leadId)) firstContact.set(c.leadId, { id: c.id, dnc: c.dnc });
    }

    const targets: EnrollTarget[] = [];
    for (const leadId of ids) {
      if (!leadDnc.has(leadId)) {
        bump('lead_not_found');
        continue;
      }
      const contact = firstContact.get(leadId);
      if (contact === undefined) {
        bump('no_contact');
        continue;
      }
      // I-DNC: never enroll a DNC lead or a DNC contact. Skipped BEFORE the engine.
      if (leadDnc.get(leadId) === true || contact.dnc) {
        bump('dnc');
        continue;
      }
      targets.push({ leadId, contactId: contact.id });
    }

    let enrolled = 0;
    if (targets.length > 0) {
      const result = await enrollContacts(
        { db: this.db, queue: this.queue, now: this.now },
        {
          sequenceId,
          enrolledBy: actor.userId,
          ...(emailAccountId !== undefined ? { emailAccountId } : {}),
          targets,
        },
      );
      enrolled = result.enrolled.length;
      for (const s of result.skipped) bump(s.reason);
    }

    const skipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
    return { kind: 'enroll', enrolled, skipped, skipReasons };
  }

  // --- export ---------------------------------------------------------------

  private async export(
    ids: readonly string[],
    params: Record<string, unknown> | undefined,
  ): Promise<ExportSummary> {
    const format = params?.['format'] === 'json' ? 'json' : 'csv';
    const rows = await hydrateLeads(this.db, ids);
    const content = format === 'json' ? leadsToJson(rows) : leadsToCsv(rows);
    const stamp = this.now().toISOString().slice(0, 10);
    return {
      kind: 'export',
      format,
      filename: `leads-${stamp}.${format}`,
      count: rows.length,
      content,
    };
  }
}
