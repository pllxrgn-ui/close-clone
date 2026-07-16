/**
 * HTTP transport seam (Task 5a). Every network call the OIDC client makes —
 * discovery-document GET, JWKS GET, token-endpoint POST — goes through this
 * interface, so tests inject a {@link import('../testing/local-oidc-issuer.ts').LocalOidcIssuer}
 * double and NEVER touch the network (CONTRACTS §C9: works under MOCK_MODE with
 * zero external accounts). Production wires {@link createFetchTransport}.
 */

export interface HttpTransport {
  /** GET `url`, parse JSON. Rejects on non-2xx or a network error. */
  getJson(url: string): Promise<unknown>;
  /** POST `application/x-www-form-urlencoded`, parse JSON. Rejects on non-2xx. */
  postForm(url: string, body: Record<string, string>): Promise<unknown>;
}

export class TransportError extends Error {
  readonly url: string;
  readonly status: number | undefined;
  constructor(url: string, message: string, status?: number) {
    super(message);
    this.name = 'TransportError';
    this.url = url;
    this.status = status;
  }
}

/**
 * The production transport, backed by the Node global `fetch`. Timeouts are the
 * caller's concern (Fastify request lifecycle); this stays a thin adapter so the
 * seam — not the HTTP client — is what tests target.
 */
export function createFetchTransport(): HttpTransport {
  return {
    async getJson(url: string): Promise<unknown> {
      const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
      if (!res.ok) throw new TransportError(url, `GET failed: ${res.status}`, res.status);
      return res.json();
    },
    async postForm(url: string, body: Record<string, string>): Promise<unknown> {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(body).toString(),
      });
      if (!res.ok) throw new TransportError(url, `POST failed: ${res.status}`, res.status);
      return res.json();
    },
  };
}
