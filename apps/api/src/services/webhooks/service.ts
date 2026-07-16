import { randomBytes } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';

import { webhookSubscriptions, type Db } from '../../db/index.ts';
import {
  WebhookHasDeliveriesError,
  WebhookSubscriptionNotFoundError,
  WebhookValidationError,
} from './errors.ts';
import {
  WILDCARD_EVENT,
  assertValidEventSelectors,
  parseSubscribedEvents,
  type WebhookEventType,
} from './events.ts';

/**
 * Webhook subscription management (Task 5c, CONTRACTS §C1 `webhook_subscriptions`).
 *
 * SECRET HANDLING (D-021, "credential material"): the HMAC signing secret is
 * returned to the admin EXACTLY ONCE — at create and on explicit rotate — because
 * the receiver needs it to verify signatures. It is NEVER present in a list/get
 * view, and never logged or exported. The safe view ({@link WebhookSubscriptionView})
 * has no `secret` field at all, so it is structurally impossible to leak through
 * the read surface.
 *
 * Import-safe for direct `node` execution (no enums / namespaces / parameter
 * properties — the host type-stripping constraint).
 */

const SECRET_PREFIX = 'whsec_';

/** Mint a fresh HMAC secret (192 bits). */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString('base64url');
}

/** The safe projection — deliberately has NO `secret` field (see the module note). */
export interface WebhookSubscriptionView {
  id: string;
  url: string;
  events: (WebhookEventType | typeof WILDCARD_EVENT)[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedSubscription {
  subscription: WebhookSubscriptionView;
  /** Shown ONCE; never stored in plaintext elsewhere, never returned again. */
  secret: string;
}

export interface CreateSubscriptionInput {
  url: string;
  /** Event selectors (known types and/or `'*'`). Must be non-empty. */
  events: string[];
  /** Bring-your-own secret; otherwise one is generated. */
  secret?: string;
  isActive?: boolean;
}

export interface UpdateSubscriptionInput {
  url?: string;
  events?: string[];
  isActive?: boolean;
}

export interface ListSubscriptionsFilter {
  limit?: number;
  cursor?: string;
  activeOnly?: boolean;
}

export interface ListSubscriptionsPage {
  items: WebhookSubscriptionView[];
  nextCursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Safe columns — `secret` is deliberately excluded. */
const VIEW_COLUMNS = {
  id: webhookSubscriptions.id,
  url: webhookSubscriptions.url,
  events: webhookSubscriptions.events,
  isActive: webhookSubscriptions.isActive,
  createdAt: webhookSubscriptions.createdAt,
  updatedAt: webhookSubscriptions.updatedAt,
} as const;

interface ViewRow {
  id: string;
  url: string;
  events: unknown;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function normalizeEvents(raw: string[]): (WebhookEventType | typeof WILDCARD_EVENT)[] {
  const { all, types } = parseSubscribedEvents(raw);
  return all ? [WILDCARD_EVENT, ...types] : types;
}

function toView(row: ViewRow): WebhookSubscriptionView {
  return {
    id: row.id,
    url: row.url,
    events: normalizeEvents(Array.isArray(row.events) ? (row.events as string[]) : []),
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * SSRF guard for outbound webhook targets (2026-07-16 review, finding 1). A
 * literal-IP host is range-checked against loopback / private / link-local /
 * reserved space (incl. the 169.254.169.254 cloud-metadata address); the WHATWG
 * URL parser has already canonicalised octal/hex/decimal IPv4 forms, and
 * {@link BlockList} matches IPv4-mapped IPv6 (`::ffff:a.b.c.d`) against the IPv4
 * rules, closing those bypasses. A DNS-name host is screened for the known
 * loopback names only.
 *
 * Deferred hardening (see deploy/WIRING.md): resolve-and-pin to fully defeat DNS
 * rebinding — a name that passes here can still resolve to an internal address at
 * delivery time. The delivery worker must resolve the host, re-check the resolved IP against this
 * same block list, and connect to that pinned IP. That belongs in the delivery
 * path (it needs the network), not in this synchronous create/update validator.
 */
const BLOCKED_HOST_IPS = new BlockList();
// IPv4: this-network (incl. 0.0.0.0), loopback, private, link-local (incl. metadata).
BLOCKED_HOST_IPS.addSubnet('0.0.0.0', 8, 'ipv4');
BLOCKED_HOST_IPS.addSubnet('10.0.0.0', 8, 'ipv4');
BLOCKED_HOST_IPS.addSubnet('127.0.0.0', 8, 'ipv4');
BLOCKED_HOST_IPS.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED_HOST_IPS.addSubnet('172.16.0.0', 12, 'ipv4');
BLOCKED_HOST_IPS.addSubnet('192.168.0.0', 16, 'ipv4');
// IPv6: unspecified, loopback, unique-local (fc00::/7), link-local (fe80::/10).
BLOCKED_HOST_IPS.addAddress('::', 'ipv6');
BLOCKED_HOST_IPS.addAddress('::1', 'ipv6');
BLOCKED_HOST_IPS.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_HOST_IPS.addSubnet('fe80::', 10, 'ipv6');

function assertPublicHost(hostname: string): void {
  // `URL.hostname` wraps IPv6 literals in brackets; strip them for isIP/BlockList.
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const family = isIP(bare);
  if (family === 4 || family === 6) {
    if (BLOCKED_HOST_IPS.check(bare, family === 4 ? 'ipv4' : 'ipv6')) {
      throw new WebhookValidationError(`webhook url host is not a public address: ${hostname}`);
    }
    return;
  }
  // DNS name: reject the reserved loopback names outright (RFC 6761 `.localhost`).
  const name = bare.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) {
    throw new WebhookValidationError(`webhook url host is not a public address: ${hostname}`);
  }
}

function validateUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookValidationError(`invalid webhook url: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new WebhookValidationError('webhook url must use https');
  }
  assertPublicHost(parsed.hostname);
  return parsed.toString();
}

function validateEvents(events: string[]): string[] {
  if (events.length === 0) {
    throw new WebhookValidationError('a subscription must select at least one event');
  }
  try {
    assertValidEventSelectors(events);
  } catch (err) {
    throw new WebhookValidationError(err instanceof Error ? err.message : String(err));
  }
  // Persist a normalized, deduped selector list.
  return normalizeEvents(events);
}

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { createdAt, id } = parsed as Record<string, unknown>;
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function isForeignKeyViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23503') return true;
  const cause = (err as { cause?: unknown }).cause;
  if (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === '23503'
  ) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('violates foreign key');
}

export class WebhookSubscriptionService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Create a subscription. Returns the signing secret ONCE. */
  async create(input: CreateSubscriptionInput): Promise<CreatedSubscription> {
    const url = validateUrl(input.url);
    const events = validateEvents(input.events);
    const secret =
      input.secret !== undefined && input.secret.length > 0
        ? input.secret
        : generateWebhookSecret();

    const inserted = await this.db
      .insert(webhookSubscriptions)
      .values({
        url,
        secret,
        events,
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      })
      .returning(VIEW_COLUMNS);
    const row = inserted[0];
    if (row === undefined) throw new WebhookValidationError('subscription insert returned no row');
    return { subscription: toView(row), secret };
  }

  async get(subscriptionId: string): Promise<WebhookSubscriptionView> {
    const rows = await this.db
      .select(VIEW_COLUMNS)
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, subscriptionId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new WebhookSubscriptionNotFoundError(subscriptionId);
    return toView(row);
  }

  async list(filter: ListSubscriptionsFilter = {}): Promise<ListSubscriptionsPage> {
    const limit = clampLimit(filter.limit);
    const cursor = filter.cursor !== undefined ? decodeCursor(filter.cursor) : null;
    if (filter.cursor !== undefined && cursor === null) {
      throw new WebhookValidationError('invalid cursor');
    }

    const conds: SQL[] = [];
    if (filter.activeOnly === true) conds.push(eq(webhookSubscriptions.isActive, true));
    if (cursor) {
      const keyset = or(
        lt(webhookSubscriptions.createdAt, cursor.createdAt),
        and(
          eq(webhookSubscriptions.createdAt, cursor.createdAt),
          lt(webhookSubscriptions.id, cursor.id),
        ),
      );
      if (keyset) conds.push(keyset);
    }
    const where = conds.length > 0 ? and(...conds) : undefined;

    const rows = await this.db
      .select(VIEW_COLUMNS)
      .from(webhookSubscriptions)
      .where(where)
      .orderBy(desc(webhookSubscriptions.createdAt), desc(webhookSubscriptions.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(toView);
    if (!hasMore) return { items };
    const last = pageRows[pageRows.length - 1];
    if (last === undefined) return { items };
    return { items, nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) };
  }

  /** Update url / events / active flag. Secret is never touched here (use rotate). */
  async update(
    subscriptionId: string,
    patch: UpdateSubscriptionInput,
  ): Promise<WebhookSubscriptionView> {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.url !== undefined) set['url'] = validateUrl(patch.url);
    if (patch.events !== undefined) set['events'] = validateEvents(patch.events);
    if (patch.isActive !== undefined) set['isActive'] = patch.isActive;

    const updated = await this.db
      .update(webhookSubscriptions)
      .set(set)
      .where(eq(webhookSubscriptions.id, subscriptionId))
      .returning(VIEW_COLUMNS);
    const row = updated[0];
    if (row === undefined) throw new WebhookSubscriptionNotFoundError(subscriptionId);
    return toView(row);
  }

  /** Rotate the signing secret; returns the NEW secret once. */
  async rotateSecret(subscriptionId: string): Promise<CreatedSubscription> {
    const secret = generateWebhookSecret();
    const updated = await this.db
      .update(webhookSubscriptions)
      .set({ secret, updatedAt: sql`now()` })
      .where(eq(webhookSubscriptions.id, subscriptionId))
      .returning(VIEW_COLUMNS);
    const row = updated[0];
    if (row === undefined) throw new WebhookSubscriptionNotFoundError(subscriptionId);
    return { subscription: toView(row), secret };
  }

  /**
   * Hard-delete a subscription. Refused with {@link WebhookHasDeliveriesError} if
   * delivery history references it (FK restrict) — deactivate instead to keep the
   * ledger.
   */
  async remove(subscriptionId: string): Promise<void> {
    const existing = await this.db
      .select({ id: webhookSubscriptions.id })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, subscriptionId))
      .limit(1);
    if (existing[0] === undefined) throw new WebhookSubscriptionNotFoundError(subscriptionId);
    try {
      await this.db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new WebhookHasDeliveriesError(subscriptionId);
      throw err;
    }
  }
}
