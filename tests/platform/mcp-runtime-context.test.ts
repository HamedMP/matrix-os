import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertUserMachine, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';
import { createMcpRuntimeContext } from '../../packages/platform/src/mcp-runtime-context.js';
import { verifySyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const secret = 'mcp-internal-runtime-test-secret-32-chars';
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
let db: PlatformDB;
beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
afterEach(async () => { await destroyTestPlatformDb(db); });

async function machine(user = 'user_alice', slot = 'primary', status = 'running') {
  await insertUserMachine(db, {
    machineId: `${user}-${slot}`, clerkUserId: user, handle: `${user.slice(5)}-${slot}`,
    runtimeSlot: slot, status, hetznerServerId: 100, publicIPv4: '203.0.113.10',
    serverType: 'cpx22', provisionedAt: '2026-09-05T00:00:00.000Z',
  });
}

function context(userId = 'user_alice', expiry = expiresAt, env: NodeJS.ProcessEnv = {}) {
  return createMcpRuntimeContext({ db, principal: { userId, clientId: 'test', expiresAt: expiry },
    gatewayOrigin: 'https://app.matrix-os.com', jwtSecret: secret, env });
}

describe('hosted MCP runtime ownership', () => {
  it('resolves an explicit accessible slot outside the inventory page', async () => {
    await machine('user_alice', 'oldest');
    await db.executor.updateTable('user_machines').set({ provisioned_at: '2020-01-01T00:00:00.000Z' }).execute();
    for (let i = 0; i < 21; i++) await machine('user_alice', 'new-' + i);
    const inventory = await context().listComputers();
    expect(inventory.hasMore).toBe(true);
    expect(inventory.items.some(item => item.runtimeSlot === 'oldest')).toBe(false);
    expect((await context().resolveRuntime('oldest')).computer.runtimeSlot).toBe('oldest');
  });

  it('denies runtime credentials when Stripe billing has no entitlement', async () => {
    await machine();
    await expect(context('user_alice', expiresAt, { MATRIX_BILLING_PROVIDER: 'stripe' }).resolveRuntime('primary'))
      .rejects.toMatchObject({ code: 'billing_required' });
  });

  it('rechecks the paid-runtime decision on every call', async () => {
    await machine();
    const env = { MATRIX_PAID_BETA_ENTITLEMENT_STATUS: 'active' };
    const runtime = context('user_alice', expiresAt, env);
    await runtime.resolveRuntime('primary');
    env.MATRIX_PAID_BETA_ENTITLEMENT_STATUS = 'expired';
    await expect(runtime.resolveRuntime('primary')).rejects.toMatchObject({ code: 'billing_required' });
  });
  it('enforces the selected slot subscription and denies it after cancellation', async () => {
    await machine();
    await machine('user_alice', 'extra');
    const now = new Date().toISOString();
    const subscription = { stripeSubscriptionId: 'sub_test', stripeCustomerId: 'cus_test',
      clerkUserId: 'user_alice', runtimeSlot: 'primary', planSlug: 'matrix_starter',
      stripePriceId: 'price_starter', billingInterval: 'monthly' as const, status: 'active',
      currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(), gracePeriodEndsAt: null,
      latestEventCreatedAt: now, latestEventId: 'evt_test', updatedAt: now };
    await upsertBillingSubscription(db, subscription);
    const runtime = context('user_alice', expiresAt, { MATRIX_BILLING_PROVIDER: 'stripe',
      STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_starter' });
    await runtime.resolveRuntime('primary');
    await expect(runtime.resolveRuntime('extra')).rejects.toMatchObject({ code: 'billing_required' });
    await upsertBillingSubscription(db, { ...subscription, status: 'canceled',
      latestEventCreatedAt: new Date(Date.now() + 1000).toISOString(), latestEventId: 'evt_cancel',
      currentPeriodEnd: '2020-01-01T00:00:00.000Z' });
    await expect(runtime.resolveRuntime('primary')).rejects.toMatchObject({ code: 'billing_required' });
  });

  it('preserves the shared preview exemption only after access checks', async () => {
    await insertUserMachine(db, { machineId: 'preview', clerkUserId: 'user_bob', handle: 'pr-123',
      runtimeSlot: 'pr-123', provisioningClass: 'preview', accessClerkUserIds: ['user_alice'],
      status: 'running', hetznerServerId: 100, publicIPv4: '203.0.113.10', serverType: 'cpx22',
      provisionedAt: new Date().toISOString() });
    const runtime = context('user_alice', expiresAt, { MATRIX_BILLING_PROVIDER: 'stripe' });
    expect((await runtime.resolveRuntime('pr-123')).computer.handle).toBe('pr-123');
    await expect(context('user_eve').resolveRuntime('pr-123')).rejects.toMatchObject({ code: 'computer_not_found' });
  });
  it('lists only accessible computers without selecting one implicitly', async () => {
    await machine(); await machine('user_bob');
    const inventory = await context().listComputers();
    expect(inventory.items.map(c => c.handle)).toEqual(['alice-primary']);
    expect(inventory.selectedSlot).toBeNull();
  });

  it('mints a short-lived internal token bound to the explicit computer', async () => {
    await machine('user_alice', 'review');
    const runtime = await context().resolveRuntime('review');
    expect(runtime.gatewayUrl).toBe('https://app.matrix-os.com/vm/alice-review?runtime=review');
    const claims = await verifySyncJwt(runtime.token, { secret });
    expect(claims).toMatchObject({ sub: 'user_alice', handle: 'alice-review', runtime_slot: 'review', aud: 'matrix-os-sync' });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
    expect(claims.exp).toBeLessThanOrEqual(expiresAt);
  });

  it('attenuates internal credential lifetime to the incoming token expiry', async () => {
    await machine();
    const soon = Math.floor(Date.now() / 1000) + 15;
    const runtime = await context('user_alice', soon).resolveRuntime('primary');
    expect((await verifySyncJwt(runtime.token, { secret })).exp).toBeLessThanOrEqual(soon);
  });

  it('does not let a slot select another owner or accept URLs as slots', async () => {
    await machine('user_bob', 'private');
    await expect(context().resolveRuntime('private')).rejects.toMatchObject({ code: 'computer_not_found' });
    await expect(context().resolveRuntime('https://evil.example')).rejects.toBeDefined();
  });

  it('rejects stopped and deauthorized computers, including after context creation', async () => {
    await machine('user_alice', 'primary', 'stopped');
    await expect(context().resolveRuntime('primary')).rejects.toMatchObject({ code: 'computer_unavailable' });
    await machine('user_alice', 'review');
    const selected = context();
    await selected.resolveRuntime('review');
    await db.executor.updateTable('user_machines').set({ activation_state: 'pending' }).where('runtime_slot', '=', 'review').execute();
    await expect(selected.resolveRuntime('review')).rejects.toMatchObject({ code: 'computer_unavailable' });
  });

  it('rejects expired principals and unsafe configured origins', async () => {
    await expect(context('user_alice', 1).listComputers()).rejects.toMatchObject({ code: 'auth_required' });
    expect(() => createMcpRuntimeContext({ db, principal: { userId: 'user_alice', clientId: 'test', expiresAt },
      gatewayOrigin: 'http://evil.example', jwtSecret: secret })).toThrow();
  });
});
