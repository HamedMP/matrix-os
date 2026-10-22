import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createQualifiedFundedTransactionRunner } from '../../packages/platform/src/ai-funded-qualified-db.js';
import { createQualifiedFundedService } from '../../packages/platform/src/ai-funded-qualified-service.js';
import { createQualifiedFundedRelayRoutes } from '../../packages/platform/src/ai-funded-qualified-routes.js';
import { installAiFundedRouteBindingSchema, googleQualifiedRouteDigest } from '../../packages/platform/src/ai-funded-route-binding.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createAiFundedMeteringRepository } from '../../packages/platform/src/ai-funded-metering-repository.js';
import { buildPlatformRuntimeVerificationToken } from '../../packages/platform/src/platform-token.js';
import { qualifiedIdentity as identity, qualifiedModel as model, qualifiedNow as now, qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';

describe.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL)('qualified reservation and dispatch admission on PostgreSQL', () => {
  let db: PlatformDB; let runner: ReturnType<typeof createQualifiedFundedTransactionRunner>; let service: ReturnType<typeof createQualifiedFundedService>;
  let resolveRoute: ReturnType<typeof vi.fn>; const platformSecret = 'p'.repeat(32), hashSecret = 'h'.repeat(32); let at: Date;
  const signal = () => new AbortController().signal;
  const selector = () => ({ protocol: 'matrix-google-qualified-funded-v1' as const, api: 'openai-completions' as const, canonicalModelId: model, expectedDigest: qualifiedRouteFixture().digest });
  const auth = () => ({ handle: 'qualified-one', runtimeSlot: 'primary', authorization: `Bearer ${buildPlatformRuntimeVerificationToken({ handle: 'qualified-one', machineId: identity.machineId, runtimeSlot: 'primary' }, platformSecret)}` });
  beforeEach(async () => {
    at = new Date(now); ({ db } = await createTestPlatformDb()); await installAiFundedRouteBindingSchema(db.executor);
    await insertUserMachine(db, { ...identity, clerkUserId: identity.ownerId, handle: 'qualified-one', status: 'running', activationState: 'authorized', imageVersion: 'fixture', provisionedAt: now.toISOString() });
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: hashSecret, now: () => new Date(at) });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [model], monthlyBudgetMicrousd: 1000, expiresAt: null });
    await repo.grantCredit({ identity, entryId: 'qualified_grant', kind: 'promotional_grant', amountMicrousd: 1000, sourceReference: 'test-fixture' });
    const name = (await sql<{ name: string }>`select current_database() as name`.execute(db.executor)).rows[0]!.name;
    const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!); url.pathname = `/${name}`;
    runner = createQualifiedFundedTransactionRunner({ connectionString: url.toString(), maxConnections: 2 });
    resolveRoute = vi.fn(async () => qualifiedRouteFixture()); service = createQualifiedFundedService({ runner, platformSecret, credentialHashSecret: hashSecret, resolveRoute, now: () => new Date(at) });
  });
  afterEach(async () => { await service?.close(); await runner?.close(); await destroyTestPlatformDb(db); });
  async function issued() { return service.issue(auth(), { ...selector(), requestClass: 'interactive' }, signal()); }
  const authorization = (credential: string) => ({ ...selector(), credential, requestId: 'request_one', maxCostMicrousd: 100, billingMode: 'usage' as const });
  const rows = async () => (await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute());
  it('reserves exact route atomically, retries idempotently, and never accepts the token through legacy authorize', async () => {
    const lease = await issued(); const input = authorization(lease.lease.credential.token);
    const first = await service.authorize(input, signal()); expect(first.binding).toEqual(lease.binding);
    expect(first.authorization).toMatchObject({ identity: { tokenId: lease.lease.credential.tokenId }, reservation: { requestId: 'request_one', modelId: model, billingMode: 'usage' } });
    expect(await service.authorize(input, signal())).toEqual(first); expect(await rows()).toHaveLength(1);
    await expect(service.authorize({ ...input, maxCostMicrousd: 101 }, signal())).rejects.toThrow('Qualified AI unavailable');
    const legacy = createAiFundedMeteringRepository({ db, credentialHashSecret: hashSecret, now: () => at, policyFreshnessMs: 1000, reservationTtlMs: 30000, inFlightTtlMs: 60000 });
    await expect(legacy.authorize({ credential: input.credential, requestId: 'legacy_one', modelId: model, maxCostMicrousd: 100, billingMode: 'usage' })).rejects.toThrow();
  });
  it('dispatch check derives class, requires no control resolution and detects current revocation', async () => {
    const lease = await issued(); resolveRoute.mockClear(); resolveRoute.mockRejectedValue(new Error('must not resolve'));
    const input = { ...selector(), credential: lease.lease.credential.token };
    expect(await service.dispatchCheck(input, signal())).toMatchObject({ binding: { requestClass: 'interactive' } }); expect(resolveRoute).not.toHaveBeenCalled();
    await db.executor.updateTable('ai_runtime_credentials').set({ revoked_at: at.toISOString() }).execute();
    await expect(service.dispatchCheck(input, signal())).rejects.toThrow('Qualified AI unavailable');
  });
  it.each(['epoch', 'revoked', 'model', 'route', 'abort', 'expired'])('refuses changed %s during authorization control await before any reservation', async change => {
    const lease = await issued(); const controller = new AbortController();
    resolveRoute.mockImplementation(async () => {
      if (change === 'epoch') await db.executor.updateTable('user_machines').set({ runtime_token_epoch: 2 }).execute();
      if (change === 'revoked') await db.executor.updateTable('ai_runtime_credentials').set({ revoked_at: at.toISOString() }).execute();
      if (change === 'model') await db.executor.updateTable('ai_funded_global_policy').set({ enabled: false }).execute();
      if (change === 'expired') at = new Date(at.getTime() + 16 * 60000);
      if (change === 'abort') controller.abort();
      const route = qualifiedRouteFixture(); if (change === 'route') { route.descriptor.routeRevision++; route.digest = googleQualifiedRouteDigest(route.descriptor); } return route;
    });
    await expect(service.authorize(authorization(lease.lease.credential.token), controller.signal)).rejects.toThrow('Qualified AI unavailable'); expect(await rows()).toHaveLength(0);
    expect((await db.executor.selectFrom('ai_funded_runtime_balances').select('reserved_microusd').executeTakeFirstOrThrow()).reserved_microusd).toBe(0);
  });
  it('rolls back balance hold when reservation persistence fails', async () => {
    const lease = await issued(); await sql`alter table ai_funded_usage_reservations add constraint synthetic_failure check(false) not valid`.execute(db.executor);
    await expect(service.authorize(authorization(lease.lease.credential.token), signal())).rejects.toThrow('Qualified AI unavailable'); expect(await rows()).toHaveLength(0);
    expect((await db.executor.selectFrom('ai_funded_runtime_balances').select('reserved_microusd').executeTakeFirstOrThrow()).reserved_microusd).toBe(0);
  });
  it('exposes bounded service-control-only HTTP authorization and dispatch check, rejecting class overrides', async () => {
    const lease = await issued(), control = 'c'.repeat(32); const app = new Hono().route('/qualified', createQualifiedFundedRelayRoutes({ service, controlToken: control }));
    const post = (path: string, body: unknown, token = control) => { const text = JSON.stringify(body); return app.request(`/qualified/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }, body: text }); };
    const input = authorization(lease.lease.credential.token);
    expect((await post('authorize', input, 'wrong')).status).toBe(401); expect((await post('authorize', input)).status).toBe(200);
    expect((await post('dispatch-check', { ...selector(), credential: input.credential })).status).toBe(200);
    expect((await post('dispatch-check', { ...selector(), credential: input.credential, requestClass: 'background' })).status).toBe(400);
  });
});
