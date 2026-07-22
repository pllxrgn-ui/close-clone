import { describe, expect, test, vi } from 'vitest';
import {
  createSecureWebhookSender,
  resolvePublicWebhookTarget,
  type WebhookAddressResolver,
  type PinnedWebhookTransport,
} from './secure-sender.ts';

const publicResolver: WebhookAddressResolver = async () => [
  { address: '93.184.216.34', family: 4 },
];

describe('resolvePublicWebhookTarget', () => {
  test('resolves a public host and returns a pinned address', async () => {
    await expect(
      resolvePublicWebhookTarget('https://hooks.example.com/events', publicResolver),
    ).resolves.toMatchObject({
      hostname: 'hooks.example.com',
      address: '93.184.216.34',
      family: 4,
    });
  });

  test.each(['127.0.0.1', '10.0.0.8', '169.254.169.254', '::1', 'fc00::1'])(
    'rejects a hostname that resolves to non-public address %s',
    async (address) => {
      const resolver: WebhookAddressResolver = async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ];
      await expect(
        resolvePublicWebhookTarget('https://hooks.example.com/events', resolver),
      ).rejects.toThrow(/not a public address/i);
    },
  );

  test('rejects the whole answer when DNS mixes public and private addresses', async () => {
    const resolver: WebhookAddressResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.4', family: 4 },
    ];
    await expect(
      resolvePublicWebhookTarget('https://hooks.example.com/events', resolver),
    ).rejects.toThrow(/not a public address/i);
  });

  test('pins an already-public IP literal without a DNS lookup', async () => {
    const resolver = vi.fn<WebhookAddressResolver>();
    await expect(
      resolvePublicWebhookTarget('https://93.184.216.34/events', resolver),
    ).resolves.toMatchObject({ address: '93.184.216.34', family: 4 });
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('createSecureWebhookSender', () => {
  test('sends through a transport pinned to the checked IP while preserving the hostname', async () => {
    const post = vi.fn<PinnedWebhookTransport['post']>().mockResolvedValue({ status: 204 });
    const sender = createSecureWebhookSender({ resolver: publicResolver, transport: { post } });

    await expect(
      sender({
        url: 'https://hooks.example.com/events',
        headers: { 'x-switchboard-delivery': 'delivery-1' },
        body: '{"ok":true}',
      }),
    ).resolves.toEqual({ status: 204 });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'hooks.example.com',
        address: '93.184.216.34',
        family: 4,
      }),
    );
  });
});
