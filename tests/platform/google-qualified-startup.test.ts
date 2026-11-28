import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { Hono } from 'hono';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createQualifiedFundedRuntimeRoutes } from '../../packages/platform/src/ai-funded-qualified-routes.js';
import { buildPlatformRuntimeVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createGoogleQualifiedPlatformRuntime } from '../../packages/platform/src/google-qualified-startup.js';
import { qualifiedIdentity as identity, qualifiedModel as model, qualifiedNow as now, qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';
const funded = { enabled: true as const, platformSecret: 'p'.repeat(32), relayControlToken: 'c'.repeat(32), credentialHashSecret: 'h'.repeat(32), credentialTtlMs: 900000, issueCooldownMs: 30000, policyFreshnessMs: 60000, promotionalGrant: { enabled: false as const } };
const selector = { api: 'openai-completions' as const, canonicalModelId: model };
let db: PlatformDB | undefined; let runtime: Awaited<ReturnType<typeof createGoogleQualifiedPlatformRuntime>>;
afterEach(async () => { await runtime?.close(); runtime = undefined; if (db) await destroyTestPlatformDb(db); db = undefined; });
describe('explicit qualified platform startup', () => {
  it('owns no resources when disabled and rejects partial operator configuration before opening a pool', async () => {
    expect(await createGoogleQualifiedPlatformRuntime({ env: {}, funded: { enabled: false }, connectionString: '' })).toBeUndefined();
    for (const env of [{ MATRIX_GOOGLE_QUALIFIED_FUNDED_ENABLED: '1' }, { MATRIX_GOOGLE_QUALIFIED_FUNDED_ENABLED: 'true' }]) {
      await expect(createGoogleQualifiedPlatformRuntime({ env, funded, connectionString: '' })).rejects.toThrow('Qualified AI unavailable');
    }
    await expect(createGoogleQualifiedPlatformRuntime({ env: { MATRIX_GOOGLE_QUALIFIED_FUNDED_ENABLED: 'true', MATRIX_FUNDED_AI_RELAY_URL: 'http://untrusted.invalid' }, funded, connectionString: 'postgresql://invalid' })).rejects.toThrow('Qualified AI unavailable');
  });
  it.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL)('installs the child atomically, uses only fixed control and issues through authenticated Hono composition', async () => {
    ({ db } = await createTestPlatformDb()); const name = (await sql<{ name: string }>`select current_database() as name`.execute(db.executor)).rows[0]!.name;
    const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!); url.pathname = `/${name}`;
    const route = qualifiedRouteFixture(); const wire = vi.fn<typeof fetch>(async (input, init) => { expect(String(input)).toBe('https://relay.example.test/internal/google-managed-route/resolve'); expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${funded.relayControlToken}`); return Response.json({ descriptor: route.descriptor, digest: route.digest }); });
    runtime = await createGoogleQualifiedPlatformRuntime({ env: { MATRIX_GOOGLE_QUALIFIED_FUNDED_ENABLED: 'true', MATRIX_FUNDED_AI_RELAY_URL: route.relayBaseUrl }, funded, connectionString: url.toString(), fetchFn: wire, now: () => now });
    expect(runtime).toBeDefined(); expect(await runtime!.resolveManagedRoute(selector, new AbortController().signal)).toEqual(route);
    expect((await sql`select * from ai_runtime_credential_routes`.execute(db.executor)).rows).toEqual([]);
    expect((await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute())).toEqual([]);
    await insertUserMachine(db, { ...identity, clerkUserId: identity.ownerId, handle: 'qualified-one', status: 'running', activationState: 'authorized', imageVersion: 'fixture', provisionedAt: now.toISOString() });
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: funded.credentialHashSecret, now: () => now });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [model], monthlyBudgetMicrousd: 1000, expiresAt: null });
    const app = new Hono().route('/internal/containers/:handle/ai/qualified', createQualifiedFundedRuntimeRoutes({ service: runtime!.service }));
    const body = JSON.stringify({ protocol: 'matrix-google-qualified-funded-v1', ...selector, expectedDigest: route.digest, requestClass: 'interactive' });
    const path = '/internal/containers/qualified-one/ai/qualified/funded-credential?runtimeSlot=primary'; const headers = { authorization: `Bearer ${buildPlatformRuntimeVerificationToken({ handle: 'qualified-one', machineId: identity.machineId, runtimeSlot: 'primary' }, funded.platformSecret)}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
    expect((await app.request(path, { method: 'POST', headers: { ...headers, authorization: 'Bearer forged' }, body })).status).toBe(401);
    const response = await app.request(path, { method: 'POST', headers, body }); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ binding: { digest: route.digest }, lease: { credential: { token: expect.stringMatching(/^sk-matrix-google-funded-/) } } });
    wire.mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('cancelled private transport')), { once: true }); }));
    const pending = Array.from({ length: 8 }, () => runtime!.resolveManagedRoute(selector, new AbortController().signal));
    const settled = Promise.allSettled(pending);
    await expect(runtime!.resolveManagedRoute(selector, new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
    const close = runtime!.close(); expect(runtime!.close()).toBe(close); await close;
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    await expect(runtime!.resolveManagedRoute(selector, new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
    expect((await sql`select 1`.execute(db.executor)).rows).toHaveLength(1); // Host pool stays alive.
  });
});
