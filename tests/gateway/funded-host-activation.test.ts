import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { authMiddleware } from '../../packages/gateway/src/auth.js';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformFundedAiHostConfigRoutes } from '../../packages/gateway/src/funded-host-activation.js';
import { FundedHostActivationRequestSchema, FundedHostActivationResponseSchema } from '../../packages/contracts/src/funded-host-activation.js';
const now = Date.parse('2026-10-18T12:00:00.000Z');
const token = 'upgrade-secret-independent';
const request = { contractVersion: 1 as const, identity: { handle: 'alice', machineId: 'machine-1', ownerId: 'user_1', runtimeSlot: 'primary' as const, runtimeTokenEpoch: 1 }, configuration: { enabled: true as const, platformOrigin: 'https://app.matrix-os.com' as const, relayOrigin: 'https://matrix-ai-relay-production-jqxkjdhtkq-ey.a.run.app', runtimeToken: 'a'.repeat(64) } };
const env = { UPGRADE_TOKEN: token, MATRIX_HANDLE: 'alice', MATRIX_MACHINE_ID: 'machine-1', MATRIX_CLERK_USER_ID: 'user_1', MATRIX_RUNTIME_SLOT: 'primary', MATRIX_FUNDED_AI_ENABLED: 'false' };
const proof = () => ({ ...request, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString() });
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
function fixture(overrides: Record<string, unknown> = {}) {
  const applyConfig = vi.fn().mockResolvedValue(undefined), scheduleRestart = vi.fn().mockResolvedValue(undefined);
  const fetcher = vi.fn().mockImplementation(async () => Response.json(proof()));
  const isIdle = vi.fn().mockReturnValue(true);
  const app = createPlatformFundedAiHostConfigRoutes({ env: { ...env }, now: () => now, fetch: fetcher, applyConfig, scheduleRestart, isIdle, ...overrides });
  const post = (body: unknown = request, customHeaders = headers) => app.request('/config', { method: 'POST', headers: customHeaders, body: JSON.stringify(body) });
  return { app, post, applyConfig, scheduleRestart, fetcher, isIdle };
}
describe('funded host activation contract', () => {
  it('accepts authoritative trailing-hyphen handles and rejects one-character handles', () => {
    expect(FundedHostActivationRequestSchema.safeParse({ ...request, identity: { ...request.identity, handle: 'alice-' } }).success).toBe(true);
    expect(FundedHostActivationRequestSchema.safeParse({ ...request, identity: { ...request.identity, handle: 'a' } }).success).toBe(false);
  });
  it('strictly limits every layer, identity, origins, token and freshness window', () => {
    expect(FundedHostActivationRequestSchema.safeParse(request).success).toBe(true);
    for (const value of [{ ...request, extra: true }, { ...request, identity: { ...request.identity, extra: true } }, { ...request, configuration: { ...request.configuration, extra: true } }, { ...request, identity: { ...request.identity, runtimeSlot: 'Invalid Slot' } }, { ...request, identity: { ...request.identity, runtimeTokenEpoch: 0 } }, { ...request, configuration: { ...request.configuration, platformOrigin: 'https://evil.test' } }, { ...request, configuration: { ...request.configuration, relayOrigin: 'https://candidate---matrix-ai-relay-production-x-ey.a.run.app' } }, { ...request, configuration: { ...request.configuration, runtimeToken: 'bad' } }])
      expect(FundedHostActivationRequestSchema.safeParse(value).success).toBe(false);
    expect(FundedHostActivationResponseSchema.safeParse(proof()).success).toBe(true);
    expect(FundedHostActivationResponseSchema.safeParse({ ...proof(), expiresAt: new Date(now + 30001).toISOString() }).success).toBe(false);
  });
});
describe('funded host activation gateway', () => {
  it('validates fresh proof for an authoritative trailing-hyphen handle', async () => {
    const body = { ...request, identity: { ...request.identity, handle: 'alice-' } };
    const f = fixture({ env: { ...env, MATRIX_HANDLE: 'alice-' }, fetch: vi.fn().mockResolvedValue(Response.json({ ...proof(), identity: body.identity })) });
    expect((await f.post(body)).status).toBe(202);
    expect(f.applyConfig).toHaveBeenCalledOnce();
  });
  it('passes independent operator bearer through global authentication to the route verifier', async () => {
    const app = new Hono();
    app.use('*', authMiddleware('different-user-session-token'));
    app.route('/api/internal/platform-funded-ai', createPlatformFundedAiHostConfigRoutes({ env, isIdle: () => true, scheduleRestart: async () => {} }));
    expect((await app.request('/api/internal/platform-funded-ai/config', { headers })).status).toBe(200);
    expect((await app.request('/api/internal/platform-funded-ai/config', { headers: { authorization: 'Bearer different-user-session-token' } })).status).toBe(401);
    expect((await app.request('/api/internal/platform-funded-ai/config/nested', { headers })).status).toBe(401);
  });
  it('requires independent operator auth on both endpoints', async () => {
    const f = fixture();
    expect((await f.post(request, { ...headers, authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await f.app.request('/config')).status).toBe(401);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('caps bodies and rejects malformed JSON', async () => {
    const f = fixture();
    expect((await f.app.request('/config', { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await f.app.request('/config', { method: 'POST', headers, body: 'x'.repeat(4097) })).status).toBe(413);
    expect(f.applyConfig).not.toHaveBeenCalled();
  });
  it('rejects mismatched local identity or present epoch without contacting platform', async () => {
    for (const override of [{ MATRIX_HANDLE: 'bob' }, { MATRIX_MACHINE_ID: 'machine-2' }, { MATRIX_CLERK_USER_ID: 'user_2' }, { MATRIX_RUNTIME_SLOT: 'secondary' }, { MATRIX_RUNTIME_TOKEN_EPOCH: '2' }]) {
      const f = fixture({ env: { ...env, ...override } });
      expect((await f.post()).status).toBe(400);
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });
  it('validates exact fresh read-only platform proof before mutating absent epoch', async () => {
    const f = fixture();
    expect((await f.post()).status).toBe(202);
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, init] = f.fetcher.mock.calls[0];
    expect(String(url)).toBe('https://app.matrix-os.com/internal/containers/alice/ai/activation-config?runtimeSlot=primary');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.authorization).toBe(`Bearer ${request.configuration.runtimeToken}`);
    expect(f.applyConfig).toHaveBeenCalledWith(proof());
    expect(f.scheduleRestart).toHaveBeenCalledOnce();
    expect(await (await f.app.request('/config', { headers })).json()).toEqual({ configured: false, configurationRevision: null });
  });
  it('fails closed for unavailable, stale, future, mismatched and oversized platform proof', async () => {
    for (const response of [new Response('no', { status: 403 }), Response.json({ ...proof(), issuedAt: new Date(now - 30000).toISOString(), expiresAt: new Date(now).toISOString() }), Response.json({ ...proof(), issuedAt: new Date(now + 1).toISOString() }), Response.json({ ...proof(), identity: { ...request.identity, ownerId: 'user_2' } }), Response.json({ ...proof(), configuration: { ...request.configuration, runtimeToken: 'b'.repeat(64) } }), new Response('x'.repeat(4097)), new Response('{}', { headers: { 'content-length': '5000' } })]) {
      const f = fixture({ fetch: vi.fn().mockResolvedValue(response) });
      expect((await f.post()).status).toBe(503);
      expect(f.applyConfig).not.toHaveBeenCalled();
    }
  });
  it('defers busy gateways and rechecks activity after upstream validation', async () => {
    for (const idle of [vi.fn().mockReturnValue(false), vi.fn().mockReturnValueOnce(true).mockReturnValue(false)]) {
      const f = fixture({ isIdle: idle });
      expect((await f.post()).status).toBe(409);
      expect(f.applyConfig).not.toHaveBeenCalled();
    }
  });
  it('defers restart if work begins while configuration is persisted', async () => {
    const isIdle = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    const f = fixture({ isIdle });
    expect((await f.post()).status).toBe(409);
    expect(f.applyConfig).toHaveBeenCalledOnce();
    expect(f.scheduleRestart).not.toHaveBeenCalled();
    isIdle.mockReturnValue(true);
    expect((await f.post()).status).toBe(202);
    expect(f.scheduleRestart).toHaveBeenCalledOnce();
  });
  it('coalesces overlapping mutation attempts rather than racing restarts', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const applyConfig = vi.fn().mockReturnValue(waiting);
    const f = fixture({ applyConfig });
    const first = f.post();
    await vi.waitFor(() => expect(applyConfig).toHaveBeenCalledOnce());
    expect((await f.post()).status).toBe(409);
    finish();
    expect((await first).status).toBe(202);
  });
  it('recognizes the runtime platform fallback on newly provisioned computers without restarting', async () => {
    const loaded = { ...env, PLATFORM_INTERNAL_URL: request.configuration.platformOrigin, MATRIX_RUNTIME_TOKEN_EPOCH: '1', MATRIX_FUNDED_AI_ENABLED: 'true', MATRIX_FUNDED_AI_RELAY_URL: request.configuration.relayOrigin, MATRIX_FUNDED_AI_RUNTIME_TOKEN: request.configuration.runtimeToken };
    const f = fixture({ env: loaded });
    expect(await (await f.app.request('/config', { headers })).json()).toMatchObject({ configured: true });
    expect((await f.post()).status).toBe(200);
    expect(f.applyConfig).not.toHaveBeenCalled(); expect(f.scheduleRestart).not.toHaveBeenCalled();
  });
  it('hashes loaded identity and settings, and never restarts unchanged configuration', async () => {
    const loaded = { ...env, MATRIX_RUNTIME_TOKEN_EPOCH: '1', MATRIX_FUNDED_AI_ENABLED: 'true', MATRIX_FUNDED_AI_PLATFORM_URL: request.configuration.platformOrigin, MATRIX_FUNDED_AI_RELAY_URL: request.configuration.relayOrigin, MATRIX_FUNDED_AI_RUNTIME_TOKEN: request.configuration.runtimeToken };
    const f = fixture({ env: loaded });
    const revision = createHash('sha256').update(['machine-1', 'primary', '1', request.configuration.platformOrigin, request.configuration.relayOrigin, request.configuration.runtimeToken].join('\0')).digest('hex');
    expect(await (await f.app.request('/config', { headers })).json()).toEqual({ configured: true, configurationRevision: revision });
    expect((await f.post()).status).toBe(200);
    expect(f.applyConfig).not.toHaveBeenCalled();
    expect(f.scheduleRestart).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('uses generic errors and releases the in-flight guard after failure', async () => {
    const f = fixture({ applyConfig: vi.fn().mockRejectedValue(new Error('/secret/provider failure')) });
    for (let i = 0; i < 2; i++) {
      const r = await f.post();
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'AI activation failed' });
    }
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});
