/**
 * `fetch` with a hard wall-clock timeout.
 *
 * Every production provider transport (Gmail / Twilio / Deepgram / Anthropic)
 * called global `fetch` with no timeout. A single hung upstream socket would then
 * wedge the calling worker/request forever, holding its DB claim and leaking a
 * pending connection — under load one slow provider stalls the whole pool. This
 * bounds every outbound call: on timeout the fetch aborts and rejects, so the
 * caller's existing error path runs instead of hanging.
 *
 * No enums / namespaces / parameter properties (host type-stripping constraint).
 */

/** Default outbound timeout (ms). Generous enough for slow-but-alive providers. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(url, { ...init, signal });
}
