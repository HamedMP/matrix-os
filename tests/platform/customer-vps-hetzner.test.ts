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

  it('does not misclassify an unrelated HTTP 400 as a snapshot clone rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response('{"error":{"code":"invalid_input","message":"invalid server name","details":{"fields":[{"name":"name","messages":["is invalid"]}]}}}', {
          status: 400,
        }),
      );
      const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

      await expect(client.createServer({ ...createInput, image: 302 })).rejects.toMatchObject({
        code: 'provider_unavailable',
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('classifies a bounded provider image-field rejection as a snapshot clone rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response('{"error":{"code":"invalid_input","message":"invalid input","details":{"fields":[{"name":"image","messages":["is incompatible"]}]}}}', {
          status: 422,
        }),
      );
      const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

      await expect(client.createServer({ ...createInput, image: 302 })).rejects.toMatchObject({
        code: 'snapshot_clone_rejected',
      });
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

  it('uses a validated per-machine location instead of the platform default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      server: {
        id: 123456,
        status: 'initializing',
        public_net: { ipv4: { ip: '203.0.113.10' } },
      },
    }), { status: 201 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await client.createServer({ ...createInput, location: 'hil' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/servers',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"location":"hil"'),
      }),
    );
  });

  it('changes server type without upgrading disk so future downgrades remain possible', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"action":{"id":42}}', { status: 201 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await client.resizeServer(123456, { serverType: 'cpx32', upgradeDisk: false });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/servers/123456/actions/change_type',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ server_type: 'cpx32', upgrade_disk: false }),
      }),
    );
  });

  it('shuts servers down and powers them off or on through Hetzner actions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"action":{"id":42}}', { status: 201 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await client.shutdownServer(123456);
    await client.powerOffServer(123456);
    await client.powerOnServer(123456);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.hetzner.cloud/v1/servers/123456/actions/shutdown',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.hetzner.cloud/v1/servers/123456/actions/poweroff',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://api.hetzner.cloud/v1/servers/123456/actions/poweron',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('maps provider server type from server reads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      server: {
        id: 123456,
        status: 'running',
        server_type: { name: 'cpx32' },
        public_net: { ipv4: { ip: '203.0.113.10' } },
      },
    }), { status: 200 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await expect(client.getServer(123456)).resolves.toMatchObject({
      id: 123456,
      status: 'running',
      serverType: 'cpx32',
      publicIPv4: '203.0.113.10',
    });
  });
});
