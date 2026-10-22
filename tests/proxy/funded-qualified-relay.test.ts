import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createFundedRelay, resolveFundedRelayConfig } from '../../packages/proxy/src/funded-relay.js';
import type { FundedPlatformClient } from '../../packages/proxy/src/funded-relay-platform-client.js';
import { qualifiedRouteFixture, qualifiedLeaseFixture, qualifiedNow as now, qualifiedModel as model } from '../helpers/google-qualified-funded-fixture.js';
import { managedGoogleRouteDescriptorDigest } from '../../packages/proxy/src/funded-google-route-descriptor.js';
const credential = `sk-matrix-google-funded-token_one.${'s'.repeat(43)}`;
function config() { return resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: 'true', MATRIX_FUNDED_AI_RESERVATION_MODE: 'usage',
  CLOUDFLARE_AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/gateway-one/anthropic`, CLOUDFLARE_AI_GATEWAY_TOKEN: 'g'.repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: 'w'.repeat(32),
  PLATFORM_INTERNAL_URL: 'https://platform.example.test', AI_RELAY_CONTROL_TOKEN: 'c'.repeat(32), AI_RELAY_METADATA_SECRET: 'm'.repeat(32),
  MATRIX_FUNDED_GLM_PRICING_REVIEW_VERSION: 'cloudflare-2026-09-10-glm-flash', MATRIX_FUNDED_GLM_PRICING_REVIEWED_AT: '2026-10-21T00:00:00.000Z', MATRIX_FUNDED_GLM_PRICING_VALID_THROUGH: '2026-10-23T00:00:00.000Z' })!; }
function fixture() {
  const route = qualifiedRouteFixture(); route.descriptor.credential.fingerprint = createHash('sha256').update('w'.repeat(32)).digest('hex'); route.digest = managedGoogleRouteDescriptorDigest(route.descriptor);
  const lease = qualifiedLeaseFixture(); const { token: _t, issuedAt: _at, ...tokenIdentity } = lease.credential;
  const identity = { ...lease.identity, ...tokenIdentity }, policy = lease.policy; const binding = { ...route, requestClass: 'interactive' as const };
  const checked = { protocol: 'matrix-google-qualified-funded-v1', authorization: { contractVersion: 1, authorized: true, identity, policy }, binding };
  const funding = { asOf: now.toISOString(), periodStart: '2026-10-01T00:00:00.000Z', monthlyBudgetMicrousd: 1000,
    settledThisMonthMicrousd: 0, reservedMicrousd: 1, reservedThisMonthMicrousd: 1, promotionalBalanceMicrousd: 1000, addonBalanceMicrousd: 0, creditBalanceMicrousd: 1000, remainingBalanceMicrousd: 999, remainingBudgetMicrousd: 999 };
  const authorized = { ...checked, authorization: { ...checked.authorization, funding, reservation: { reservationId: 'reservation_one', requestId: 'request_one', modelId: model,
    reservedMicrousd: 1, billingMode: 'usage', maxCostMicrousd: 1000000000, remainingBalanceMicrousd: 999, remainingBudgetMicrousd: 999, periodStart: funding.periodStart,
    expiresAt: '2026-10-22T12:01:00.000Z', status: 'reserved' } } };
  const { version: _v, kind: _k, ...review } = route.descriptor;
  return { route, checked, authorized, settings: { relayBaseUrl: route.relayBaseUrl, reviews: [review] } };
}
function request(path = '/v1/chat/completions', body: unknown = { model, messages: [{ role: 'user', content: 'private Google text' }], max_tokens: 100, stream: false }) {
  return { path, init: { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'cf-aig-skip-cache': 'false' }, body: JSON.stringify(body) } };
}
function setup(options: { settings?: boolean; check?: (count: number) => Promise<Response | void>; start?: () => Promise<void>; authorize?: () => Promise<void>; generation?: () => Promise<Response>; at?: () => Date } = {}) {
  const data = fixture(); let checks = 0; const actual = vi.fn(async () => options.generation ? options.generation() : Response.json({ success: true, result: { id: 'response_one', model, choices: [{ index: 0, message: { role: 'assistant', content: 'private result' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }));
  const wire = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/qualified/dispatch-check')) { const denied = await options.check?.(++checks); return denied ?? Response.json(data.checked); }
    if (String(url).endsWith('/qualified/authorize')) { data.authorized.authorization.reservation.maxCostMicrousd = JSON.parse(String(init?.body)).maxCostMicrousd; await options.authorize?.(); return Response.json(data.authorized); }
    if (String(url) === data.route.descriptor.upstream.endpoint) return actual();
    throw new Error('Unexpected network target');
  });
  const platform = { check: vi.fn(), authorize: vi.fn(), start: vi.fn(async () => { await options.start?.(); return { reservationId: 'reservation_one', requestId: 'request_one', tokenId: 'token_one' }; }),
    release: vi.fn(async () => ({ reservationId: 'reservation_one', tokenId: 'token_one', status: 'released', reason: 'pre_upstream_failure' })), finalize: vi.fn(async () => ({})) };
  const relay = createFundedRelay({ ...config(), managedRouteControl: options.settings === false ? undefined : data.settings, fetch: wire, now: options.at ?? (() => now),
    platformClient: platform as unknown as FundedPlatformClient, requestIdFactory: () => 'request_one' });
  const app = new Hono(); relay.register(app); app.all('*', c => c.text('unguarded fallback', 418)); return { app, relay, actual, wire, platform, data };
}
describe('qualified route at actual proxy send and release', () => {
  it('uses qualified wire only, fixed actual endpoint/cache controls and preserves exact usage settlement', async () => {
    const f = setup(); try { const r = request(); const response = await f.app.request(r.path, r.init); expect(response.status).toBe(200); expect(await response.text()).toContain('private result'); }
    finally { await f.relay.close(); }
    expect(f.actual).toHaveBeenCalledTimes(1); expect(f.platform.check).not.toHaveBeenCalled(); expect(f.platform.authorize).not.toHaveBeenCalled();
    expect(f.platform.finalize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'exact' }), expect.any(AbortSignal));
    const [url, init] = f.wire.mock.calls.find(([url]) => String(url).includes('/ai/run/'))!; expect(String(url)).toBe(f.data.route.descriptor.upstream.endpoint);
    expect(new Headers(init?.headers).get('cf-aig-skip-cache')).toBe('true'); expect(JSON.parse(String(init?.body)).store).toBe(false);
    for (const [url, init] of f.wire.mock.calls.filter(([url]) => String(url).includes('/qualified/'))) { expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'c'.repeat(32)}`);
      const body = JSON.parse(String(init?.body)); expect(body.expectedDigest).toBe(f.data.route.digest); expect(body).not.toHaveProperty('requestClass'); expect(init?.redirect).toBe('error'); }
  });
  it('never falls through when disabled or missing reviewed configuration', async () => {
    const f = setup({ settings: false }); try { const r = request(); expect((await f.app.request(r.path, r.init)).status).toBe(503); expect(f.actual).not.toHaveBeenCalled(); } finally { await f.relay.close(); }
    const app = new Hono(); const relay = createFundedRelay(null); relay.register(app); app.all('*', c => c.text('unguarded', 418)); const r = request(); expect((await app.request(r.path, r.init)).status).toBe(403);
  });
  it.each(['/v1/messages', '/v1/messages/count_tokens', '/v1/evaluate'])('denies unqualified content path %s without any upstream/control send', async path => {
    const f = setup(); try { const r = request(path); expect((await f.app.request(r.path, r.init)).status).toBe(503); expect(f.wire).not.toHaveBeenCalled(); } finally { await f.relay.close(); }
  });
  it('refuses conflicting qualified/legacy headers instead of selecting the legacy protocol', async () => {
    const f = setup(); try { const r = request(); const response = await f.app.request(r.path, { ...r.init, headers: { ...r.init.headers, 'x-api-key': `sk-matrix-funded-token_one.${'s'.repeat(43)}` } });
      expect(f.platform.check).not.toHaveBeenCalled(); expect(f.platform.authorize).not.toHaveBeenCalled(); expect(f.actual).not.toHaveBeenCalled(); expect(response.status).toBe(503);
    } finally { await f.relay.close(); }
  });
  it('releases an untouched reservation when its authorization response crosses review expiry', async () => {
    let at = new Date(now); const f = setup({ at: () => at, authorize: async () => { at = new Date('2026-10-23T12:00:00.000Z'); } });
    try { const r = request(); expect((await f.app.request(r.path, r.init)).status).toBe(503); expect(f.actual).not.toHaveBeenCalled(); expect(f.platform.start).not.toHaveBeenCalled(); }
    finally { await f.relay.close(); }
    expect(f.platform.release).toHaveBeenCalledExactlyOnceWith({ reservationId: 'reservation_one', tokenId: 'token_one', reason: 'pre_upstream_failure' }, expect.any(AbortSignal));
  });
  it('releases an untouched qualified reservation on a non-policy failure before confirmed start', async () => {
    const f = setup({ start: async () => { throw new DOMException('cancelled', 'AbortError'); } });
    try { const r = request(); expect((await f.app.request(r.path, r.init)).status).toBe(503); expect(f.actual).not.toHaveBeenCalled(); }
    finally { await f.relay.close(); }
    expect(f.platform.release).toHaveBeenCalledOnce(); expect(f.platform.finalize).not.toHaveBeenCalled();
  });
  it('denies after start wait before actual fetch and settles known zero usage', async () => {
    let deny = false; const f = setup({ start: async () => { deny = true; }, check: async () => deny ? Response.json({ error: 'denied' }, { status: 503 }) : undefined });
    try { const r = request(); expect((await f.app.request(r.path, r.init)).status).toBe(503); expect(f.actual).not.toHaveBeenCalled(); } finally { await f.relay.close(); }
    expect(f.platform.finalize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'exact', actualCostMicrousd: 0 }), expect.any(AbortSignal));
  });
  it('rechecks review expiry after an awaited control check before any content fetch', async () => {
    let at = new Date(now); const f = setup({ at: () => at, check: async count => { if (count === 3) at = new Date('2026-10-23T12:00:00.000Z'); } });
    try { const r = request(); expect((await f.app.request(r.path, r.init)).status).toBe(503); expect(f.actual).not.toHaveBeenCalled(); } finally { await f.relay.close(); }
    expect(f.platform.finalize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exact', actualCostMicrousd: 0 }), expect.any(AbortSignal));
  });
  it('rejects an old review against a newly configured actual credential before any control/content request', async () => {
    const data = fixture(), wire = vi.fn(); const relay = createFundedRelay({ ...config(), workersAiToken: 'rotated'.repeat(8), managedRouteControl: data.settings, fetch: wire, now: () => now });
    const app = new Hono(); relay.register(app);
    try { const r = request(); expect((await app.request(r.path, r.init)).status).toBe(503); expect(wire).not.toHaveBeenCalled(); } finally { await relay.close(); }
  });
  it('rechecks cancellation after the start await before content send', async () => {
    const controller = new AbortController(); const f = setup({ start: async () => { controller.abort(); } });
    try { const r = request(); expect((await f.app.request(r.path, { ...r.init, signal: controller.signal })).status).toBe(503); expect(f.actual).not.toHaveBeenCalled(); } finally { await f.relay.close(); }
    expect(f.platform.finalize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exact', actualCostMicrousd: 0 }), expect.any(AbortSignal));
  });
  it.each([{ store: true }, { previous_response_id: 'remote' }, { background: true }, { metadata: { sensitive: 'private' } }])('rejects stateful or metadata config before content send %#', async extra => {
    const f = setup(); try { const r = request('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'private' }], max_tokens: 10, ...extra });
      expect((await f.app.request(r.path, r.init)).status).toBe(400); expect(f.wire).not.toHaveBeenCalled(); } finally { await f.relay.close(); }
  });
  it('denies provider result after response wait without returning Google content', async () => {
    let deny = false; const cancelled = vi.fn(); const f = setup({ generation: async () => { deny = true; return new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('private result')); }, cancel: cancelled })); }, check: async () => deny ? Response.json({ error: 'denied' }, { status: 503 }) : undefined });
    try { const r = request(); const response = await f.app.request(r.path, r.init); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private result'); expect(cancelled).toHaveBeenCalled(); } finally { await f.relay.close(); }
    expect(f.platform.finalize).toHaveBeenCalledWith(expect.objectContaining({ mode: 'conservative' }), expect.any(AbortSignal));
  });
  it('does not release a chunk if revoked while its release check awaits', async () => {
    const f = setup({ check: async count => count >= 5 ? Response.json({ error: 'denied' }, { status: 503 }) : undefined });
    try { const r = request(); const response = await f.app.request(r.path, r.init); expect(response.status).toBe(200); await expect(response.text()).rejects.toThrow('AI response stream failed'); } finally { await f.relay.close(); }
  });
});
