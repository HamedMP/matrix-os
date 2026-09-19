import { describe, expect, it, vi } from 'vitest';
import type { UsersTable } from '../../packages/gateway/src/platform-db.js';
import { createCustomMcpProjectionRequest } from '../../packages/platform/src/custom-mcp-projection.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';

const user: Pick<UsersTable, 'handle' | 'clerk_id'> = { handle: 'pr-1733', clerk_id: 'user_fixture' };
const machine = { status: 'running', publicIPv4: '8.8.8.8', clerkUserId: user.clerk_id };
const platformSecret = 'preview-only-platform-secret';
function setup(owner = user, runtime = machine) {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const request = createCustomMcpProjectionRequest({ getUser: async () => owner, getMachine: async () => runtime, platformSecret, fetchFn });
  return { request, fetchFn };
}

describe('Custom MCP projection request with real database row shape', () => {
  it('accepts a matching owner and forwards the database clerk_id', async () => {
    const { request, fetchFn } = setup();
    await expect(request('user-id', 'POST', undefined, { id: 'server' })).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledWith('https://8.8.8.8:443/api/internal/mcp-projection', expect.objectContaining({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal), body: '{"id":"server"}',
      headers: expect.objectContaining({ 'x-matrix-clerk-user-id': user.clerk_id,
        authorization: `Bearer ${buildPlatformVerificationToken(user.handle, platformSecret)}` }),
    }));
  });

  it('rejects a machine belonging to another owner before making a network request', async () => {
    const { request, fetchFn } = setup(user, { ...machine, clerkUserId: 'user_other' });
    await expect(request('user-id', 'POST')).rejects.toThrow('owner runtime is unavailable');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('handles GET and empty DELETE responses while rejecting failed upstream writes', async () => {
    const { request, fetchFn } = setup();
    await request('user-id', 'GET', 'server');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://8.8.8.8:443/api/internal/mcp-projection/server');
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(request('user-id', 'DELETE', 'server')).resolves.toBeUndefined();
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(request('user-id', 'POST')).rejects.toThrow('projection failed');
  });
});
