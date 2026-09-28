import { describe, expect, it, vi } from 'vitest';
import { createCustomMcpProjection } from '../../packages/platform/src/custom-mcp-projection.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';

const platformSecret = 'fanout-platform-secret';
const owner = { handle: 'owner', clerk_id: 'user_owner' };
const primary = { status: 'running', publicIPv4: '203.0.113.1', clerkUserId: owner.clerk_id, handle: 'owner' };
const preview = {
  machineId: '00000000-0000-4000-8000-000000001907',
  status: 'running',
  publicIPv4: '203.0.113.2',
  clerkUserId: owner.clerk_id,
  handle: 'pv-1907-3fa91c2e',
};
const strangersPreview = { ...preview, machineId: '00000000-0000-4000-8000-000000001908', publicIPv4: '203.0.113.3', clerkUserId: 'user_other', handle: 'pv-1907-0badf00d' };

function setup(options: { primaryStatus?: number; previewStatus?: number; eligible?: boolean } = {}) {
  const fetchFn = vi.fn(async (url: string) => new Response('{}', {
    status: url.includes('203.0.113.1') ? options.primaryStatus ?? 200 : options.previewStatus ?? 200,
  }));
  const logError = vi.fn();
  const isEligible = vi.fn(async () => options.eligible ?? true);
  const projection = createCustomMcpProjection({
    getUser: async () => owner,
    getMachine: async () => primary,
    listPrivatePreviews: async () => [preview, strangersPreview] as never,
    isEligible,
    platformSecret,
    fetchFn: fetchFn as unknown as typeof fetch,
    logError,
  });
  const hosts = () => fetchFn.mock.calls.map(([url]) => new URL(String(url)).hostname);
  return { projection, fetchFn, logError, isEligible, hosts };
}

describe('Custom MCP projection fan-out to Private Previews', () => {
  it('pushes to the primary and then to the owner\'s eligible Private Previews', async () => {
    const { projection, fetchFn, hosts } = setup();
    await projection.upsert('user-id', { id: 'server', revision: 3 });
    expect(hosts()).toEqual(['203.0.113.1', '203.0.113.2']);
    const [, previewInit] = fetchFn.mock.calls[1] as unknown as [string, RequestInit];
    expect(previewInit).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: '{"id":"server","revision":3}',
      headers: expect.objectContaining({
        authorization: `Bearer ${buildPlatformVerificationToken(preview.handle, platformSecret)}`,
        'x-matrix-clerk-user-id': owner.clerk_id,
      }),
    });
  });

  it('skips Private Previews that are not eligible', async () => {
    const { projection, hosts } = setup({ eligible: false });
    await projection.remove('user-id', 'server');
    expect(hosts()).toEqual(['203.0.113.1']);
  });

  it('still reaches Private Previews when the primary push fails, and reports the primary failure', async () => {
    const { projection, hosts } = setup({ primaryStatus: 503 });
    await expect(projection.upsert('user-id', { id: 'server' })).rejects.toThrow('Custom MCP projection failed (503)');
    expect(hosts()).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('never fails the owner\'s change because a Private Preview is unreachable', async () => {
    const { projection, logError } = setup({ previewStatus: 502 });
    await expect(projection.upsert('user-id', { id: 'server' })).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('reads only from the primary', async () => {
    const { projection, hosts, isEligible } = setup();
    await projection.read('user-id', 'server');
    expect(hosts()).toEqual(['203.0.113.1']);
    expect(isEligible).not.toHaveBeenCalled();
  });
});
