import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EmailProvider } from '@switchboard/shared/providers';
import { emailProviderValues } from '@switchboard/shared';

import { emailAccounts, type Db } from '../db/index.ts';
import { signValue, verifyValue } from '../auth/session/cookies.ts';
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
  MailboxAddressMismatchError,
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
  /** HMAC key for short-lived, user-bound Google OAuth state. */
  stateSecret: string;
  /** First-party Settings URL used after a successful provider callback. */
  postLinkRedirect: string;
  now?: () => Date;
  /**
   * Lead matcher for ingest. Defaults to the real participant→contact matcher
   * (2c) so a linked mailbox threads and matches for real; injectable so suites
   * can substitute a stub.
   */
  matcher?: LeadMatcher;
}

const startSchema = z.object({ address: z.string().trim().email() }).strict();

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const accountParamsSchema = z.object({ id: z.string().uuid() });
const oauthStateSchema = z.object({
  accountId: z.string().uuid(),
  userId: z.string().uuid(),
  exp: z.number().int(),
});
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const ACCOUNT_VIEW = {
  id: emailAccounts.id,
  userId: emailAccounts.userId,
  address: emailAccounts.address,
  provider: emailAccounts.provider,
  syncStatus: emailAccounts.syncStatus,
  historyCursor: emailAccounts.historyCursor,
  backfillCheckpoint: emailAccounts.backfillCheckpoint,
  dailySendCount: emailAccounts.dailySendCount,
  dailyCountDate: emailAccounts.dailyCountDate,
  createdAt: emailAccounts.createdAt,
  updatedAt: emailAccounts.updatedAt,
} as const;

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
  if (err instanceof MailboxAddressMismatchError) return sendError(reply, 'CONFLICT', err.message);
  return null;
}

function requestUser(request: FastifyRequest, reply: FastifyReply) {
  if (request.user !== undefined) return request.user;
  sendError(reply, 'UNAUTHENTICATED', 'no active session');
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
  const now = deps.now ?? (() => new Date());

  app.get('/api/v1/email-accounts', async (request, reply) => {
    const user = requestUser(request, reply);
    if (user === null) return reply;
    return deps.db
      .select(ACCOUNT_VIEW)
      .from(emailAccounts)
      .where(eq(emailAccounts.userId, user.id))
      .orderBy(asc(emailAccounts.createdAt));
  });

  // POST /api/v1/oauth/gmail/start → { accountId, authUrl }
  app.post('/api/v1/oauth/gmail/start', async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid link request', parsed.error.flatten());
    }
    const user = requestUser(request, reply);
    if (user === null) return reply;
    try {
      const result = await startLinking(linking, {
        userId: user.id,
        address: parsed.data.address.toLowerCase(),
        provider: providerName,
        redirectUri: deps.redirectUri,
      });
      const authUrl = new URL(result.authUrl);
      authUrl.searchParams.set(
        'state',
        signValue(
          {
            accountId: result.accountId,
            userId: user.id,
            exp: Math.floor(now().getTime() / 1000) + OAUTH_STATE_TTL_SECONDS,
          },
          deps.stateSecret,
        ),
      );
      return reply.send({ ...result, authUrl: authUrl.toString() });
    } catch (err) {
      const mapped = mapSyncError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  // GET /api/v1/oauth/gmail/callback?code=&state=signedPayload
  // Exchanges the code, stores encrypted tokens (BACKFILLING), then runs the
  // backfill inline (no queue under MOCK_MODE) so the mailbox reaches LIVE.
  app.get('/api/v1/oauth/gmail/callback', async (request, reply) => {
    const parsed = callbackSchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid callback', parsed.error.flatten());
    }
    const user = requestUser(request, reply);
    if (user === null) return reply;
    const parsedState = oauthStateSchema.safeParse(
      verifyValue(parsed.data.state, deps.stateSecret),
    );
    if (!parsedState.success || parsedState.data.exp <= Math.floor(now().getTime() / 1000)) {
      return sendError(reply, 'VALIDATION_FAILED', 'invalid or expired OAuth state');
    }
    if (parsedState.data.userId !== user.id) {
      return sendError(reply, 'FORBIDDEN', 'OAuth state belongs to another user');
    }
    const owned = await deps.db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(
        and(eq(emailAccounts.id, parsedState.data.accountId), eq(emailAccounts.userId, user.id)),
      )
      .limit(1);
    if (owned[0] === undefined) return sendError(reply, 'NOT_FOUND', 'email account not found');
    try {
      const { accountId } = await completeLinking(linking, {
        accountId: parsedState.data.accountId,
        code: parsed.data.code,
        redirectUri: deps.redirectUri,
      });
      await runBackfill(engine, accountId);
      const redirect = new URL(deps.postLinkRedirect);
      redirect.searchParams.set('gmail', 'connected');
      return reply.redirect(redirect.toString());
    } catch (err) {
      const mapped = mapSyncError(reply, err);
      if (mapped !== null) return mapped;
      throw err;
    }
  });

  app.delete('/api/v1/email-accounts/:id', async (request, reply) => {
    const user = requestUser(request, reply);
    if (user === null) return reply;
    const parsed = accountParamsSchema.safeParse(request.params);
    if (!parsed.success) return sendError(reply, 'VALIDATION_FAILED', 'invalid email account id');

    const disconnected = await deps.db.transaction(async (txRaw) => {
      const tx = txRaw as Db;
      const rows = await tx
        .select({ status: emailAccounts.syncStatus })
        .from(emailAccounts)
        .where(and(eq(emailAccounts.id, parsed.data.id), eq(emailAccounts.userId, user.id)))
        .for('update');
      const account = rows[0];
      if (account === undefined) return false;
      if (account.status !== 'REAUTH_REQUIRED') {
        await state.transition(parsed.data.id, 'REAUTH_REQUIRED', 'user:disconnect', tx);
      }
      await tx
        .update(emailAccounts)
        .set({
          oauthTokens: null,
          historyCursor: null,
          backfillCheckpoint: null,
          updatedAt: sql`now()`,
        })
        .where(eq(emailAccounts.id, parsed.data.id));
      return true;
    });
    if (!disconnected) return sendError(reply, 'NOT_FOUND', 'email account not found');
    return reply.status(204).send();
  });

  // POST /wh/gmail — verify → persist raw → fast-200. Processing is separate.
  app.post('/wh/gmail', async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    const headers = normalizeHeaders(request.headers);

    if (!(await deps.verifier.verify(headers, rawBody))) {
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
