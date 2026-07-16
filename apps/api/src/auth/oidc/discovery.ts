import { z } from 'zod';

import type { HttpTransport } from './transport.ts';

/**
 * OIDC discovery-document fetch + cache (Task 5a). The client resolves the IdP's
 * authorization/token/JWKS endpoints from `<issuer>/.well-known/openid-configuration`
 * rather than hard-coding them, so a "generic OIDC issuer" (Google Workspace by
 * default) works without per-provider code. The document is fetched through the
 * injected {@link HttpTransport} (offline in tests) and cached with a TTL.
 */

export const oidcDiscoveryDocumentSchema = z
  .object({
    issuer: z.string().min(1),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    jwks_uri: z.string().url(),
  })
  .passthrough();

export type OidcDiscoveryDocument = z.infer<typeof oidcDiscoveryDocumentSchema>;

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/** `<issuer>/.well-known/openid-configuration`, trailing slash tolerant. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

interface CacheEntry {
  doc: OidcDiscoveryDocument;
  fetchedAtMs: number;
}

export interface DiscoveryCacheOptions {
  transport: HttpTransport;
  now?: () => Date;
  ttlMs?: number;
}

/**
 * Caches the discovery document for one issuer. `issuer` is validated against the
 * document's own `issuer` claim — a mismatch is a configuration/spoofing error and
 * is rejected (the discovered `issuer` is later what ID tokens must be signed by).
 */
export class DiscoveryCache {
  private readonly issuer: string;
  private readonly transport: HttpTransport;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private entry: CacheEntry | null = null;
  private inFlight: Promise<OidcDiscoveryDocument> | null = null;

  constructor(issuer: string, opts: DiscoveryCacheOptions) {
    this.issuer = issuer.replace(/\/+$/, '');
    this.transport = opts.transport;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  private fresh(entry: CacheEntry): boolean {
    return this.now().getTime() - entry.fetchedAtMs < this.ttlMs;
  }

  async get(): Promise<OidcDiscoveryDocument> {
    if (this.entry !== null && this.fresh(this.entry)) return this.entry.doc;
    // Collapse concurrent fetches so a burst of logins hits the IdP once.
    this.inFlight ??= this.fetch();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetch(): Promise<OidcDiscoveryDocument> {
    const raw = await this.transport.getJson(discoveryUrl(this.issuer));
    const parsed = oidcDiscoveryDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DiscoveryError(`invalid OIDC discovery document: ${parsed.error.message}`);
    }
    const normalizedDocIssuer = parsed.data.issuer.replace(/\/+$/, '');
    if (normalizedDocIssuer !== this.issuer) {
      throw new DiscoveryError(
        `discovery issuer mismatch: configured ${this.issuer}, document ${normalizedDocIssuer}`,
      );
    }
    this.entry = { doc: parsed.data, fetchedAtMs: this.now().getTime() };
    return parsed.data;
  }
}
