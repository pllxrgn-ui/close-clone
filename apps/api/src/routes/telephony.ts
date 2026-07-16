import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TelephonyProvider } from '@switchboard/shared/providers';
import {
  astSchema,
  parse,
  ParseError,
  type Ast,
  type Cursor,
  type DslCustomFieldDef,
} from '@switchboard/shared';

import { smartViews, type Db } from '../db/index.ts';
import { eq } from 'drizzle-orm';
import type { QueueDriver } from '../queue/index.ts';
import {
  CallNotFoundError,
  DialBlockedError,
  DialContactNotFoundError,
  DialLeadNotFoundError,
  DialProviderError,
  DialValidationError,
  DialerBusyError,
  DropCallAlreadyFinalizedError,
  DropCallNotDialableError,
  DropCallNotFoundError,
  InvalidTwilioWebhookError,
  OrgSettingsNotFoundError,
  advanceDialer,
  dialCall,
  dropVoicemailOnCall,
  enqueueTwilioProcess,
  loadDialerQueue,
  parseTwilioWebhook,
  patchCall,
  persistTwilioWebhook,
  renderVoiceTwiml,
  resolveInboundRouting,
  setRecordingEnabled,
  type InboundRoutingDeps,
  type RawQueryable,
  type TwilioChannel,
  type TwilioIngressVerifier,
} from '../services/telephony/index.ts';
import { sendError } from './http.ts';

/**
 * Telephony HTTP surface (CONTRACTS §C7). Two shapes:
 *
 *  - Ingress `/wh/twilio/{voice,sms,status}` — signature-verified, persist-then-
 *    process (ARCHITECTURE §5). The handler ONLY verifies `X-Twilio-Signature`
 *    (reject ⇒ 403), stores the raw params in `webhook_inbox`, and fast-200s (or,
 *    for `/voice`, returns the routing TwiML synchronously). The lifecycle→timeline
 *    mapping runs in the SEPARATE idempotent worker (`processTwilioInboxRow`), never
 *    inline — so a replay is a no-op.
 *  - Internal API `POST /calls/dial` + `PATCH /calls/:id` — the dialer. Every dial
 *    goes through the engine's compliance rails (I-DNC hard block ⇒ C8 SUPPRESSED,
 *    I-REC consent), so the API cannot bypass them (I-RAIL-API).
 *
 * Deps are injected (verifier, dial provider) so the module never branches on
 * MOCK_MODE — the composition root binds the mock (3a) or real Twilio adapter (3b).
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

export interface TelephonyRouteDeps {
  db: Db;
  /** Ingress signature verifier (mock token under MOCK_MODE, real token in prod). */
  verifier: TwilioIngressVerifier;
  /** Adapter for outbound dials (only `dial` is used by this surface). */
  dialProvider: Pick<TelephonyProvider, 'dial'>;
  now: () => Date;
  /**
   * The app's public base URL (scheme + host, no trailing slash). Twilio signs the
   * full request URL, so verification must reconstruct it — behind a proxy the
   * request host is not trustworthy, hence a configured value.
   */
  publicBaseUrl: string;
  /** Default outbound caller-id (org Twilio number) when a dial omits `from`. */
  callerId?: string;
  /** Inbound routing overrides (ring-group resolver); defaults to active-users. */
  routing?: InboundRoutingDeps;
  /** Voicemail `<Record>` status callback; defaults to `<base>/wh/twilio/status`. */
  voicemailActionUrl?: string;
  /** Optional wake-up queue; when present, ingress enqueues async processing. */
  queue?: QueueDriver;
  // --- List dialer (3c) + recording switch (3d). All optional: the dialer/queue
  // routes register only when their dep is present, so the 3b wiring is unchanged. ---
  /**
   * Raw SQL client (PGlite/pg) for the compiled Smart View query behind the list
   * dialer queue. When present, the `POST /calls/dialer/queue` route registers.
   */
  dialerClient?: RawQueryable;
  /** Org timezone for the dialer queue's relative-date resolution (C3). */
  orgTimezone?: string;
  /** Custom-field catalog the queue compiler whitelists `custom.<key>` against. */
  fieldCatalog?: readonly DslCustomFieldDef[];
  /**
   * Adapter for the voicemail drop (`dropVoicemail`). When present, the
   * `POST /calls/:id/voicemail-drop` route registers.
   */
  voicemailProvider?: Pick<TelephonyProvider, 'dropVoicemail'>;
}

const dialBodySchema = z.object({
  userId: z.string().uuid(),
  leadId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  to: z.string().min(3).max(40).optional(),
  from: z.string().min(3).max(40).optional(),
  recordOptOut: z.boolean().optional(),
});

const patchBodySchema = z.object({
  outcome: z.string().max(200).optional(),
  notes: z.string().max(20_000).optional(),
  actorId: z.string().uuid().optional(),
});

// --- List dialer + recording switch (3c/3d) --------------------------------

const dialerQueueBodySchema = z
  .object({
    userId: z.string().uuid(),
    smartViewId: z.string().uuid().optional(),
    dsl: z.string().min(1).max(10_000).optional(),
    ast: z.unknown().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((b) => b.smartViewId !== undefined || b.dsl !== undefined || b.ast !== undefined, {
    message: 'provide one of smartViewId, dsl, or ast',
  });

const dialerAdvanceBodySchema = z.object({
  userId: z.string().uuid(),
  leadId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  to: z.string().min(3).max(40).optional(),
  from: z.string().min(3).max(40).optional(),
  recordOptOut: z.boolean().optional(),
});

const voicemailDropBodySchema = z.object({
  recordingRef: z.string().min(1).max(2048),
  actorId: z.string().uuid().optional(),
});

const recordingSwitchBodySchema = z.object({
  enabled: z.boolean(),
  legalSignoffRef: z.string().min(1).max(2048).optional(),
  reason: z.string().max(2000).optional(),
  actorId: z.string().uuid().optional(),
});

/** Opaque base64(JSON) keyset cursor for the dialer queue `{sortValue, id}`. */
function encodeDialerCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeDialerCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof (parsed as { id: unknown }).id === 'string' &&
      'sortValue' in parsed
    ) {
      const sv = (parsed as { sortValue: unknown }).sortValue;
      if (sv === null || ['string', 'number', 'boolean'].includes(typeof sv)) {
        return { sortValue: sv as Cursor['sortValue'], id: (parsed as { id: string }).id };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeHeaders(raw: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && v.length > 0) out[k] = v[0] as string;
  }
  return out;
}

function rawBodyOf(request: FastifyRequest): string {
  return typeof request.body === 'string' ? request.body : '';
}

export function registerTelephonyRoutes(app: FastifyInstance, deps: TelephonyRouteDeps): void {
  const base = deps.publicBaseUrl.replace(/\/+$/, '');
  const voicemailActionUrl = deps.voicemailActionUrl ?? `${base}/wh/twilio/status`;

  // Twilio POSTs `application/x-www-form-urlencoded`; keep the RAW body so the
  // signature is verified over the exact bytes. Registered once (guarded).
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, body);
      },
    );
  }

  /** Shared verify + persist for a channel; returns the persisted inbox id or null. */
  async function ingest(
    request: FastifyRequest,
    reply: FastifyReply,
    channel: TwilioChannel,
    path: string,
  ): Promise<{ inboxId: string | null } | { rejected: FastifyReply }> {
    const rawBody = rawBodyOf(request);
    const url = `${base}${path}`;
    if (!deps.verifier.verify(normalizeHeaders(request.headers), rawBody, url)) {
      return { rejected: sendError(reply, 'FORBIDDEN', 'twilio signature verification failed') };
    }
    let parsed;
    try {
      parsed = parseTwilioWebhook(channel, rawBody);
    } catch (err) {
      if (err instanceof InvalidTwilioWebhookError) {
        return { rejected: sendError(reply, 'VALIDATION_FAILED', err.message) };
      }
      throw err;
    }
    const receivedAt = deps.now().toISOString();
    const result = await persistTwilioWebhook(deps.db, parsed, receivedAt);
    // Enqueue async processing on first store (idempotent inbox makes it safe).
    if (result.stored && result.inboxId !== null && deps.queue !== undefined) {
      await enqueueTwilioProcess(deps.queue, result.inboxId);
    }
    return { inboxId: result.inboxId };
  }

  // POST /wh/twilio/voice — verify, persist, return the routing TwiML.
  app.post('/wh/twilio/voice', async (request, reply) => {
    const ingested = await ingest(request, reply, 'voice', '/wh/twilio/voice');
    if ('rejected' in ingested) return ingested.rejected;

    const params = new URLSearchParams(rawBodyOf(request));
    const from = params.get('From') ?? '';
    const plan = await resolveInboundRouting(deps.db, from, deps.routing ?? {});
    const twiml = renderVoiceTwiml(plan, { voicemailActionUrl });
    return reply.header('content-type', 'text/xml; charset=utf-8').send(twiml);
  });

  // POST /wh/twilio/sms — verify, persist, fast-200 (processing is separate).
  app.post('/wh/twilio/sms', async (request, reply) => {
    const ingested = await ingest(request, reply, 'sms', '/wh/twilio/sms');
    if ('rejected' in ingested) return ingested.rejected;
    return reply.status(200).send({ ok: true });
  });

  // POST /wh/twilio/status — verify, persist, fast-200 (processing is separate).
  app.post('/wh/twilio/status', async (request, reply) => {
    const ingested = await ingest(request, reply, 'status', '/wh/twilio/status');
    if ('rejected' in ingested) return ingested.rejected;
    return reply.status(200).send({ ok: true });
  });

  // POST /api/v1/calls/dial — the dialer (I-DNC / I-REC rails in the engine).
  app.post('/api/v1/calls/dial', async (request, reply) => {
    const parsed = dialBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid dial request', parsed.error.flatten());
    }
    const d = parsed.data;
    try {
      const result = await dialCall(
        {
          db: deps.db,
          provider: deps.dialProvider,
          now: deps.now,
          ...(deps.callerId !== undefined ? { callerId: deps.callerId } : {}),
        },
        {
          userId: d.userId,
          leadId: d.leadId,
          ...(d.contactId !== undefined ? { contactId: d.contactId } : {}),
          ...(d.to !== undefined ? { to: d.to } : {}),
          ...(d.from !== undefined ? { from: d.from } : {}),
          ...(d.recordOptOut !== undefined ? { recordOptOut: d.recordOptOut } : {}),
        },
      );
      return reply.send(result);
    } catch (err) {
      const mapped = mapDialError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // PATCH /api/v1/calls/:id — call outcome + rep note (never AI output).
  app.patch('/api/v1/calls/:id', async (request, reply) => {
    const idResult = z
      .string()
      .uuid()
      .safeParse((request.params as { id?: unknown }).id);
    if (!idResult.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid call id');
    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid patch request', parsed.error.flatten());
    }
    try {
      const result = await patchCall({ db: deps.db, now: deps.now }, idResult.data, {
        ...(parsed.data.outcome !== undefined ? { outcome: parsed.data.outcome } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.actorId !== undefined ? { actorId: parsed.data.actorId } : {}),
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof CallNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
      throw err;
    }
  });

  // --- List dialer (3c) ----------------------------------------------------

  // POST /api/v1/calls/dialer/queue — one keyset page of the sequential dialer
  // queue over a Smart View (compiled by the single query authority). Registers
  // only when a raw client is wired.
  if (deps.dialerClient !== undefined) {
    const dialerClient = deps.dialerClient;
    app.post('/api/v1/calls/dialer/queue', async (request, reply) => {
      const parsed = dialerQueueBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          'VALIDATION_FAILED',
          'invalid dialer queue request',
          parsed.error.flatten(),
        );
      }
      const resolved = await resolveQueueAst(deps, parsed.data);
      if ('error' in resolved) return sendError(reply, resolved.code, resolved.error);

      let cursor: Cursor | undefined;
      if (parsed.data.cursor !== undefined) {
        const c = decodeDialerCursor(parsed.data.cursor);
        if (c === null) return sendError(reply, 'VALIDATION_FAILED', 'invalid cursor');
        cursor = c;
      }

      const queue = await loadDialerQueue(
        {
          db: deps.db,
          client: dialerClient,
          ...(deps.orgTimezone !== undefined ? { orgTimezone: deps.orgTimezone } : {}),
          ...(deps.fieldCatalog !== undefined ? { fieldCatalog: deps.fieldCatalog } : {}),
          now: deps.now,
        },
        {
          ast: resolved.ast,
          currentUserId: parsed.data.userId,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        },
      );
      return reply.send({
        items: queue.entries,
        ...(queue.nextCursor !== undefined
          ? { nextCursor: encodeDialerCursor(queue.nextCursor) }
          : {}),
      });
    });
  }

  // POST /api/v1/calls/dialer/advance — place the next call SEQUENTIALLY (one live
  // call per rep; all I-DNC / I-REC rails via the dial engine).
  app.post('/api/v1/calls/dialer/advance', async (request, reply) => {
    const parsed = dialerAdvanceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid dialer advance request',
        parsed.error.flatten(),
      );
    }
    const d = parsed.data;
    try {
      const result = await advanceDialer(
        {
          db: deps.db,
          provider: deps.dialProvider,
          now: deps.now,
          ...(deps.callerId !== undefined ? { callerId: deps.callerId } : {}),
        },
        {
          userId: d.userId,
          leadId: d.leadId,
          ...(d.contactId !== undefined ? { contactId: d.contactId } : {}),
          ...(d.to !== undefined ? { to: d.to } : {}),
          ...(d.from !== undefined ? { from: d.from } : {}),
          ...(d.recordOptOut !== undefined ? { recordOptOut: d.recordOptOut } : {}),
        },
      );
      return reply.send(result);
    } catch (err) {
      // Sequential guard: a live call blocks the advance (C8 CONFLICT).
      if (err instanceof DialerBusyError) return sendError(reply, 'CONFLICT', err.message);
      const mapped = mapDialError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // POST /api/v1/calls/:id/voicemail-drop — drop a pre-recorded asset into a live
  // outbound call. Registers only when a drop-capable provider is wired.
  if (deps.voicemailProvider !== undefined) {
    const voicemailProvider = deps.voicemailProvider;
    app.post('/api/v1/calls/:id/voicemail-drop', async (request, reply) => {
      const idResult = z
        .string()
        .uuid()
        .safeParse((request.params as { id?: unknown }).id);
      if (!idResult.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid call id');
      const parsed = voicemailDropBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          'VALIDATION_FAILED',
          'invalid voicemail drop request',
          parsed.error.flatten(),
        );
      }
      try {
        const result = await dropVoicemailOnCall(
          { db: deps.db, provider: voicemailProvider, now: deps.now },
          {
            callId: idResult.data,
            recordingRef: parsed.data.recordingRef,
            ...(parsed.data.actorId !== undefined ? { actorId: parsed.data.actorId } : {}),
          },
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof DropCallNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
        if (err instanceof DropCallNotDialableError)
          return sendError(reply, 'VALIDATION_FAILED', err.message);
        if (err instanceof DropCallAlreadyFinalizedError)
          return sendError(reply, 'CONFLICT', err.message);
        if (err instanceof DialProviderError)
          return sendError(reply, 'PROVIDER_ERROR', err.message);
        throw err;
      }
    });
  }

  // --- Recording compliance switch (3d) ------------------------------------
  // POST /api/v1/admin/recording — flip org_settings.recording_enabled (§I-REC,
  // admin + audit-logged). MUST be mounted behind the admin RBAC preHandler by the
  // composition root; this handler records the audit but does not itself authorize.
  app.post('/api/v1/admin/recording', async (request, reply) => {
    const parsed = recordingSwitchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_FAILED',
        'invalid recording switch request',
        parsed.error.flatten(),
      );
    }
    try {
      const result = await setRecordingEnabled(deps.db, {
        enabled: parsed.data.enabled,
        ...(parsed.data.actorId !== undefined ? { actorId: parsed.data.actorId } : {}),
        ...(parsed.data.legalSignoffRef !== undefined
          ? { legalSignoffRef: parsed.data.legalSignoffRef }
          : {}),
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        ...(request.ip !== undefined ? { ip: request.ip } : {}),
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof OrgSettingsNotFoundError)
        return sendError(reply, 'NOT_FOUND', err.message);
      throw err;
    }
  });
}

type ResolvedQueueAst = { ast: Ast } | { error: string; code: 'VALIDATION_FAILED' | 'NOT_FOUND' };

/** Resolve the dialer queue's Smart View AST from smartViewId | dsl | ast. */
async function resolveQueueAst(
  deps: TelephonyRouteDeps,
  body: { smartViewId?: string | undefined; dsl?: string | undefined; ast?: unknown },
): Promise<ResolvedQueueAst> {
  if (body.smartViewId !== undefined) {
    const rows = await deps.db
      .select({ ast: smartViews.ast })
      .from(smartViews)
      .where(eq(smartViews.id, body.smartViewId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { error: 'smart view not found', code: 'NOT_FOUND' };
    const parsed = astSchema.safeParse(row.ast);
    if (!parsed.success)
      return { error: 'stored smart view ast is invalid', code: 'VALIDATION_FAILED' };
    return { ast: parsed.data };
  }
  if (body.dsl !== undefined) {
    try {
      return { ast: parse(body.dsl, { fieldCatalog: deps.fieldCatalog ?? [] }) };
    } catch (err) {
      if (err instanceof ParseError) return { error: err.message, code: 'VALIDATION_FAILED' };
      throw err;
    }
  }
  const parsed = astSchema.safeParse(body.ast);
  if (!parsed.success) return { error: 'invalid ast', code: 'VALIDATION_FAILED' };
  return { ast: parsed.data };
}

/** Map a dial-engine error to its C8 envelope; null if not a known dial error. */
function mapDialError(reply: FastifyReply, err: unknown): FastifyReply | null {
  // I-DNC/suppression is a hard block — C8 SUPPRESSED (422), never an override prompt.
  if (err instanceof DialBlockedError) return sendError(reply, 'SUPPRESSED', err.message);
  if (err instanceof DialValidationError) return sendError(reply, 'VALIDATION_FAILED', err.message);
  if (err instanceof DialLeadNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof DialContactNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof DialProviderError) return sendError(reply, 'PROVIDER_ERROR', err.message);
  return null;
}
