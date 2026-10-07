import { issueSyncJwt } from '../../../packages/platform/src/sync-jwt.js';
import { Hono } from 'hono';
import { authMiddleware } from '../../../packages/gateway/src/auth.js';
import { markVerifiedRuntimeBearer, requireRequestPrincipal } from '../../../packages/gateway/src/request-principal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatGptPlanPeerRoutes } from '../../../packages/gateway/src/bots/chatgpt-plan-peer-routes.js';
import { ChatGptPlanPeerError } from '../../../packages/gateway/src/bots/chatgpt-plan-peers.js';

const root = '/api/chatgpt-plan/device';
const post = (body: unknown, bearer = true) => ({ method: 'POST', headers: {
  'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer fixture' } : {}),
}, body: JSON.stringify(body) });
function fixture(owner = 'owner', source = 'jwt') {
  const challenge = vi.fn((id: string) => {
    if (id !== 'owner') throw new ChatGptPlanPeerError('forbidden');
    return { version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer' };
  });
  const app = new Hono();
  app.use('*', async (c, next) => { markVerifiedRuntimeBearer(c); await next(); });
  app.route('/', createChatGptPlanPeerRoutes({ getPrincipal: () => ({ userId: owner, source }) as never,
    peers: { challenge } as never }));
  return { app, challenge };
}
describe('native device enrollment boundary', () => {
  it('requires bearer owner and excludes development principals', async () => {
    for (const f of [fixture('other'), fixture('owner', 'dev-default')]) {
      expect((await f.app.request(`${root}/challenge`, post({}))).status).toBe(403);
    }
    const f = fixture();
    expect((await f.app.request(`${root}/challenge`, post({}, false))).status).toBe(403);
    expect(f.challenge).not.toHaveBeenCalled();
  });
  it('validates the payload and caps it before peer invocation', async () => {
    const f = fixture();
    expect((await f.app.request(`${root}/challenge`, post({ unrelated: true }))).status).toBe(400);
    expect((await f.app.request(`${root}/challenge`, post({ pad: 'a'.repeat(1100001) }))).status).toBe(413);
    expect(f.challenge).not.toHaveBeenCalled();
    const result = await f.app.request(`${root}/challenge`, post({}));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(await result.json()).toMatchObject({ ownerId: 'owner', computerId: 'computer' });
  });
});


afterEach(() => vi.unstubAllEnvs());
function authenticatedFixture(token?: string) {
  const challenge = vi.fn(() => ({ version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer' }));
  const app = new Hono();
  app.use('*', authMiddleware(token));
  app.route('/', createChatGptPlanPeerRoutes({ peers: { challenge } as never,
    getPrincipal: c => requireRequestPrincipal(c, { configuredUserId: 'owner', isTrustedSingleUserGateway: true }) }));
  return { app, challenge };
}
it('refuses arbitrary bearer enrollment in an insecure-dev gateway with a configured owner', async () => {
  vi.stubEnv('MATRIX_AUTH_ALLOW_INSECURE_DEV', '1');
  const f = authenticatedFixture();
  expect((await f.app.request(`${root}/challenge`, post({}))).status).toBe(403);
  expect(f.challenge).not.toHaveBeenCalled();
});
it('preserves enrollment through a genuinely validated configured-runtime bearer', async () => {
  const f = authenticatedFixture('fixture');
  expect((await f.app.request(`${root}/challenge`, post({}))).status).toBe(200);
  expect(f.challenge).toHaveBeenCalledTimes(1);
});

it('accepts a verified owner JWT and rejects one bound to another Computer', async () => {
  const secret = 'plan-peer-jwt-fixture-secret-at-least-32-characters';
  vi.stubEnv('PLATFORM_JWT_SECRET', secret);
  vi.stubEnv('PLATFORM_JWT_PUBLIC_KEY', '');
  vi.stubEnv('MATRIX_HANDLE', 'computer');
  vi.stubEnv('MATRIX_RUNTIME_SLOT', 'primary');
  const f = authenticatedFixture('runtime-static-secret');
  const ownerToken = await issueSyncJwt({ secret, clerkUserId: 'owner', handle: 'computer', gatewayUrl: 'https://matrix.test' });
  const good = post({}); good.headers.authorization = `Bearer ${ownerToken.token}`;
  expect((await f.app.request(`${root}/challenge`, good)).status).toBe(200);
  const foreignToken = await issueSyncJwt({ secret, clerkUserId: 'owner', handle: 'other', gatewayUrl: 'https://matrix.test' });
  const foreign = post({}); foreign.headers.authorization = `Bearer ${foreignToken.token}`;
  expect((await f.app.request(`${root}/challenge`, foreign)).status).toBe(401);
  expect(f.challenge).toHaveBeenCalledTimes(1);
});

it('admits escaping-heavy near-limit SSE replies and rejects encoded/decoded oversize', async () => {
  const { ChatGptPlanPeerReplySchema } = await import('@matrix-os/contracts');
  const { assertChatGptPlanCompleted } = await import('../../../packages/gateway/src/bots/chatgpt-plan-wire.js');
  const reply = vi.fn((_owner: string, input: unknown) => {
    const parsed = ChatGptPlanPeerReplySchema.parse(input);
    if (parsed.ok) assertChatGptPlanCompleted(parsed.body, 'fixture-model');
    return { version: 1, ok: true };
  });
  const app = new Hono();
  app.use('*', async (c, next) => { markVerifiedRuntimeBearer(c); await next(); });
  app.route('/', createChatGptPlanPeerRoutes({ getPrincipal: () => ({ userId: 'owner', source: 'jwt' }) as never, peers: { reply } as never }));
  const terminal = 'data: {"type":"response.completed","response":{"status":"completed","model":"fixture-model"}}\n\n';
  const body = `: ${'\u0001'.repeat(1024 * 1024 - terminal.length - 5)}\n\n${terminal}`;
  const envelope = { version: 1, sessionId: '00000000-0000-4000-8000-000000000001', id: '00000000-0000-4000-8000-000000000002', ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body };
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(1100000);
  expect((await app.request(`${root}/reply`, post(envelope))).status).toBe(200);
  expect(reply).toHaveBeenCalledTimes(1);
  expect((await app.request(`${root}/reply`, post({ ...envelope, body: 'é'.repeat(600000) }))).status).toBe(400);
  expect((await app.request(`${root}/reply`, post({ ...envelope, body: '\u0001'.repeat(1024 * 1024 + 1000) }))).status).toBe(413);
});
