import { describe, it, expect, vi } from 'vitest';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import type { PlatformDb } from '../../packages/gateway/src/platform-db.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';

function fixture(connected = true) {
  const db = {
    listConnectedServices: vi.fn().mockResolvedValue(connected ? [{ id: 'c', service: 'linear', status: 'active', account_label: 'linear', pipedream_account_id: 'account_owner' }] : []),
    getUserById: vi.fn().mockResolvedValue({ pipedream_external_id: 'owner' }),
    touchServiceUsage: vi.fn(),
  };
  const pipedream = { getAppInfo: vi.fn().mockResolvedValue(null), proxyPost: vi.fn().mockResolvedValue({ data: { viewer: { id: 'owner' } } }), listAccounts: vi.fn() };
  const app = createIntegrationRoutes({ db: db as unknown as PlatformDb, pipedream: pipedream as unknown as PipedreamConnectClient, webhookSecret: 'test', resolveUserId: async () => 'owner' });
  const call = (action = 'symphony_viewer', params = {}) => app.request('/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'linear', action, params }) });
  return { db, pipedream, call };
}

describe('Symphony integration route contract', () => {
  it('uses owner credentials and preserves the Linear response envelope', async () => {
    const { call, pipedream } = fixture();
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { data: { viewer: { id: 'owner' } } } });
    expect(pipedream.proxyPost).toHaveBeenCalledWith(expect.objectContaining({ externalUserId: 'owner', accountId: 'account_owner', url: 'https://api.linear.app/graphql' }));
  });
  it('does not discover accounts when Linear is disconnected', async () => {
    const { call, pipedream } = fixture(false);
    expect((await call()).status).toBe(404);
    expect(pipedream.listAccounts).not.toHaveBeenCalled();
    expect(pipedream.proxyPost).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 422])('preserves permanent provider classification for %s without raw errors', async status => {
    const { call, pipedream } = fixture();
    pipedream.proxyPost.mockRejectedValue(Object.assign(new Error('secret raw provider failure'), { statusCode: status }));
    const response = await call();
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain('secret');
  });
  it('keeps transient responses retryable', async () => {
    const { call, pipedream } = fixture();
    pipedream.proxyPost.mockRejectedValue({ statusCode: 429 });
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });
  it('rejects arbitrary query input before contacting the provider', async () => {
    const { call, pipedream } = fixture();
    expect((await call('symphony_viewer', { query: 'mutation { dangerous }' })).status).toBe(400);
    expect((await call('graphql')).status).toBe(400);
    expect(pipedream.proxyPost).not.toHaveBeenCalled();
  });
  it('recognizes documented rate limiting inside a provider HTTP 400', async () => {
    const { call, pipedream } = fixture();
    pipedream.proxyPost.mockRejectedValue({ statusCode: 400, body: { errors: [{ extensions: { code: 'RATELIMITED' } }] } });
    expect((await call()).status).toBe(429);
  });

  it.each([200, 400])('isolates item errors with HTTP %s without leaking provider details', async status => {
    const { call, pipedream } = fixture();
    const body = { errors: [{ message: 'secret provider detail', extensions: { code: 'BAD_USER_INPUT' } }] };
    if (status === 200) pipedream.proxyPost.mockResolvedValue(body as never);
    else pipedream.proxyPost.mockRejectedValue({ statusCode: status, body });
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'linear', action: 'symphony_viewer', data: { errors: [{ extensions: { code: 'OPERATION_FAILED' } }] } });
  });
  it('suspends authentication errors carried in a successful HTTP response', async () => {
    const { call, pipedream } = fixture();
    pipedream.proxyPost.mockResolvedValue({ errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] } as never);
    expect((await call()).status).toBe(422);
  });

});
