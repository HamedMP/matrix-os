import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertUserMachine, upsertBillingEntitlement, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
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

const SECRET = 'p'.repeat(40);
const OWNER = 'user_invited1';

/**
 * Free-tier configuration, invites, and operator administration (spec 2691,
 * ENG-520; ported from PR #3414). Faults detected: the free tier turning on
 * without an explicit flag, an invite redeemed twice, a consumed invite
 * deleted, and operator routes reachable without the platform credential or
 * leaking database errors.
 */

describe('free tier configuration', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(loadFreeTierConfig({})).toEqual({ ok: false, reason: 'disabled' });
    for (const value of ['0', 'false', 'no', '']) {
      expect(loadFreeTierConfig({ FREE_TIER_ENABLED: value, MATRIX_FREE_TIER_MAX_RUNTIMES: '5' }))
        .toEqual({ ok: false, reason: 'disabled' });
    }
    expect(loadFreeTierConfig({ FREE_TIER_ENABLED: '1', MATRIX_FREE_TIER_MAX_RUNTIMES: '5' }).ok).toBe(true);
  });

  it('requires a positive runtime ceiling and defaults to invite-only', () => {
    expect(loadFreeTierConfig({ FREE_TIER_ENABLED: 'true' }))
      .toEqual({ ok: false, reason: 'incomplete', invalid: ['MATRIX_FREE_TIER_MAX_RUNTIMES'] });
    expect(loadFreeTierConfig({ FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '0' }).ok).toBe(false);
    expect(loadFreeTierConfig({ FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '250' }))
      .toEqual({ ok: true, config: { maxRuntimes: 250, inviteRequired: true } });
  });

  it('opens signup only on an explicit false', () => {
    const open = loadFreeTierConfig({
      FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '5', MATRIX_FREE_TIER_INVITE_REQUIRED: 'false',
    });
    expect(open).toEqual({ ok: true, config: { maxRuntimes: 5, inviteRequired: false } });
    expect(loadFreeTierConfig({
      FREE_TIER_ENABLED: 'true', MATRIX_FREE_TIER_MAX_RUNTIMES: '5', MATRIX_FREE_TIER_INVITE_REQUIRED: 'no',
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

  it('counts admitted free owners, their running metal runtimes, and pending invites without owner data', async () => {
    const now = new Date();
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    const base = { imageVersion: 'test', provisionedAt: now.toISOString(), activationState: 'authorized' as const };
    for (const owner of ['user_a', 'user_b', 'user_c']) await upsertBillingEntitlement(db, buildFreeEntitlement(owner, now));
    await insertUserMachine(db, { ...base, machineId: 'm1', clerkUserId: 'user_a', handle: 'a', status: 'provisioning', substrate: 'metal', metalHostId: 'host-a' });
    await insertUserMachine(db, { ...base, machineId: 'm2', clerkUserId: 'user_b', handle: 'b', status: 'running', substrate: 'metal', metalHostId: 'host-a' });
    // A paid metal runtime and a VPS are not free capacity.
    await insertUserMachine(db, { ...base, machineId: 'm3', clerkUserId: 'user_paid', handle: 'p', status: 'running', substrate: 'metal', metalHostId: 'host-a' });
    await insertUserMachine(db, { ...base, machineId: 'm4', clerkUserId: 'user_vps', handle: 'v', status: 'running' });
    await addFreeTierInvite(db, { clerkUserId: OWNER, invitedBy: 'ops' });
    expect(await readFreeTierCapacity(db, { maxRuntimes: 10, inviteRequired: true })).toEqual({
      runtimes: 3, maxRuntimes: 10, running: 1, invitesPending: 1, inviteRequired: true,
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
