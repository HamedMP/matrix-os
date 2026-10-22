import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFundedRelayService, requireFundedRelayServiceConfig } from '../../packages/proxy/src/funded-main-app.js';
import { readManagedRouteControlConfig, snapshotFundedRelayConfig } from '../../packages/proxy/src/managed-route-control-config.js';
import { MANAGED_GOOGLE_ROUTE_CONTROL_PATH, ManagedGoogleRouteResolveResponseSchema } from '../../packages/contracts/src/managed-google-route-control.js';
import { MANAGED_GOOGLE_CONTROL_POLICY_VERSION } from '../../packages/contracts/src/managed-google-route.js';
import { FUNDED_PRICING_VERSIONS } from '../../packages/proxy/src/funded-pricing-review.js';

const account = 'a'.repeat(32), model = '@cf/zai-org/glm-5.3-flash';
const key = 'synthetic-stable-workers-key-not-a-live-secret';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const time = new Date('2026-10-22T12:00:00.000Z');
const upstream = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`;
const reviews = () => [{ routeId: 'reviewed_route_one', routeRevision: 1,
  evidence: { referenceDigest: 'b'.repeat(64), accountSettingsReferenceDigest: 'c'.repeat(64), reviewedAt: '2026-10-21T12:00:00.000Z', expiresAt: '2026-10-29T12:00:00.000Z' },
  relay: { endpoint: 'https://relay.example.invalid/v1/chat/completions', api: 'openai-completions' },
  upstream: { endpoint: upstream, api: 'cloudflare-workers-ai-run', nativeModelId: model, canonicalModelId: model },
  cloudflare: { accountId: account, gatewayId: 'gateway-one', credentialMode: 'workers-ai-api-token' },
  credential: { generation: '123e4567-e89b-42d3-a456-426614174000', fingerprint: hash(key) },
  recipientChain: [{ recipientId: 'cloudflare', accountId: account, endpoint: upstream }], controlPolicyVersion: MANAGED_GOOGLE_CONTROL_POLICY_VERSION }];
const env = () => ({ MATRIX_FUNDED_AI_ENABLED: 'true', MATRIX_FUNDED_AI_RESERVATION_MODE: 'usage',
  CLOUDFLARE_AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${account}/gateway-one/anthropic`,
  CLOUDFLARE_AI_GATEWAY_TOKEN: 'synthetic-gateway-auth-secret-never-a-provider-credential', CLOUDFLARE_WORKERS_AI_TOKEN: key,
  PLATFORM_INTERNAL_URL: 'https://platform.example.invalid', AI_RELAY_CONTROL_TOKEN: 'synthetic-platform-to-proxy-control-secret',
  AI_RELAY_METADATA_SECRET: 'synthetic-metadata-secret-never-a-provider-credential',
  MATRIX_FUNDED_GLM_PRICING_REVIEW_VERSION: FUNDED_PRICING_VERSIONS[model], MATRIX_FUNDED_GLM_PRICING_REVIEWED_AT: '2026-10-21T12:00:00.000Z',
  MATRIX_FUNDED_GLM_PRICING_VALID_THROUGH: '2026-10-29T12:00:00.000Z' });
const settings = () => ({ relayBaseUrl: 'https://relay.example.invalid', reviews: reviews() });
const services: ReturnType<typeof createFundedRelayService>[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(options: { configured?: boolean; reviews?: unknown[] } = {}) {
  let clock = new Date(time); const original = requireFundedRelayServiceConfig(env());
  const config = { ...original, pricingReviews: original.pricingReviews?.map(review => ({ ...review })) }; const control = settings();
  if (options.reviews) control.reviews = options.reviews as never;
  const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: { model, choices: [{ message: { content: 'ok' } }] } }));
  const service = createFundedRelayService(config, { now: () => clock, fetchFn,
    ...(options.configured === false ? {} : { managedRouteControl: control }) }); services.push(service);
  const request = (value: unknown = { api: 'openai-completions', canonicalModelId: model }, extra: { auth?: string; path?: string; method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const body = extra.body ?? JSON.stringify(value); const method = extra.method ?? 'POST';
    return service.app.request(extra.path ?? MANAGED_GOOGLE_ROUTE_CONTROL_PATH, { method,
      headers: { authorization: extra.auth ?? `Bearer ${config.relayControlToken}`, 'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)), ...extra.headers }, ...(method === 'GET' ? {} : { body }), signal: extra.signal });
  };
  return { config, control, service, request, fetchFn, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('private managed route control resolver', () => {
  it('returns only the strict current private descriptor/digest without inference or external calls', async () => {
    const f = fixture(); const response = await f.request(); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = ManagedGoogleRouteResolveResponseSchema.parse(await response.json());
    expect(response.headers.get('access-control-allow-origin')).toBeNull(); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536);
    expect(result.descriptor.credential.fingerprint).toBe(hash(key)); expect(result.descriptor.relay.endpoint).toBe(f.control.reviews[0]!.relay.endpoint);
    expect(JSON.stringify(result)).not.toContain(key); expect(JSON.stringify(result)).not.toContain(f.config.relayControlToken); expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('ignores forwarded/Host authority and refuses body attempts to select endpoints or credentials', async () => {
    const f = fixture(); const response = await f.request(undefined, { path: 'https://forged-host.example.invalid' + MANAGED_GOOGLE_ROUTE_CONTROL_PATH,
      headers: { host: 'forged-host.example.invalid', 'x-forwarded-host': 'forged-proxy.example.invalid', 'x-forwarded-proto': 'http' } });
    expect(response.status).toBe(200); expect((await response.json()).descriptor.relay.endpoint).toBe('https://relay.example.invalid/v1/chat/completions');
    expect((await f.request({ api: 'openai-completions', canonicalModelId: model, endpoint: 'https://forged.example.invalid', credential: { fingerprint: 'f'.repeat(64) } })).status).toBe(400);
  });
  it.each(['missing', 'machine', 'owner', 'provider', 'forged-flags'] as const)('authenticates %s before even reading an invalid or oversized body', async invalid => {
    const f = fixture(); const auth = invalid === 'missing' ? '' : invalid === 'machine' ? 'Bearer sk-matrix-funded-synthetic.temporary'
      : invalid === 'owner' ? 'Bearer clerk-user-token' : `Bearer ${key}`;
    const response = await f.request({}, { auth, body: 'x'.repeat(5000), headers: { 'x-platform-user-id': 'user_owner',
      'x-platform-verified': 'true', 'x-internal-authorized': 'true', 'cf-aig-authorization': `Bearer ${f.config.relayControlToken}` } });
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'Managed route unavailable' }); expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it.each([{ api: 'openai-completions', canonicalModelId: 'unreviewed-model' }, { api: 'openai-responses', canonicalModelId: model },
    { api: 'openai-completions', canonicalModelId: model, ownerId: 'self-approved' }, { api: 'openai-completions', canonicalModelId: model, review: reviews()[0] }])('rejects noncontract requests %j', async value => {
    const f = fixture(); expect((await f.request(value)).status).toBe(400); expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it.each(['missing', 'expired', 'implicit-anthropic'] as const)('returns unavailable for %s rather than seed an approval', async failure => {
    const f = fixture({ reviews: failure === 'missing' ? [] : undefined }); if (failure === 'expired') f.advance(8 * 86400000);
    expect((await f.request(failure === 'implicit-anthropic' ? { api: 'anthropic-messages', canonicalModelId: 'anthropic/claude-sonnet-5' } : undefined)).status).toBe(503);
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('uses the same private immutable nested config snapshot for descriptor and actual readiness dispatch', async () => {
    const f = fixture(); const first = await (await f.request()).json();
    f.config.gatewayBaseUrl = f.config.gatewayBaseUrl.replace(account, 'd'.repeat(32)); f.config.workersAiToken = 'synthetic-rotated-worker-key-not-a-live-secret';
    (f.config.allowedBetas as Set<string>).add('unreviewed-beta'); f.control.reviews[0]!.recipientChain[0]!.accountId = 'forged';
    (f.config.pricingReviews as any)[0].validThrough = '2020-01-01T00:00:00.000Z';
    expect(await (await f.request()).json()).toEqual(first);
    expect((await f.service.app.request(`/ready?model=${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${f.config.relayControlToken}` } })).status).toBe(200);
    expect(f.fetchFn.mock.calls[0]![0]).toBe(upstream); expect(new Headers(f.fetchFn.mock.calls[0]![1]!.headers).get('authorization')).toBe(`Bearer ${key}`);
    const snapshot = snapshotFundedRelayConfig(requireFundedRelayServiceConfig(env()));
    expect(Object.isFrozen(snapshot.pricingReviews![0])).toBe(true); expect((snapshot.allowedBetas as any).add).toBeUndefined();
  });
  it('fails a replacement service whose actual credential rotated without matching review', async () => {
    const config = requireFundedRelayServiceConfig(env()); config.workersAiToken = 'synthetic-rotated-worker-key-not-a-live-secret';
    const service = createFundedRelayService(config, { now: () => time, managedRouteControl: settings() }); services.push(service);
    const body = JSON.stringify({ api: 'openai-completions', canonicalModelId: model });
    expect((await service.app.request(MANAGED_GOOGLE_ROUTE_CONTROL_PATH, { method: 'POST', headers: { authorization: `Bearer ${config.relayControlToken}`,
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body })).status).toBe(503);
  });
  it.each(['declared', 'actual', 'length', 'chunked', 'no-length', 'json', 'type', 'method', 'route', 'query'] as const)('bounds/rejects %s protocol errors with generic responses', async invalid => {
    const f = fixture(); const body = invalid === 'actual' || invalid === 'declared' ? 'x'.repeat(4097) : invalid === 'json' ? 'not json' : undefined;
    const headers = invalid === 'actual' ? { 'content-length': '10' } : invalid === 'length' ? { 'content-length': '-1' }
      : invalid === 'chunked' ? { 'transfer-encoding': 'chunked' } : invalid === 'no-length' ? { 'content-length': '' }
      : invalid === 'type' ? { 'content-type': 'text/plain' } : {};
    const response = await f.request(undefined, { body, headers, ...(invalid === 'method' ? { method: 'GET' } : {}),
      ...(invalid === 'route' ? { path: MANAGED_GOOGLE_ROUTE_CONTROL_PATH + '/extra' } : invalid === 'query' ? { path: MANAGED_GOOGLE_ROUTE_CONTROL_PATH + '?owner=forged' } : {}) });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(await response.json()).toEqual({ error: 'Managed route unavailable' });
  });
  it('rate caps authenticated requests without leaking current descriptor on refusal', async () => {
    const f = fixture(); for (let n = 0; n < 60; n++) expect((await f.request()).status).toBe(200);
    const refused = await f.request(); expect(refused.status).toBe(429); expect(await refused.json()).toEqual({ error: 'Managed route unavailable' });
    f.advance(60000); expect((await f.request()).status).toBe(200);
  });
  it.each(['abort', 'deadline', 'shutdown'] as const)('cancels a stalled body on %s and frees its admission', async changed => {
    const f = fixture(); const controller = new AbortController(); const cancel = vi.fn();
    const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel });
    if (changed === 'deadline') vi.useFakeTimers();
    const pending = f.service.app.request(MANAGED_GOOGLE_ROUTE_CONTROL_PATH, { method: 'POST', headers: { authorization: `Bearer ${f.config.relayControlToken}`,
      'content-type': 'application/json', 'content-length': '100' }, body, signal: controller.signal, duplex: 'half' } as RequestInit);
    await Promise.resolve(); await Promise.resolve();
    if (changed === 'abort') controller.abort(); if (changed === 'deadline') await vi.advanceTimersByTimeAsync(5001);
    if (changed === 'shutdown') await f.service.close();
    expect((await pending).status).toBe(503); expect(cancel).toHaveBeenCalledOnce(); expect(f.fetchFn).not.toHaveBeenCalled();
    if (changed !== 'shutdown') expect((await f.request()).status).toBe(200);
  });
  it('bounds simultaneous readers at eight and drains all bodies/timers on shutdown', async () => {
    vi.useFakeTimers(); const f = fixture(); const cancelled = vi.fn();
    const pending = Array.from({ length: 8 }, () => f.service.app.request(MANAGED_GOOGLE_ROUTE_CONTROL_PATH, { method: 'POST', headers: {
      authorization: `Bearer ${f.config.relayControlToken}`, 'content-type': 'application/json', 'content-length': '100' },
      body: new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel: cancelled }), duplex: 'half' } as RequestInit));
    await Promise.resolve(); await Promise.resolve();
    expect((await f.request()).status).toBe(429); await f.service.close();
    expect((await Promise.all(pending)).every(response => response.status === 503)).toBe(true); expect(cancelled).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0); expect((await f.request()).status).toBe(503);
  });
  it('leaves the control route absent when not configured and public health/readiness coarse', async () => {
    const f = fixture({ configured: false }); expect((await f.request()).status).toBe(404);
    expect(await (await f.service.app.request('/health')).json()).toEqual({ status: 'ok' });
    expect(await (await f.service.app.request('/ready?model=' + encodeURIComponent(model))).json()).toEqual({ ready: false }); expect(f.fetchFn).not.toHaveBeenCalled();
  });
});

describe('explicit private route-review startup configuration', () => {
  it('is absent by default and loads only the two explicit operator values', () => {
    expect(readManagedRouteControlConfig({})).toBeUndefined();
    const config = requireFundedRelayServiceConfig({ ...env(), MATRIX_GOOGLE_MANAGED_ROUTE_RELAY_URL: settings().relayBaseUrl,
      MATRIX_GOOGLE_MANAGED_ROUTE_REVIEWS: JSON.stringify(reviews()) });
    expect(config.managedRouteControl).toEqual(settings()); expect(Object.isFrozen(config.managedRouteControl!.reviews[0]!.evidence)).toBe(true);
  });
  it('keeps the private immutable beta snapshot bounded to the existing 32-flag configuration cap', () => {
    const config = requireFundedRelayServiceConfig(env()); config.allowedBetas = new Set(Array.from({ length: 33 }, (_, n) => `beta-${n}`));
    expect(() => snapshotFundedRelayConfig(config)).toThrow('Managed route control configuration unavailable');
  });
  it.each([{ MATRIX_GOOGLE_MANAGED_ROUTE_REVIEWS: undefined }, { MATRIX_GOOGLE_MANAGED_ROUTE_RELAY_URL: undefined },
    { MATRIX_GOOGLE_MANAGED_ROUTE_RELAY_URL: 'https://user:secret@relay.example.invalid' }, { MATRIX_GOOGLE_MANAGED_ROUTE_REVIEWS: 'not json' },
    { MATRIX_GOOGLE_MANAGED_ROUTE_REVIEWS: JSON.stringify([...reviews(), ...reviews()]) },
    { MATRIX_GOOGLE_MANAGED_ROUTE_REVIEWS: 'x'.repeat(262145) }])('fails closed on partial/invalid operator configuration', overrides => {
    expect(() => readManagedRouteControlConfig({ MATRIX_GOOGLE_MANAGED_ROUTE_RELAY_URL: settings().relayBaseUrl,
      MATRIX_GOOGLE_MANAGED_ROUTE_REVIEWS: JSON.stringify(reviews()), ...overrides })).toThrow('Managed route control configuration unavailable');
  });
});
