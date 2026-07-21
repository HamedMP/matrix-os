import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getBillingCustomerByClerkUserId,
  getBillingEntitlement,
  getBillingEntitlementState,
  getBillingOverride,
  getBillingSubscription,
  listCurrentBillingSubscriptions,
  getBillingWebhookEvent,
  insertBillingCustomerIfAbsent,
  insertBillingWebhookEvent,
  revokeBillingOverride,
  upsertBillingCustomer,
  upsertBillingEntitlement,
  upsertBillingSubscription,
  upsertBillingOverride,
  type NewBillingEntitlementOverride,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('platform billing db', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('upserts Stripe customer links by Clerk user id', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_old',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_new',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
    });

    await expect(getBillingCustomerByClerkUserId(db, 'user_123')).resolves.toMatchObject({
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_new',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
    });
  });

  it('does not overwrite existing Stripe customer links when inserting if absent', async () => {
    await insertBillingCustomerIfAbsent(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_first',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    await insertBillingCustomerIfAbsent(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_second',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
    });

    await expect(getBillingCustomerByClerkUserId(db, 'user_123')).resolves.toMatchObject({
      stripeCustomerId: 'cus_first',
    });
  });

  it('upserts the latest effective billing entitlement', async () => {
    await upsertBillingEntitlement(db, {
      clerkUserId: 'user_123',
      source: 'stripe',
      planSlug: 'matrix_starter',
      status: 'active',
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx22',
      allowedServerTypes: ['cpx22'],
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_starter_monthly',
      gracePeriodEndsAt: '2026-07-03T00:00:00.000Z',
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveUntil: null,
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    await upsertBillingEntitlement(db, {
      clerkUserId: 'user_123',
      source: 'stripe',
      planSlug: 'matrix_max',
      status: 'active',
      maxRuntimeSlots: 4,
      includedRuntimeSlots: 3,
      addonRuntimeSlots: 1,
      defaultServerType: 'cpx52',
      allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_max_monthly',
      gracePeriodEndsAt: '2026-07-03T00:00:00.000Z',
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveUntil: null,
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    await expect(getBillingEntitlement(db, 'user_123')).resolves.toMatchObject({
      clerkUserId: 'user_123',
      planSlug: 'matrix_max',
      maxRuntimeSlots: 4,
      allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
    });

    await upsertBillingEntitlement(db, {
      clerkUserId: 'user_123',
      source: 'stripe',
      planSlug: 'matrix_starter',
      status: 'past_due',
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx22',
      allowedServerTypes: ['cpx22'],
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_starter_monthly',
      gracePeriodEndsAt: '2026-06-03T00:00:00.000Z',
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveUntil: null,
      updatedAt: '2026-06-01T12:00:00.000Z',
    });

    await expect(getBillingEntitlement(db, 'user_123')).resolves.toMatchObject({
      planSlug: 'matrix_max',
      maxRuntimeSlots: 4,
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
  });

  it('stores subscriptions independently per runtime slot and rejects stale events', async () => {
    await upsertBillingSubscription(db, {
      stripeSubscriptionId: 'sub_primary',
      stripeCustomerId: 'cus_123',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      planSlug: 'matrix_builder',
      stripePriceId: 'price_builder_monthly',
      billingInterval: 'monthly',
      status: 'active',
      currentPeriodEnd: '2026-06-30T00:00:00.000Z',
      gracePeriodEndsAt: '2026-07-03T00:00:00.000Z',
      latestEventCreatedAt: '2026-06-01T00:00:02.000Z',
      latestEventId: 'evt_primary_z',
      updatedAt: '2026-06-01T00:00:03.000Z',
    });
    await upsertBillingSubscription(db, {
      stripeSubscriptionId: 'sub_studio',
      stripeCustomerId: 'cus_123',
      clerkUserId: 'user_123',
      runtimeSlot: 'studio',
      planSlug: 'matrix_max',
      stripePriceId: 'price_max_annual',
      billingInterval: 'annual',
      status: 'active',
      currentPeriodEnd: '2027-06-01T00:00:00.000Z',
      gracePeriodEndsAt: '2027-06-04T00:00:00.000Z',
      latestEventCreatedAt: '2026-06-01T00:00:04.000Z',
      latestEventId: 'evt_studio',
      updatedAt: '2026-06-01T00:00:05.000Z',
    });
    await upsertBillingSubscription(db, {
      stripeSubscriptionId: 'sub_primary',
      stripeCustomerId: 'cus_123',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      planSlug: 'matrix_starter',
      stripePriceId: 'price_starter_monthly',
      billingInterval: 'monthly',
      status: 'canceled',
      currentPeriodEnd: '2026-05-31T00:00:00.000Z',
      gracePeriodEndsAt: null,
      latestEventCreatedAt: '2026-06-01T00:00:01.000Z',
      latestEventId: 'evt_primary_stale',
      updatedAt: '2026-06-01T00:00:06.000Z',
    });
    await upsertBillingSubscription(db, {
      stripeSubscriptionId: 'sub_primary',
      stripeCustomerId: 'cus_123',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      planSlug: 'matrix_starter',
      stripePriceId: 'price_starter_monthly',
      billingInterval: 'monthly',
      status: 'canceled',
      currentPeriodEnd: '2026-05-31T00:00:00.000Z',
      gracePeriodEndsAt: null,
      latestEventCreatedAt: '2026-06-01T00:00:02.000Z',
      latestEventId: 'evt_primary_a',
      updatedAt: '2026-06-01T00:00:07.000Z',
    });

    await expect(getBillingSubscription(db, 'user_123', 'primary', '2026-06-02T00:00:00.000Z')).resolves.toMatchObject({
      stripeSubscriptionId: 'sub_primary',
      planSlug: 'matrix_builder',
      status: 'active',
    });
    await expect(listCurrentBillingSubscriptions(db, 'user_123', '2026-06-02T00:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({ runtimeSlot: 'primary', stripeSubscriptionId: 'sub_primary' }),
      expect.objectContaining({ runtimeSlot: 'studio', stripeSubscriptionId: 'sub_studio' }),
    ]);
  });

  it('prefers an accessible replacement over a newer terminal subscription event for one slot', async () => {
    await upsertBillingSubscription(db, {
      stripeSubscriptionId: 'sub_replacement',
      stripeCustomerId: 'cus_123',
      clerkUserId: 'user_123',
      runtimeSlot: 'studio',
      planSlug: 'matrix_builder',
      stripePriceId: 'price_builder_monthly',
      billingInterval: 'monthly',
      status: 'active',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      gracePeriodEndsAt: '2026-07-04T00:00:00.000Z',
      latestEventCreatedAt: '2026-06-01T00:00:01.000Z',
      latestEventId: 'evt_replacement',
      updatedAt: '2026-06-01T00:00:01.000Z',
    });
    await upsertBillingSubscription(db, {
      stripeSubscriptionId: 'sub_obsolete',
      stripeCustomerId: 'cus_123',
      clerkUserId: 'user_123',
      runtimeSlot: 'studio',
      planSlug: 'matrix_starter',
      stripePriceId: 'price_starter_monthly',
      billingInterval: 'monthly',
      status: 'canceled',
      currentPeriodEnd: '2026-05-31T00:00:00.000Z',
      gracePeriodEndsAt: '2026-06-03T00:00:00.000Z',
      latestEventCreatedAt: '2026-06-02T00:00:00.000Z',
      latestEventId: 'evt_obsolete_canceled',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });

    await expect(getBillingSubscription(db, 'user_123', 'studio', '2026-06-04T00:00:00.000Z'))
      .resolves.toMatchObject({ stripeSubscriptionId: 'sub_replacement', status: 'active' });
    await expect(listCurrentBillingSubscriptions(db, 'user_123', '2026-06-04T00:00:00.000Z'))
      .resolves.toEqual([
        expect.objectContaining({ stripeSubscriptionId: 'sub_replacement', runtimeSlot: 'studio' }),
      ]);
  });

  it('ignores revoked internal overrides in the effective override lookup', async () => {
    const override: NewBillingEntitlementOverride = {
      id: 'override_123',
      clerkUserId: 'user_123',
      planSlug: 'internal',
      status: 'active',
      maxRuntimeSlots: 5,
      includedRuntimeSlots: 5,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx52',
      allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
      reason: 'engineer test',
      createdBy: 'ops-user',
      expiresAt: '2027-07-01T00:00:00.000Z',
      revokedAt: null,
      createdAt: '2026-05-30T00:00:00.000Z',
    };

    await upsertBillingOverride(db, override);
    await expect(getBillingOverride(db, 'user_123', '2026-06-01T00:00:00.000Z')).resolves.toMatchObject({
      id: 'override_123',
      reason: 'engineer test',
      revokedAt: null,
    });

    await expect(revokeBillingOverride(db, 'override_123', '2026-06-01T00:00:00.000Z')).resolves.toBe(true);
    await expect(revokeBillingOverride(db, 'override_123', '2026-06-02T00:00:00.000Z')).resolves.toBe(false);

    await expect(getBillingOverride(db, 'user_123', '2026-06-01T00:00:00.000Z')).resolves.toBeUndefined();
    await expect(
      db.executor
        .selectFrom('billing_entitlement_overrides')
        .select('revoked_at')
        .where('id', '=', 'override_123')
        .executeTakeFirst(),
    ).resolves.toEqual({ revoked_at: '2026-06-01T00:00:00.000Z' });

    await upsertBillingOverride(db, {
      ...override,
      reason: 'should not un-revoke',
      revokedAt: null,
    });

    await expect(getBillingOverride(db, 'user_123', '2026-06-01T00:00:00.000Z')).resolves.toBeUndefined();
    await expect(revokeBillingOverride(db, 'missing_override', '2026-06-01T00:00:00.000Z')).resolves.toBe(false);
  });

  it('loads entitlement and active override in one state lookup', async () => {
    await upsertBillingEntitlement(db, {
      clerkUserId: 'user_123',
      source: 'stripe',
      planSlug: 'matrix_builder',
      status: 'active',
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx32',
      allowedServerTypes: ['cpx22', 'cpx32'],
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_builder_monthly',
      gracePeriodEndsAt: null,
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveUntil: null,
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    await upsertBillingOverride(db, {
      id: 'override_123',
      clerkUserId: 'user_123',
      planSlug: 'internal',
      status: 'active',
      maxRuntimeSlots: 5,
      includedRuntimeSlots: 5,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx52',
      allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
      reason: 'engineer test',
      createdBy: 'ops-user',
      expiresAt: '2027-07-01T00:00:00.000Z',
      revokedAt: null,
      createdAt: '2026-05-30T00:00:00.000Z',
    });

    await expect(getBillingEntitlementState(
      db,
      'user_123',
      '2026-06-01T00:00:00.000Z',
    )).resolves.toMatchObject({
      entitlement: { planSlug: 'matrix_builder' },
      override: { id: 'override_123', planSlug: 'internal' },
    });
  });

  it('records Stripe webhook event ids idempotently', async () => {
    const first = await insertBillingWebhookEvent(db, {
      stripeEventId: 'evt_123',
      eventType: 'customer.subscription.updated',
      createdAtFromStripe: '2026-05-30T00:00:00.000Z',
      processedAt: '2026-05-30T00:00:01.000Z',
      status: 'processed',
      errorCode: null,
    });
    const duplicate = await insertBillingWebhookEvent(db, {
      stripeEventId: 'evt_123',
      eventType: 'customer.subscription.updated',
      createdAtFromStripe: '2026-05-30T00:00:00.000Z',
      processedAt: '2026-05-30T00:00:02.000Z',
      status: 'processed',
      errorCode: null,
    });

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    await expect(getBillingWebhookEvent(db, 'evt_123')).resolves.toMatchObject({
      stripeEventId: 'evt_123',
      processedAt: '2026-05-30T00:00:01.000Z',
    });
  });
});
