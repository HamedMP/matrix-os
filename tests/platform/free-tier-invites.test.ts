import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import {
  addFreeTierInvite,
  createFreeTierOperatorRoutes,
  getFreeTierInvite,
  readFreeTierCapacity,
  redeemFreeTierInvite,
  removeFreeTierInvite,
} from '../../packages/platform/src/free-tier/invites.js';
import { loadFreeTierConfig } from '../../packages/platform/src/free-tier/config.js';
import { createApp as createPlatformApp } from '../../packages/platform/src/main.js';
import { shutdownPlatformApp } from '../../packages/platform/src/shutdown-platform-app.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const SECRET = 'p'.repeat(40);
const OWNER = 'user_invited1';

describe('free tier configuration', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(loadFreeTierConfig({})).toEqual({ ok: false, reason: 'disabled' });
  });

  it('requires a positive runtime ceiling and defaults to invite-only', () => {
    expect(loadFreeTierConfig({ MATRIX_FREE_TIER_ENABLED: 'true' }))
      .toEqual({ ok: false, reason: 'incomplete', invalid: ['MATRIX_FREE_TIER_MAX_RUNTIMES'] });
    expect(loadFreeTierConfig({ MATRIX_FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '0' }).ok).toBe(false);
    expect(loadFreeTierConfig({ MATRIX_FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '250' }))
      .toEqual({ ok: true, config: { maxRuntimes: 250, inviteRequired: true } });
  });

  it('opens signup only on an explicit false', () => {
    const open = loadFreeTierConfig({
      MATRIX_FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '5', MATRIX_FREE_TIER_INVITE_REQUIRED: 'false',
    });
    expect(open).toEqual({ ok: true, config: { maxRuntimes: 5, inviteRequired: false } });
    expect(loadFreeTierConfig({
      MATRIX_FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '5', MATRIX_FREE_TIER_INVITE_REQUIRED: 'no',
    })).toEqual({ ok: false, reason: 'incomplete', invalid: ['MATRIX_FREE_TIER_INVITE_REQUIRED'] });
  });
});

describe('free tier invite repository', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('adds an invite once and keeps the first operator', async () => {
    expect(await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops-a' })).toBe('created');
    expect(await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops-b' })).toBe('exists');
    expect(await getFreeTierInvite(db, OWNER)).toMatchObject({ clerkUserId: OWNER, invitedBy: 'ops-a', consumedAt: null });
  });

  it('redeems an invite exactly once and reports later attempts without error', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    expect(await redeemFreeTierInvite(db, OWNER)).toBe('redeemed');
    expect(await redeemFreeTierInvite(db, OWNER)).toBe('already_redeemed');
    expect((await getFreeTierInvite(db, OWNER))?.consumedAt).toBeInstanceOf(Date);
    expect(await redeemFreeTierInvite(db, 'user_stranger')).toBe('not_invited');
  });

  it('removes only an unconsumed invite', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await addFreeTierInvite(db, { clerkUserId: 'user_invited2', invitedBy: 'ops' });
    await redeemFreeTierInvite(db, 'user_invited2');
    expect(await removeFreeTierInvite(db, OWNER)).toBe('removed');
    expect(await removeFreeTierInvite(db, OWNER)).toBe('not_found');
    expect(await removeFreeTierInvite(db, 'user_invited2')).toBe('consumed');
    expect(await getFreeTierInvite(db, 'user_invited2')).toBeDefined();
  });

  it('rejects malformed identifiers in the table itself', async () => {
    await expect(addFreeTierInvite(db, { clerkUserId: 'not a user', invitedBy: 'ops' })).rejects.toThrow();
  });

  it('only lets a container runtime exist in the free provisioning class', async () => {
    const base = { imageVersion: 'test', provisionedAt: new Date().toISOString(), activationState: 'authorized' as const };
    await expect(insertUserMachine(db, {
      ...base, machineId: 'mc', clerkUserId: 'user_c', handle: 'c', status: 'stopped', substrate: 'container', provisioningClass: 'customer',
    })).rejects.toThrow();
    await insertUserMachine(db, { ...base, machineId: 'mf', clerkUserId: 'user_f', handle: 'f', status: 'stopped', substrate: 'container' });
    const row = await db.executor.selectFrom('user_machines').select('provisioning_class').where('machine_id', '=', 'mf').executeTakeFirstOrThrow();
    expect(row.provisioning_class).toBe('free');
  });

  it('counts free runtimes and invites without owner data', async () => {
    const base = { imageVersion: 'test', provisionedAt: new Date().toISOString(), activationState: 'authorized' as const };
    await insertUserMachine(db, { ...base, machineId: 'm1', clerkUserId: 'user_a', handle: 'a', status: 'stopped', substrate: 'container', provisioningClass: 'free' });
    await insertUserMachine(db, { ...base, machineId: 'm2', clerkUserId: 'user_b', handle: 'b', status: 'running', substrate: 'container', provisioningClass: 'free' });
    await insertUserMachine(db, { ...base, machineId: 'm3', clerkUserId: 'user_c', handle: 'c', status: 'running' });
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    expect(await readFreeTierCapacity(db, { maxRuntimes: 10, inviteRequired: true })).toEqual({
      runtimes: 2, maxRuntimes: 10, running: 1, invitesPending: 1, inviteRequired: true,
    });
  });
});

describe('free tier operator routes', () => {
  let db: PlatformDB;
  const config = { maxRuntimes: 3, inviteRequired: true };
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  const app = () => createFreeTierOperatorRoutes({ db, operatorSecret: SECRET, config });
  const auth = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' };
  const post = (body: unknown, headers: Record<string, string> = auth) =>
    app().request('/invites', { method: 'POST', headers, body: JSON.stringify(body) });

  it('rejects requests without the operator credential', async () => {
    expect((await post({ clerkUserId: OWNER, invitedBy: 'ops' }, { 'content-type': 'application/json' })).status).toBe(401);
    expect((await post({ clerkUserId: OWNER, invitedBy: 'ops' }, { ...auth, authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await app().request('/capacity')).status).toBe(401);
    expect(await getFreeTierInvite(db, OWNER)).toBeUndefined();
  });

  it('is unavailable, not open, when the operator credential is unconfigured', async () => {
    const routes = createFreeTierOperatorRoutes({ db, operatorSecret: '', config });
    expect((await routes.request('/capacity', { headers: { authorization: 'Bearer ' } })).status).toBe(503);
  });

  it('adds an invite and is idempotent', async () => {
    const created = await post({ clerkUserId: OWNER, invitedBy: 'ops' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ invite: { clerkUserId: OWNER, consumed: false } });
    const repeated = await post({ clerkUserId: OWNER, invitedBy: 'ops' });
    expect(repeated.status).toBe(200);
  });

  it('validates the body at the boundary with a generic error', async () => {
    for (const body of [{ clerkUserId: 'bad id', invitedBy: 'ops' }, { clerkUserId: OWNER }, { clerkUserId: OWNER, invitedBy: 'ops', extra: 1 }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    }
    const malformed = await app().request('/invites', { method: 'POST', headers: auth, body: '{' });
    expect(malformed.status).toBe(400);
  });

  it('limits the body size of mutating routes', async () => {
    const large = await post({ clerkUserId: OWNER, invitedBy: 'x'.repeat(8_000) });
    expect(large.status).toBe(413);
    const del = await app().request(`/invites/${OWNER}`, { method: 'DELETE', headers: auth, body: 'x'.repeat(8_000) });
    expect(del.status).toBe(413);
  });

  it('deletes an unconsumed invite and refuses a consumed one', async () => {
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    await addFreeTierInvite(db, { clerkUserId: 'user_invited2', invitedBy: 'ops' });
    await redeemFreeTierInvite(db, 'user_invited2');
    const del = (id: string) => app().request(`/invites/${id}`, { method: 'DELETE', headers: auth });
    expect((await del(OWNER)).status).toBe(204);
    expect((await del(OWNER)).status).toBe(404);
    expect((await del('user_invited2')).status).toBe(409);
    expect((await del('bad%20id')).status).toBe(400);
  });

  it('reports capacity counts', async () => {
    const response = await app().request('/capacity', { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runtimes: 0, maxRuntimes: 3, running: 0, invitesPending: 0, inviteRequired: true });
  });

  it('is mounted on the platform app behind the platform operator credential', async () => {
    const platformApp = createPlatformApp({
      db, orchestrator: {} as never, platformSecret: SECRET, env: {}, freeTier: { config },
    });
    try {
      const created = await platformApp.request('/internal/free-tier/invites', {
        method: 'POST', headers: auth, body: JSON.stringify({ clerkUserId: OWNER, invitedBy: 'ops' }),
      });
      expect(created.status).toBe(201);
      const denied = await platformApp.request('/internal/free-tier/capacity', { headers: { authorization: 'Bearer nope' } });
      expect(denied.status).toBe(401);
    } finally { await shutdownPlatformApp(platformApp); }
  });

  it('returns a generic error when the database fails', async () => {
    await destroyTestPlatformDb(db);
    const response = await post({ clerkUserId: OWNER, invitedBy: 'ops' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    ({ db } = await createTestPlatformDb());
  });
});

describe.skipIf(!freeTierPostgresUrl)('free tier invite redemption against real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_invites', 2); });
  afterAll(async () => { await scoped?.close(); });

  it('lets exactly one of many concurrent redemptions across pools consume an invite', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    await addFreeTierInvite(a, { clerkUserId: OWNER, invitedBy: 'ops' });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      redeemFreeTierInvite(index % 2 === 0 ? a : b, OWNER)));
    expect(results.filter((result) => result === 'redeemed')).toHaveLength(1);
    expect(results.filter((result) => result === 'already_redeemed')).toHaveLength(19);
  });

  it('does not consume an invite when the surrounding transaction rolls back', async () => {
    const [a] = scoped.pools as [PlatformDB];
    await addFreeTierInvite(a, { clerkUserId: 'user_rollback', invitedBy: 'ops' });
    await expect(a.transaction(async (trx) => {
      expect(await redeemFreeTierInvite(trx, 'user_rollback')).toBe('redeemed');
      throw new Error('later step failed');
    })).rejects.toThrow('later step failed');
    expect((await getFreeTierInvite(a, 'user_rollback'))?.consumedAt).toBeNull();
  });
});
