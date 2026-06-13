import { describe, expect, it, vi } from 'vitest';
import { createHetznerClient } from '../../packages/platform/src/customer-vps-hetzner.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import type { CustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';

const config = {
  hetznerApiToken: 'token',
  location: 'nbg1',
  serverType: 'cpx22',
  image: 'ubuntu-24.04',
} as CustomerVpsConfig;

const createInput = {
  name: 'matrix-test',
  userData: '#cloud-config\n',
  labels: { app: 'matrix-os' },
};

describe('platform/customer-vps-hetzner', () => {
  it('rejects user_data over the Hetzner 32KiB limit before calling the API', async () => {
    // Hetzner 422s oversized user_data with a generic invalid_input; the
    // platform must fail with an attributable code instead of an opaque
    // provider_unavailable.
    const fetchImpl = vi.fn();
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);
    const oversized = { ...createInput, userData: 'x'.repeat(32 * 1024 + 1) };

    await expect(client.createServer(oversized)).rejects.toMatchObject({
      code: 'user_data_too_large',
      status: 500,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs the provider rejection detail server-side and throws a generic error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response('{"error":{"code":"invalid_input","message":"invalid input in field \'user_data\'"}}', {
          status: 422,
        }),
      );
      const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

      await expect(client.createServer(createInput)).rejects.toMatchObject({
        code: 'provider_unavailable',
      });
      const logged = consoleError.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('HTTP 422');
      expect(logged).toContain('invalid_input');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('maps 429 to quota_exceeded without logging a rejection', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);
    await expect(client.createServer(createInput)).rejects.toMatchObject({
      code: 'quota_exceeded',
      status: 429,
    });
  });
});
