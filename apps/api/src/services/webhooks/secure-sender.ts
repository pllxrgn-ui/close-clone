import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

import { WebhookValidationError } from './errors.ts';
import type { WebhookSendInput, WebhookSendResult, WebhookSender } from './delivery.ts';
import { assertPublicWebhookHost } from './service.ts';

export interface ResolvedWebhookAddress {
  address: string;
  family: 4 | 6;
}

export type WebhookAddressResolver = (
  hostname: string,
) => Promise<readonly ResolvedWebhookAddress[]>;

export interface PinnedWebhookRequest extends WebhookSendInput, ResolvedWebhookAddress {
  hostname: string;
}

export interface PinnedWebhookTransport {
  post(input: PinnedWebhookRequest): Promise<WebhookSendResult>;
}

export interface SecureWebhookSenderOptions {
  resolver?: WebhookAddressResolver;
  transport?: PinnedWebhookTransport;
}

const resolveAll: WebhookAddressResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new WebhookValidationError(`unsupported address family for ${hostname}`);
    }
    return { address: answer.address, family: answer.family };
  });
};

/** Resolve once, reject every non-public answer, then select the address to pin. */
export async function resolvePublicWebhookTarget(
  url: string,
  resolver: WebhookAddressResolver = resolveAll,
): Promise<{ url: string; hostname: string } & ResolvedWebhookAddress> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookValidationError(`invalid webhook url: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new WebhookValidationError('webhook url must use https');
  }
  assertPublicWebhookHost(parsed.hostname);

  const bareHostname =
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  const literalFamily = isIP(bareHostname);
  const addresses =
    literalFamily === 4 || literalFamily === 6
      ? [{ address: bareHostname, family: literalFamily } as const]
      : await resolver(parsed.hostname);
  if (addresses.length === 0) {
    throw new WebhookValidationError(`webhook url host did not resolve: ${parsed.hostname}`);
  }
  for (const answer of addresses) assertPublicWebhookHost(answer.address);
  const selected = addresses[0]!;
  return {
    url: parsed.toString(),
    hostname: parsed.hostname,
    address: selected.address,
    family: selected.family,
  };
}

const nodeHttpsTransport: PinnedWebhookTransport = {
  post(input) {
    return new Promise((resolve, reject) => {
      const req = request(
        input.url,
        {
          method: 'POST',
          headers: {
            ...input.headers,
            'content-length': String(Buffer.byteLength(input.body)),
          },
          lookup: (_hostname, _options, callback) => {
            callback(null, input.address, input.family);
          },
          timeout: 10_000,
        },
        (response) => {
          response.resume();
          resolve({ status: response.statusCode ?? 0 });
        },
      );
      req.once('timeout', () => req.destroy(new Error('webhook delivery timed out')));
      req.once('error', reject);
      req.end(input.body);
    });
  },
};

/**
 * Outbound sender that defeats DNS rebinding: DNS is checked once and the HTTPS
 * socket is forced to the checked address while URL hostname/SNI stay intact.
 * Redirects are deliberately not followed.
 */
export function createSecureWebhookSender(options: SecureWebhookSenderOptions = {}): WebhookSender {
  const resolver = options.resolver ?? resolveAll;
  const transport = options.transport ?? nodeHttpsTransport;
  return async (input) => {
    const target = await resolvePublicWebhookTarget(input.url, resolver);
    return transport.post({
      ...input,
      url: target.url,
      hostname: target.hostname,
      address: target.address,
      family: target.family,
    });
  };
}
