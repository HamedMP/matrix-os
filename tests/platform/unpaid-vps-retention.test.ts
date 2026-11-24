import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertUserMachine, upsertBillingCustomer, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';
import { createUnpaidVpsRetentionSweep } from '../../packages/platform/src/unpaid-vps-retention.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const ownerId = 'user_unpaid';
const machineId = '5b8d4091-4b05-4aae-94ba-928900fa32a0';
const cutoff = new Date('2026-11-01T00:00:00Z');
const loss = '2026-11-18T00:00:00.000Z';
const due = '2026-11-21T00:00:00.000Z';
const billing = {
  stripeSubscriptionId: 'sub_unpaid', stripeCustomerId: 'cus_unpaid', clerkUserId: ownerId,
  runtimeSlot: 'primary', planSlug: 'matrix_starter' as const, stripePriceId: 'price_starter',
  status: 'past_due' as const, currentPeriodEnd: loss, gracePeriodEndsAt: due,
  latestEventCreatedAt: loss, latestEventId: 'evt_failed', updatedAt: loss,
};
const provider = {
  id: 12345, status: 'running', deleteProtected: false,
  labels: { app: 'matrix-os', machine_id: machineId, clerk_user_id: ownerId, runtime_slot: 'primary' },
};
const stripe = { id: 'sub_unpaid', customerId: 'cus_unpaid', runtimeSlot: 'primary', status: 'past_due',
  createdAt: '2026-11-04T00:00:00.000Z', currentPeriodStart: loss, endedAt: null,
  latestInvoiceOutstanding: true, paidThrough: null };

describe('unpaid VPS retention', () => {
  let db: PlatformDB;
  const listSubscriptions = vi.fn();
  const getServer = vi.fn();
  const hasRecoveryCopy = vi.fn();

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId, clerkUserId: ownerId, handle: 'unpaid', runtimeSlot: 'primary',
      provisioningClass: 'customer', hetznerServerId: 12345, status: 'running',
      provisionedAt: '2026-11-04T00:00:00.000Z' });
    await upsertBillingCustomer(db, { clerkUserId: ownerId, stripeCustomerId: 'cus_unpaid', createdAt: loss, updatedAt: loss });
    await upsertBillingSubscription(db, billing);
    listSubscriptions.mockReset().mockResolvedValue([stripe]);
    getServer.mockReset().mockResolvedValue(provider);
    hasRecoveryCopy.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => destroyTestPlatformDb(db));

  const sweep = (time = due) => createUnpaidVpsRetentionSweep({ db, policyStartsAt: cutoff, listSubscriptions,
    getServer, hasRecoveryCopy, env: {}, now: () => new Date(time) });
  const machine = () => db.executor.selectFrom('user_machines').select(['status', 'deleted_at'])
    .where('machine_id', '=', machineId).executeTakeFirstOrThrow();
  const queue = () => db.executor.selectFrom('provider_deletion_queue').selectAll().execute();

  it('queues exact provider deletion at the end of grace and preserves billing records', async () => {
    await expect(sweep('2026-11-20T23:59:59.999Z')()).resolves.toMatchObject({ queued: 0 });
    await expect(sweep()()).resolves.toMatchObject({ queued: 1 });
    expect(await machine()).toEqual({ status: 'deleted', deleted_at: due });
    expect(await queue()).toMatchObject([{ provider_server_id: 12345, machine_id: machineId,
      reason: 'unpaid_retention', completed_at: null }]);
    expect(await db.executor.selectFrom('billing_subscriptions').select('stripe_subscription_id').execute())
      .toEqual([{ stripe_subscription_id: 'sub_unpaid' }]);
    await expect(sweep()()).resolves.toMatchObject({ queued: 0 });
    expect(await queue()).toHaveLength(1);
  });

  it('covers an unconverted trial cancellation even without a stored paid grace boundary', async () => {
    await db.executor.updateTable('billing_subscriptions').set({ status: 'canceled', grace_period_ends_at: null,
      trial_started_at: '2026-11-04T00:00:00.000Z', trial_ends_at: loss }).execute();
    listSubscriptions.mockResolvedValue([{ ...stripe, status: 'canceled', endedAt: loss }]);
    await expect(sweep()()).resolves.toMatchObject({ queued: 1 });
  });

  it.each([
    ['live paid recovery', () => listSubscriptions.mockResolvedValue([{ ...stripe, status: 'active' }])],
    ['live replacement subscription', () => listSubscriptions.mockResolvedValue([stripe, { ...stripe, id: 'sub_replacement', status: 'trialing' }])],
    ['loss during the old retention policy', () => listSubscriptions.mockResolvedValue([{ ...stripe, currentPeriodStart: '2026-10-01T00:00:00Z' }])],
    ['newer live renewal boundary', () => listSubscriptions.mockResolvedValue([{ ...stripe, currentPeriodStart: due }])],
    ['renewal invoice already paid', () => listSubscriptions.mockResolvedValue([{ ...stripe, latestInvoiceOutstanding: false }])],
    ['incomplete Stripe inventory', () => listSubscriptions.mockResolvedValue(null)],
    ['provider server mismatch', () => getServer.mockResolvedValue({ ...provider, labels: { ...provider.labels, machine_id: 'other' } })],
    ['deletion protection', () => getServer.mockResolvedValue({ ...provider, deleteProtected: true })],
    ['missing recovery copy', () => hasRecoveryCopy.mockResolvedValue(false)],
  ])('retains the VPS with %s', async (_name, change) => {
    change();
    await expect(sweep()()).resolves.toMatchObject({ queued: 0 });
    expect(await machine()).toEqual({ status: 'running', deleted_at: null });
    expect(await queue()).toEqual([]);
  });

  it('retains a canceled VPS with an unexpired term covered by its latest invoice', async () => {
    await db.executor.updateTable('billing_subscriptions').set({ status: 'canceled' }).execute();
    listSubscriptions.mockResolvedValue([{ ...stripe, status: 'canceled', endedAt: loss, paidThrough: '2026-12-01T00:00:00Z' }]);
    await expect(sweep()()).resolves.toMatchObject({ queued: 0 });
    expect(await queue()).toEqual([]);
  });

  it('applies to a paid account that loses billing after the published policy starts', async () => {
    listSubscriptions.mockResolvedValue([{ ...stripe, createdAt: '2026-10-01T00:00:00Z' }]);
    await expect(sweep()()).resolves.toMatchObject({ queued: 1 });
  });

  it('retains the original disclosure for trials started before the policy', async () => {
    await db.executor.updateTable('billing_subscriptions').set({ trial_ends_at: loss }).execute();
    listSubscriptions.mockResolvedValue([{ ...stripe, createdAt: '2026-10-01T00:00:00Z' }]);
    await expect(sweep()()).resolves.toMatchObject({ queued: 0 });
    expect(await queue()).toEqual([]);
  });

  it.each(['off', 'running'])('only uses the suspension recovery window while the provider stays off (%s)', async (finalStatus) => {
    const suspendedAt = '2026-11-19T00:00:00.000Z';
    await db.executor.updateTable('user_machines').set({ status: 'suspended' })
      .where('machine_id', '=', machineId).execute();
    await db.executor.insertInto('billing_runtime_actions').values({
      id: '49c2ba6c-57fb-4a89-9eb2-a0bc3ea0e1d9',
      machine_id: machineId, stripe_subscription_id: billing.stripeSubscriptionId, action: 'suspend',
      reason: 'trial_ended_unpaid', status: 'completed', execute_after: suspendedAt, attempts: 1,
      created_at: loss, updated_at: suspendedAt, completed_at: suspendedAt,
    }).execute();
    getServer.mockResolvedValueOnce({ ...provider, status: 'off' })
      .mockResolvedValue({ ...provider, status: finalStatus });

    await expect(sweep()()).resolves.toMatchObject({ queued: finalStatus === 'off' ? 1 : 0 });
    expect(hasRecoveryCopy).toHaveBeenCalledWith(ownerId, 'primary', {
      earliest: new Date(loss),
      databaseEarliest: new Date('2026-11-18T22:00:00.000Z'),
      latest: new Date(due),
    });
  });

  it('rechecks a change to the live machine binding before writing either record', async () => {
    hasRecoveryCopy.mockImplementationOnce(async () => {
      await db.executor.updateTable('user_machines').set({ hetzner_server_id: 43210 }).execute();
      return true;
    });
    await expect(sweep()()).resolves.toMatchObject({ queued: 0 });
    expect(await queue()).toEqual([]);
    expect(await machine()).toEqual({ status: 'running', deleted_at: null });
  });
});
