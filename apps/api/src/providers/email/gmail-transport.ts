/**
 * Minimal HTTP transport seam for the Gmail REST adapter. The adapter never
 * references global `fetch` directly — it calls a `GmailTransport`, so unit tests
 * inject a fixture-backed transport and NO network is touched (task 2b: "unit-test
 * against recorded/synthetic response fixtures only"). The default transport wraps
 * global `fetch` for production.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

import { fetchWithTimeout } from '../../lib/fetch-with-timeout.ts';

export interface GmailHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface GmailHttpResponse {
  status: number;
  bodyText: string;
}

export type GmailTransport = (req: GmailHttpRequest) => Promise<GmailHttpResponse>;

/** Production transport backed by global `fetch`, with a hard timeout. */
export const fetchTransport: GmailTransport = async (req) => {
  const init: RequestInit = { method: req.method, headers: req.headers };
  if (req.body !== undefined) init.body = req.body;
  const res = await fetchWithTimeout(req.url, init);
  const bodyText = await res.text();
  return { status: res.status, bodyText };
};
