import { forwardBotInference } from '../../packages/gateway/src/bots/broker-inference.js';
import { createFundedAdmissionQueue } from '../../packages/gateway/src/funded-ai/admission-queue.js';
import type { ManagedPiRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createAiFundedMeteringRepository } from '../../packages/platform/src/ai-funded-metering-repository.js';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { Hono } from 'hono';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createQualifiedFundedTransactionRunner } from '../../packages/platform/src/ai-funded-qualified-db.js';
import { createQualifiedFundedService } from '../../packages/platform/src/ai-funded-qualified-service.js';
import { installAiFundedRouteBindingSchema } from '../../packages/platform/src/ai-funded-route-binding.js';
import { createAiFundedRelayRoutes } from '../../packages/platform/src/ai-funded-policy-routes.js';
import { createFundedManagedRouteClient } from '../../packages/platform/src/ai-funded-managed-route-client.js';
import { buildPlatformRuntimeVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createFundedRelay, resolveFundedRelayConfig, type FundedRelay } from '../../packages/proxy/src/funded-relay.js';
import { createManagedRouteControl } from '../../packages/proxy/src/managed-route-control.js';
import { managedGoogleRouteDescriptorDigest } from '../../packages/proxy/src/funded-google-route-descriptor.js';
import { qualifiedIdentity as identity, qualifiedModel as model, qualifiedNow as now, qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';

describe.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL)('real qualified issuance/control/platform/relay composition', () => {
  let db: PlatformDB; let runner: ReturnType<typeof createQualifiedFundedTransactionRunner>; let service: ReturnType<typeof createQualifiedFundedService>;
  let relay: FundedRelay; let control: ReturnType<typeof createManagedRouteControl>;
  const platformSecret = 'p'.repeat(32), hashSecret = 'h'.repeat(32), controlSecret = 'c'.repeat(32);
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); await installAiFundedRouteBindingSchema(db.executor);
    await insertUserMachine(db, { ...identity, clerkUserId: identity.ownerId, handle: 'qualified-one', status: 'running', activationState: 'authorized', imageVersion: 'fixture', provisionedAt: now.toISOString() });
  });
  afterEach(async () => { await relay?.close(); await control?.close(); await service?.close(); await runner?.close(); await destroyTestPlatformDb(db); });
  it.each(['none', 'start', 'response', 'release', 'partial', 'oversized', 'malformed', 'priority'])('enforces real current authority at %s boundary with actual reservation accounting', async boundary => {
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: hashSecret, now: () => now });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [model], monthlyBudgetMicrousd: 1000, expiresAt: null });
    await repo.grantCredit({ identity, entryId: 'composed_grant', kind: 'promotional_grant', amountMicrousd: 1000, sourceReference: 'test-fixture' });
    const name = (await sql<{ name: string }>`select current_database() as name`.execute(db.executor)).rows[0]!.name;
    const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!); url.pathname = `/${name}`;
    runner = createQualifiedFundedTransactionRunner({ connectionString: url.toString() });
    const config = resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: 'true', MATRIX_FUNDED_AI_RESERVATION_MODE: 'usage',
      CLOUDFLARE_AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/gateway-one/anthropic`, CLOUDFLARE_AI_GATEWAY_TOKEN: 'g'.repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: 'w'.repeat(32),
      PLATFORM_INTERNAL_URL: 'https://platform.example.test', AI_RELAY_CONTROL_TOKEN: controlSecret, AI_RELAY_METADATA_SECRET: 'm'.repeat(32),
      MATRIX_FUNDED_GLM_PRICING_REVIEW_VERSION: 'cloudflare-2026-09-10-glm-flash', MATRIX_FUNDED_GLM_PRICING_REVIEWED_AT: '2026-10-21T00:00:00.000Z', MATRIX_FUNDED_GLM_PRICING_VALID_THROUGH: '2026-10-23T00:00:00.000Z' })!;
    const route = qualifiedRouteFixture();
    if (boundary === 'priority') { route.relayBaseUrl = 'https://relay.example.test'; route.descriptor.relay.endpoint = `${route.relayBaseUrl}/v1/chat/completions`; }
    route.descriptor.credential.fingerprint = createHash('sha256').update(config.workersAiToken!).digest('hex'); route.digest = managedGoogleRouteDescriptorDigest(route.descriptor);
    const { version: _version, kind: _kind, ...review } = route.descriptor;
    const settings = { relayBaseUrl: route.relayBaseUrl, reviews: [review] };
    control = createManagedRouteControl({ config, settings, now: () => now }); const controlApp = new Hono(); control.register(controlApp);
    const routeClient = createFundedManagedRouteClient({ relayBaseUrl: settings.relayBaseUrl, controlToken: controlSecret,
      fetchFn: async (input, init) => controlApp.request(String(input), init), now: () => now });
    service = createQualifiedFundedService({ runner, platformSecret, credentialHashSecret: hashSecret, resolveRoute: routeClient.resolve, now: () => now });
    const auth = { handle: 'qualified-one', runtimeSlot: 'primary', authorization: `Bearer ${buildPlatformRuntimeVerificationToken({ handle: 'qualified-one', machineId: identity.machineId, runtimeSlot: 'primary' }, platformSecret)}` };
    const issued = await service.issue(auth, { protocol: 'matrix-google-qualified-funded-v1', api: 'openai-completions', canonicalModelId: model, expectedDigest: route.digest, requestClass: 'interactive' }, new AbortController().signal);
    const platformApp = new Hono().route('/internal/ai/funded', createAiFundedRelayRoutes({ repository: repo, qualified: service, relayControlToken: controlSecret }));
    const revoke = async () => { await repo.revokeRuntimeCredential({ identity, tokenId: issued.lease.credential.tokenId }); };
    let checks = 0;
    const provider = vi.fn(async () => {
      if (boundary === 'response') await revoke();
      if (boundary === 'priority') return new Response([
        `data: ${JSON.stringify({ id: 'response_one', model, choices: [{ index: 0, delta: { content: 'synthetic result' }, finish_reason: 'stop' }] })}\n\n`,
        `data: ${JSON.stringify({ response: 'synthetic result', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 10 } } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'content-type': 'text/event-stream' } });
      if (boundary === 'partial') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'partial_one', model, choices: [{ index: 0, delta: { content: 'synthetic private result' }, finish_reason: 'stop' }] })}\n\n`)); } }), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ success: true, result: { id: 'response_one', model,
      choices: [{ index: 0, message: { role: 'assistant', content: boundary === 'oversized' ? 'x'.repeat(2048) : 'synthetic private result' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: boundary === 'malformed' ? 999 : 120, prompt_tokens_details: { cached_tokens: 10 } } } }); });
    const wire = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).startsWith(config.platformBaseUrl + '/internal/ai/funded/')) {
        if (String(input).endsWith('/dispatch-check') && ++checks === 5 && ['release', 'partial', 'malformed'].includes(boundary)) await revoke();
        const response = await platformApp.request(String(input), init);
        if (String(input).endsWith('/start') && boundary === 'start') await revoke(); return response;
      }
      expect(String(input)).toBe(route.descriptor.upstream.endpoint); expect(new Headers(init?.headers).get('cf-aig-collect-log')).toBe('true');
      expect(new Headers(init?.headers).get('cf-aig-skip-cache')).toBe('true'); return provider();
    });
    relay = createFundedRelay({ ...config, ...(boundary === 'oversized' ? { maxResponseBytes: 1024 } : {}), managedRouteControl: settings, fetch: wire, now: () => now, requestIdFactory: () => 'composed_request' }); const app = new Hono(); relay.register(app);
    if (boundary === 'priority') {
      const active = await service.authorize({ protocol: 'matrix-google-qualified-funded-v1', credential: issued.lease.credential.token, api: route.api,
        canonicalModelId: model, expectedDigest: route.digest, requestId: 'active_hold', maxCostMicrousd: 100, billingMode: 'usage' }, new AbortController().signal);
      const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', runtimeHandle: `runtime_${'e'.repeat(32)}`, executionGeneration: '1', ownerId: identity.ownerId,
        chatId: 'chat_priority', runId: 'run_priority', workspace: { kind: 'chat_workspace' }, rootFingerprint: 'f'.repeat(64), accessSourceId: 'matrix_included',
        route: { api: 'openai-completions', modelId: model, input: ['text'], contextWindow: 128000, maxOutputTokens: 100 }, capabilities: ['artifact.read'], requestClass: 'interactive' };
      const metering = createAiFundedMeteringRepository({ db, credentialHashSecret: hashSecret, now: () => now, policyFreshnessMs: 1000, reservationTtlMs: 30000, inFlightTtlMs: 60000 });
      const sleep = vi.fn(async () => {
        expect(provider).not.toHaveBeenCalled();
        expect(await db.executor.selectFrom('ai_funded_priority_claims').selectAll().execute()).toEqual([expect.objectContaining({ claim_key: binding.runtimeHandle })]);
        await metering.releaseReservation({ reservationId: active.authorization.reservation.reservationId, tokenId: issued.lease.credential.tokenId, reason: 'pre_upstream_failure' });
      });
      const queue = createFundedAdmissionQueue({ sleep }); const attempts: number[] = [];
      try {
        const result = await forwardBotInference({ version: 1, requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: binding.runtimeHandle, executionGeneration: '1',
          action: 'inference.chat_completions', method: 'POST', path: '/v1/chat/completions', headers: {}, body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 100 }) }, binding,
          () => ({ allowed: true, accessSourceId: 'matrix_included', allowedModelIds: [model], allowedEgressOrigins: [] }), { homePath: '/tmp', lifetime: new AbortController().signal,
            fundedAdmission: queue, resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: issued.lease.credential.token, ANTHROPIC_BASE_URL: route.relayBaseUrl } }),
            fetchImpl: async (url, init) => { const response = await app.request(String(url), init); attempts.push(response.status); if (attempts.length === 1) expect(response.headers.get('x-matrix-funded-reason')).toBe('slot_busy'); return response; } });
        expect(attempts).toEqual([429, 200]); expect(result).toMatchObject({ ok: true, status: 200 }); expect(sleep).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledTimes(1); expect(await db.executor.selectFrom('ai_funded_priority_claims').selectAll().execute()).toHaveLength(0);
        const reservation = await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().where('request_id', '=', 'composed_request').executeTakeFirstOrThrow();
        expect(reservation).toMatchObject({ status: 'settled', actual_microusd: 24 });
      } finally { queue.close(); }
      return;
    }
    const response = await app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${issued.lease.credential.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'synthetic Google text' }], max_tokens: 100 }) });
    expect(response.status).toBe(boundary === 'start' || boundary === 'response' ? 503 : 200);
    if (['release', 'partial', 'oversized', 'malformed'].includes(boundary)) await expect(response.text()).rejects.toThrow('AI response stream failed');
    else if (boundary === 'none') expect(await response.text()).toContain('synthetic private result');
    else expect(await response.text()).not.toContain('synthetic private result');
    await relay.close();
    const reservation = await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().executeTakeFirstOrThrow();
    const balance = await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().executeTakeFirstOrThrow();
    if (boundary === 'none' || boundary === 'start' || boundary === 'release') { expect(reservation.status).toBe('settled'); expect(reservation.actual_microusd).toBe(boundary === 'start' ? 0 : 24); expect(balance.reserved_microusd).toBe(0); }
    else { expect(reservation.status).toBe('in_flight'); expect(reservation.actual_microusd).toBeNull(); expect(balance.reserved_microusd).toBeGreaterThan(0); }
    expect(provider).toHaveBeenCalledTimes(boundary === 'start' ? 0 : 1);
  });
});
