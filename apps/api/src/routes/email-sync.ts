import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { EmailProvider } from '@switchboard/shared/providers';
import { emailProviderValues } from '@switchboard/shared';

import type { Db } from '../db/index.ts';
import {
  SyncStateService,
  completeLinking,
  parseGmailPush,
  persistGmailPush,
  runBackfill,
  startLinking,
  InvalidPushError,
  AccountNotFoundError,
  IllegalTransitionError,
  ReauthRequiredError,
  type GmailPushVerifier,
  type LeadMatcher,
  type SyncEngineDeps,
} from '../services/sync/index.ts';
import { ParticipantLeadMatcher } from '../services/email/index.ts';
import { TokenCipher } from '../services/sync/token-cipher.ts';
import { sendError } from './http.ts';

/**
 * Email sync HTTP surface (CONTRACTS §C7): OAuth start/callback and the
 * `/wh/gmail` push ingress. The ingress is persist-then-process (ARCHITECTURE §5):
 * verify → store raw in `webhook_inbox` → fast-200; the incremental pull is driven
 * by the SEPARATE `processGmailInboxRow` step (a worker in 2e), never inline here.
 *
 * Deps are injected (provider, token cipher, push verifier) so the module never
 * branches on MOCK_MODE — the composition root chooses the adapters.
 */

type EmailProviderName = (typeof emailProviderValues)[number];

export interface EmailRouteDeps {
  db: Db;
  provider: EmailProvider;
  cipher: TokenCipher;
  verifier: GmailPushVerifier;
  /**
   * The configured OAuth redirect URI (this callback endpoint's URL). Used for
   * BOTH the auth-URL build and the code exchange — the two must match, and the
   * callback has no request body to carry it.
   */
  redirectUri: string;
  /** Which provider the linked accounts record (default 'gmail'). */
  providerName?: EmailProviderName;
  /**
   * Lead matcher for ingest. Defaults to the real participant→contact matcher
   * (2c) so a linked mailbox threads and matches for real; injectable so suites
   * can substitute a stub.
   */
  matcher?: LeadMatcher;
}

const startSchema = z.object({
  userId: z.string().uuid(),
  address: z.string().min(3),
});

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().uuid(),
});

function normalizeHeaders(raw: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && v.length > 0) out[k] = v[0] as string;
  }
  return out;
}

function mapSyncError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof AccountNotFoundError) return sendError(reply, 'NOT_FOUND', err.message);
  if (err instanceof IllegalTransitionError) return sendError(reply, 'CONFLICT', err.message);
  if (err instanceof ReauthRequiredError)
    return sendError(reply, 'SYNC_REAUTH_REQUIRED', err.message);
  return null;
}

export function registerEmailSyncRoutes(app: FastifyInstance, deps: EmailRouteDeps): void {
  const state = new SyncStateService(deps.db);
  const matcher = deps.matcher ?? new ParticipantLeadMatcher();
  const providerName: EmailProviderName = deps.providerName ?? 'gmail';
  const engine: SyncEngineDeps = {
    db: deps.db,
    provider: deps.provider,
    cipher: deps.cipher,
    state,
    ingest: { matcher },
  };
  const linking = { db: deps.db, provider: deps.provider, cipher: deps.cipher, state };

  // POST /api/v1/oauth/gmail/start → { accountId, authUrl }
  app.post('/api/v1/oauth/gmail/start', async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid link request', parsed.error.flatten());
    }
    try {
      const result = await startLinking(linking, {
        userId: parsed.data.userId,
        address: parsed.data.address,
        provider: providerName,
        redirectUri: deps.redirectUri,
      });
      return reply.send(result);
    } catch (err) {
      const mapped = mapSyncError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // GET /api/v1/oauth/gmail/callback?code=&state=accountId
  // Exchanges the code, stores encrypted tokens (BACKFILLING), then runs the
  // backfill inline (no queue under MOCK_MODE) so the mailbox reaches LIVE.
  app.get('/api/v1/oauth/gmail/callback', async (request, reply) => {
    const parsed = callbackSchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid callback', parsed.error.flatten());
    }
    try {
      const { accountId } = await completeLinking(linking, {
        accountId: parsed.data.state,
        code: parsed.data.code,
        redirectUri: deps.redirectUri,
      });
      await runBackfill(engine, accountId);
      const status = await state.current(accountId);
      return reply.send({ accountId, status });
    } catch (err) {
      const mapped = mapSyncError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // POST /wh/gmail — verify → persist raw → fast-200. Processing is separate.
  app.post('/wh/gmail', async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    const headers = normalizeHeaders(request.headers);

    if (!deps.verifier.verify(headers, rawBody)) {
      return sendError(reply, 'UNAUTHENTICATED', 'push verification failed');
    }
    let parsed;
    try {
      parsed = parseGmailPush(rawBody);
    } catch (err) {
      if (err instanceof InvalidPushError) {
        return sendError(reply, 'VALIDATION_FAILED', err.message);
      }
      throw err;
    }
    await persistGmailPush(deps.db, parsed);
    // Fast-200 on verified, regardless of duplicate (idempotent inbox).
    return reply.status(200).send({ ok: true });
  });
}
