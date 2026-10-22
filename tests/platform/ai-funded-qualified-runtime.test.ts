import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { Hono } from 'hono';
import { createServer, type Socket } from 'node:net';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { qualifiedTokenHash } from '../../packages/platform/src/ai-funded-qualified-state.js';
import { createQualifiedFundedRuntimeRoutes, createQualifiedFundedRelayRoutes } from '../../packages/platform/src/ai-funded-qualified-routes.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { type PlatformDB, insertUserMachine } from '../../packages/platform/src/db.js';
import { createQualifiedFundedTransactionRunner } from '../../packages/platform/src/ai-funded-qualified-db.js';
import { createQualifiedFundedService } from '../../packages/platform/src/ai-funded-qualified-service.js';
import { installAiFundedRouteBindingSchema } from '../../packages/platform/src/ai-funded-route-binding.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { buildPlatformRuntimeVerificationToken } from '../../packages/platform/src/platform-token.js';
import { qualifiedIdentity as identity, qualifiedModel as model, qualifiedNow as now, qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';

describe.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL)('qualified runtime composition on PostgreSQL', () => {
  let db: PlatformDB; let runner: ReturnType<typeof createQualifiedFundedTransactionRunner>; let service: ReturnType<typeof createQualifiedFundedService>;
  const platformSecret = 'p'.repeat(32); const hashSecret = 'h'.repeat(32);
  const auth = () => ({ handle: 'qualified-one', runtimeSlot: 'primary', authorization: `Bearer ${buildPlatformRuntimeVerificationToken({ handle: 'qualified-one', machineId: identity.machineId, runtimeSlot: 'primary' }, platformSecret)}` });
  const request = () => ({ protocol: 'matrix-google-qualified-funded-v1' as const, api: 'openai-completions' as const,
    canonicalModelId: model, requestClass: 'interactive' as const, expectedDigest: qualifiedRouteFixture().digest });
  let resolveRoute: ReturnType<typeof vi.fn>;
  let env: NodeJS.ProcessEnv;
  let connectionString: string;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); await installAiFundedRouteBindingSchema(db.executor);
    await insertUserMachine(db, { ...identity, clerkUserId: identity.ownerId, handle: 'qualified-one', status: 'running', activationState: 'authorized', imageVersion: 'fixture', provisionedAt: now.toISOString() });
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: hashSecret, now: () => new Date(now) });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model, 'anthropic/claude-sonnet-5'] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [model, 'anthropic/claude-sonnet-5'], monthlyBudgetMicrousd: 1000, expiresAt: null });
    const name = (await sql<{ name: string }>`select current_database() as name`.execute(db.executor)).rows[0]!.name;
    const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!); url.pathname = `/${name}`;
    connectionString = url.toString(); runner = createQualifiedFundedTransactionRunner({ connectionString, maxConnections: 1 });
    resolveRoute = vi.fn(async () => qualifiedRouteFixture());
    env = {}; service = createQualifiedFundedService({ runner, platformSecret, credentialHashSecret: hashSecret, resolveRoute,
      now: () => new Date(now), credentialTtlMs: 15 * 60_000, env });
  });
  afterEach(async () => { await service?.close(); await runner?.close(); await destroyTestPlatformDb(db); });
  const counts = async () => (await sql<{ tokens: number; routes: number }>`select (select count(*)::int from ai_runtime_credentials) as tokens,
    (select count(*)::int from ai_runtime_credential_routes) as routes`.execute(db.executor)).rows[0];
  it('mints distinct qualified token plus exact child and checks complete token hash/current policy', async () => {
    const issued = await service.issue(auth(), request(), new AbortController().signal);
    expect(issued.lease.credential.token).toMatch(/^sk-matrix-google-funded-/); expect(await counts()).toEqual({ tokens: 1, routes: 1 });
    expect(await service.check({ ...request(), credential: issued.lease.credential.token }, new AbortController().signal)).toMatchObject({ binding: issued.binding, authorization: { identity: { tokenId: issued.lease.credential.tokenId } } });
    await expect(service.check({ ...request(), credential: issued.lease.credential.token.slice(0, -1) + (issued.lease.credential.token.endsWith('x') ? 'y' : 'x') }, new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
  });
  it('rolls back token AND cooldown when child insertion fails', async () => {
    await sql`alter table ai_runtime_credential_routes add constraint synthetic_failure check (false) not valid`.execute(db.executor);
    await expect(service.issue(auth(), request(), new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
    expect(await counts()).toEqual({ tokens: 0, routes: 0 });
    expect((await db.executor.selectFrom('ai_funded_runtime_policies').select('next_issue_at').executeTakeFirstOrThrow()).next_issue_at).toBe('1970-01-01T00:00:00.000Z');
  });
  it('clips token expiry before mint without changing original reviewed evidence', async () => {
    const route = qualifiedRouteFixture(); route.descriptor.evidence.expiresAt = route.evidenceExpiresAt = '2026-10-22T12:02:00.000Z';
    const { googleQualifiedRouteDigest } = await import('../../packages/platform/src/ai-funded-route-binding.js'); route.digest = googleQualifiedRouteDigest(route.descriptor);
    resolveRoute.mockResolvedValue(route); const issued = await service.issue(auth(), { ...request(), expectedDigest: route.digest }, new AbortController().signal);
    expect(issued.lease.credential.expiresAt).toBe(route.evidenceExpiresAt); expect(issued.binding.evidenceExpiresAt).toBe(route.evidenceExpiresAt);
  });
  it.each(['epoch', 'model', 'globalModel', 'owner', 'abort', 'digest'])('refuses changed %s during control wait without minting', async change => {
    resolveRoute.mockImplementation(async () => {
      if (change === 'epoch') await db.executor.updateTable('user_machines').set({ runtime_token_epoch: 2 }).execute();
      if (change === 'owner') await db.executor.updateTable('user_machines').set({ clerk_user_id: 'other' }).execute();
      if (change === 'model') await db.executor.updateTable('ai_funded_runtime_policies').set({ allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']) }).execute();
      if (change === 'globalModel') await db.executor.updateTable('ai_funded_global_policy').set({ allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']) }).execute();
      if (change === 'abort') abort.abort();
      const route = qualifiedRouteFixture(); if (change === 'digest') route.digest = 'f'.repeat(64); return route;
    });
    const abort = new AbortController(); await expect(service.issue(auth(), request(), abort.signal)).rejects.toThrow('Qualified AI unavailable');
    expect(await counts()).toEqual({ tokens: 0, routes: 0 });
  });
  it('has no private pool queue, aborts an active query, drains it and remains usable', async () => {
    const abort = new AbortController(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const active = runner.run(abort.signal, Date.now() + 5000, async tx => { entered(); return sql`select pg_sleep(10)`.execute(tx.executor); });
    await started;
    await expect(runner.run(new AbortController().signal, Date.now() + 5000, async () => 'unexpected')).rejects.toThrow('Qualified AI unavailable');
    abort.abort(); await expect(active).rejects.toThrow('Qualified AI unavailable');
    expect(await runner.run(new AbortController().signal, Date.now() + 5000, async tx => (await sql`select 1`.execute(tx.executor)).rows)).toHaveLength(1);
  });
  it('denies a new lease when the exact class cooldown is already leased', async () => {
    await service.issue(auth(), request(), new AbortController().signal);
    await expect(service.issue(auth(), request(), new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
    expect(await counts()).toEqual({ tokens: 1, routes: 1 });
  });
  it.each([false, true])('serializes actual independent issuers with distinct class=%s', async differentClass => {
    const otherRunner = createQualifiedFundedTransactionRunner({ connectionString, maxConnections: 1 });
    const otherService = createQualifiedFundedService({ runner: otherRunner, platformSecret, credentialHashSecret: hashSecret, resolveRoute,
      now: () => new Date(now), env });
    try {
      const results = await Promise.allSettled([service.issue(auth(), request(), new AbortController().signal),
        otherService.issue(auth(), { ...request(), requestClass: differentClass ? 'background' : 'interactive' }, new AbortController().signal)]);
      const expected = differentClass ? 2 : 1; expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(expected);
      expect(await counts()).toEqual({ tokens: expected, routes: expected });
    } finally { await otherService.close(); await otherRunner.close(); }
  });
  it('composes exact runtime/control auth with real Hono and strict bounded bodies', async () => {
    const app = new Hono(); const controlToken = 'c'.repeat(32);
    app.route('/internal/containers/:handle/ai/qualified', createQualifiedFundedRuntimeRoutes({ service }));
    app.route('/internal/ai/funded/qualified', createQualifiedFundedRelayRoutes({ service, controlToken }));
    const body = JSON.stringify(request()); const url = '/internal/containers/qualified-one/ai/qualified/funded-credential?runtimeSlot=primary';
    const headers = { authorization: auth().authorization, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
    expect((await app.request(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body })).status).toBe(401);
    expect((await app.request(url, { method: 'POST', headers: { ...headers, 'content-length': '5000' }, body: 'x'.repeat(5000) })).status).toBe(413);
    const issuedResponse = await app.request(url, { method: 'POST', headers, body }); expect(issuedResponse.status).toBe(200);
    const issued = await issuedResponse.json(); const checkBody = JSON.stringify({ ...request(), credential: issued.lease.credential.token });
    const checked = await app.request('/internal/ai/funded/qualified/check', { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(checkBody)) }, body: checkBody });
    expect(checked.status).toBe(200); expect(checked.headers.get('cache-control')).toContain('no-store'); expect(checked.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('runtime epoch rotation invalidates an already authenticated qualified token', async () => {
    const issued = await service.issue(auth(), request(), new AbortController().signal);
    await db.executor.updateTable('user_machines').set({ runtime_token_epoch: 2 }).execute();
    await expect(service.check({ ...request(), credential: issued.lease.credential.token }, new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
  });
  it('shutdown aborts and drains an authenticated stalled request body', async () => {
    const app = new Hono(); app.route('/internal/containers/:handle/ai/qualified', createQualifiedFundedRuntimeRoutes({ service }));
    let reading!: () => void; const started = new Promise<void>(resolve => { reading = resolve; }); const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel: cancelled }, { highWaterMark: 0 });
    const pending = app.request(new Request('http://fixture/internal/containers/qualified-one/ai/qualified/funded-credential?runtimeSlot=primary', {
      method: 'POST', headers: { authorization: auth().authorization, 'content-type': 'application/json', 'content-length': '10' }, body: stream, duplex: 'half',
    } as RequestInit & { duplex: 'half' }));
    await started; await service.close(); expect((await pending).status).toBe(503); expect(cancelled).toHaveBeenCalledOnce();
  });
  it.each(['revoke', 'policy', 'route'])('refuses %s changed during qualified check control wait', async change => {
    const issued = await service.issue(auth(), request(), new AbortController().signal);
    resolveRoute.mockImplementation(async () => {
      if (change === 'revoke') await db.executor.updateTable('ai_runtime_credentials').set({ revoked_at: now.toISOString() }).execute();
      if (change === 'policy') await db.executor.updateTable('ai_funded_global_policy').set({ enabled: false }).execute();
      const result = qualifiedRouteFixture(); if (change === 'route') result.digest = 'f'.repeat(64); return result;
    });
    await expect(service.check({ ...request(), credential: issued.lease.credential.token }, new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
  });
  it.each(['q2_1', 'q1_01', 'q1_0', 'q1_2147483648', 'q1_9007199254740993'])('rejects authenticated but noncanonical issuance identity %s', async prefix => {
    const issued = await service.issue(auth(), request(), new AbortController().signal); const old = issued.lease.credential.tokenId;
    const changed = prefix + '_' + old.slice(old.lastIndexOf('_') + 1); const credential = issued.lease.credential.token.replace(old, changed);
    await db.executor.updateTable('ai_runtime_credentials').set({ token_id: changed, token_hash: qualifiedTokenHash(credential, hashSecret) }).where('token_id', '=', old).execute();
    await expect(service.check({ ...request(), credential }, new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
  });
  it('denies deletion scheduled during control resolution using real owner admission', async () => {
    env.ACCOUNT_DELETION_SECRET = 'd'.repeat(32);
    const deletion = new AccountDeletionRepository(db.kysely, { secret: env.ACCOUNT_DELETION_SECRET, now: () => new Date(now) });
    resolveRoute.mockImplementation(async () => { await deletion.accept({ clerkUserId: identity.ownerId, appleTokens: [] }, false); return qualifiedRouteFixture(); });
    await expect(service.issue(auth(), request(), new AbortController().signal)).rejects.toThrow('Qualified AI unavailable');
    expect(await counts()).toEqual({ tokens: 0, routes: 0 });
  });
  it('cancels a real deadline-blocked query and rolls back earlier writes before reusing capacity', async () => {
    const started = performance.now();
    await expect(runner.run(new AbortController().signal, Date.now() + 150, async tx => {
      await tx.executor.updateTable('ai_funded_runtime_policies').set({ next_issue_at: '2099-01-01T00:00:00.000Z' }).execute();
      await sql`select pg_sleep(10)`.execute(tx.executor);
    })).rejects.toThrow('Qualified AI unavailable');
    expect(performance.now() - started).toBeLessThan(1000);
    expect((await db.executor.selectFrom('ai_funded_runtime_policies').select('next_issue_at').executeTakeFirstOrThrow()).next_issue_at).toBe('1970-01-01T00:00:00.000Z');
    await runner.close(); await runner.close(); await expect(runner.run(new AbortController().signal, Date.now() + 5000, async () => 1)).rejects.toThrow('Qualified AI unavailable');
  });
  it('handles real borrowed-client termination without an unhandled error and replaces its connection', async () => {
    let started!: (pid: number) => void; const backend = new Promise<number>(resolve => { started = resolve; });
    const active = runner.run(new AbortController().signal, Date.now() + 5000, async tx => {
      started((await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx.executor)).rows[0]!.pid);
      await sql`select pg_sleep(10)`.execute(tx.executor);
    });
    const rejection = expect(active).rejects.toThrow('Qualified AI unavailable');
    await sql`select pg_terminate_backend(${await backend})`.execute(db.executor); await rejection;
    expect(await runner.run(new AbortController().signal, Date.now() + 5000, async tx => (await sql`select 1`.execute(tx.executor)).rows)).toHaveLength(1);
  });
  it('bounds a real stalled PostgreSQL handshake and drains its private connection', async () => {
    const sockets = new Set<Socket>(); // <=1 test client; clear/destroy in finally.
    const server = createServer(socket => { if (sockets.size) socket.destroy(); else sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing');
    const isolated = createQualifiedFundedTransactionRunner({ connectionString: `postgresql://synthetic@127.0.0.1:${address.port}/fixture`, maxConnections: 1 });
    try { const start = performance.now(); await expect(isolated.run(new AbortController().signal, Date.now() + 5000, async () => 1)).rejects.toThrow('Qualified AI unavailable');
      expect(performance.now() - start).toBeLessThan(1600); }
    finally { await isolated.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
