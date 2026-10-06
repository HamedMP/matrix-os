import { describe, expect, it, vi } from 'vitest';
import { createBotProviderConnectionRoutes } from '../../../packages/gateway/src/bots/provider-connection-routes.js';
import { BotProviderConnectionError } from '../../../packages/gateway/src/bots/provider-connections.js';
import { MissingRequestPrincipalError } from '../../../packages/gateway/src/request-principal.js';
const catalog = { connections: [] };
function fixture() {
  const service = { connections: vi.fn(async () => catalog), authorize: vi.fn(async () => catalog), execution: vi.fn(async () => ({ revision: 0, connectionId: null, model: null, grantRevision: null })), configure: vi.fn(async () => ({ revision: 1, connectionId: null, model: null, grantRevision: null })) };
  const app = createBotProviderConnectionRoutes({ service: service as never, getPrincipal: () => ({ userId: 'owner' }) as never });
  return { app, service };
}
describe('owner Bot authorization routes', () => {
  it('requires a principal and returns private noncached data', async () => {
    const denied = createBotProviderConnectionRoutes({ getPrincipal: () => { throw new MissingRequestPrincipalError(); } });
    expect((await denied.request('/api/bot-connections')).status).toBe(401);
    const { app, service } = fixture(); const result = await app.request('/api/bot-connections');
    expect(result.headers.get('cache-control')).toBe('private, no-store'); expect(await result.json()).toEqual(catalog); expect(service.connections).toHaveBeenCalledWith('owner', false);
    await app.request('/api/bot-connections?includeChatgptPlan=true');
    expect(service.connections).toHaveBeenLastCalledWith('owner', true);
    expect((await createBotProviderConnectionRoutes({ getPrincipal: () => ({ userId: 'owner' }) as never }).request('/api/bot-connections')).status).toBe(503);
  });
  it('rejects unknown options, malformed bodies and oversized writes before calling a service', async () => {
    const { app, service } = fixture();
    const post = (path: string, body: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect((await post('/api/bot-connections/custom/authorization', '{}')).status).toBe(400);
    expect((await post('/api/bot-connections/claude_code_tasks/authorization', JSON.stringify({ baseRevision: 0, enabled: true, background: false, command: 'unsafe' }))).status).toBe(400);
    expect((await post('/api/bot-connections/claude_code_tasks/authorization', '{')).status).toBe(400);
    expect((await post('/api/chat-agents/bot_test1234/execution', 'x'.repeat(8193))).status).toBe(413);
    expect(service.authorize).not.toHaveBeenCalled(); expect(service.configure).not.toHaveBeenCalled();
  });
  it('passes only exact owner, Bot and revision-bound selection and normalizes failures', async () => {
    const { app, service } = fixture();
    const body = { baseRevision: 0, connectionId: 'claude_code_tasks', model: 'observed' };
    const request = () => app.request('/api/chat-agents/bot_test1234/execution', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await request()).status).toBe(200); expect(service.configure).toHaveBeenCalledWith('owner', 'bot_test1234', body);
    service.configure.mockRejectedValueOnce(new BotProviderConnectionError('conflict')); expect((await request()).status).toBe(409);
    service.configure.mockRejectedValueOnce(new Error('/private/native token profile')); const result = await request(); expect(result.status).toBe(503); expect(await result.text()).not.toContain('/private');
  });
});
