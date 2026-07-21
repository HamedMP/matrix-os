import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getActiveUserMachineByClerkId,
  getUserMachine,
  listUserMachines,
  listPendingProviderDeletions,
  retireUserMachine,
  updateUserMachine,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

// Phase A (spec 092): provisioning reliability — stuck rows fail automatically,
// failed rows never block retries, retries are bounded, retired rows cannot register.
describe('platform/customer-vps reliability', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function activeEntitlement(overrides: Partial<BillingEntitlement> = {}): BillingEntitlement {
    return {
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
      gracePeriodEndsAt: '2099-01-01T00:00:00.000Z',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveUntil: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  interface Harness {
    service: ReturnType<typeof createCustomerVpsService>;
    hetzner: ReturnType<typeof createMockHetznerClient>;
    setClock: (iso: string) => void;
  }

  function createHarness(opts: {
    env?: Record<string, string>;
    hetzner?: Parameters<typeof createMockHetznerClient>[0];
    entitled?: boolean;
  } = {}): Harness {
    let clock = new Date('2026-04-26T12:00:00.000Z');
    const setClock = (iso: string) => {
      clock = new Date(iso);
    };
    let machineSeq = 0;
    const hetzner = createMockHetznerClient(opts.hetzner);
    const systemStore = createMockCustomerVpsSystemStore();
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_PORT: '9000',
        PLATFORM_SECRET: 'platform-secret',
        HETZNER_API_TOKEN: 'token',
        S3_ACCESS_KEY_ID: 'r2-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-secret-key',
        S3_ENDPOINT: 'https://r2.example',
        R2_BUCKET: 'matrixos-sync',
        POSTHOG_TOKEN: 'phc_public',
        POSTHOG_PROJECT_TOKEN: 'phc_project',
        POSTHOG_HOST: 'https://eu.i.posthog.com',
        NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.posthog.com',
        NEXT_PUBLIC_POSTHOG_API_HOST: '/relay',
        ...opts.env,
      }),
      hetzner,
      systemStore,
      // Deterministic registration token whose expiry honors the configured TTL,
      // so reconcile can detect a booted-but-never-registered machine.
      tokenFactory: (nowDate: Date, ttlMs: number) => ({
        token: 'reg-token',
        hash: hashRegistrationToken('reg-token'),
        expiresAt: new Date(nowDate.getTime() + ttlMs).toISOString(),
      }),
      machineIdFactory: () => `machine-${++machineSeq}`,
      postgresPasswordFactory: () => 'postgres-secret',
      now: () => clock,
      ...(opts.entitled === false
        ? {}
        : { resolveBillingEntitlement: async () => activeEntitlement() }),
    });
    return { service, hetzner, setClock };
  }

  it('fails a booted-but-never-registered machine once its registration token expires (gap 1)', async () => {
    // Hetzner reports the VM as running, but the host never called register().
    const { service, hetzner, setClock } = createHarness();
    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    // Advance past the two-hour registration token TTL and the 10-minute stale window.
    setClock('2026-04-26T14:01:00.000Z');
    const result = await service.reconcileProvisioning();

    expect(result.failed).toBe(1);
    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe('registration_timeout');
    // The abandoned server must be reaped so it does not accrue cost.
    expect(hetzner.deleteServer).toHaveBeenCalledWith(123456);
  });

  it('does not fail a stale machine while its registration token is still valid', async () => {
    const { service, setClock } = createHarness();
    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    // 12 minutes: stale (>10m) but token still valid (<2h).
    setClock('2026-04-26T12:12:00.000Z');
    const result = await service.reconcileProvisioning();

    expect(result.failed).toBe(0);
    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.status).toBe('provisioning');
  });

  it('retries a failed machine by retiring it and provisioning a fresh one (gap 2)', async () => {
    const { service, hetzner } = createHarness();
    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await updateUserMachine(db, first.machineId, {
      status: 'failed',
      failureCode: 'provider_unavailable',
      failureAt: '2026-04-26T12:05:00.000Z',
    });

    const retry = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(retry.machineId).not.toBe(first.machineId);
    expect(retry.status).toBe('provisioning');

    const active = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(active?.machineId).toBe(retry.machineId);
    expect(active?.attempt).toBe(2);

    // Exactly one live row for the user/slot after the retry.
    const live = (await listUserMachines(db)).filter(
      (m) => m.clerkUserId === 'user_123' && m.deletedAt === null,
    );
    expect(live).toHaveLength(1);

    // The retired machine is soft-deleted and its server queued for reaping.
    const retired = await getUserMachine(db, first.machineId);
    expect(retired?.deletedAt).not.toBeNull();
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);

    const pending = await listPendingProviderDeletions(db, '2099-01-01T00:00:00.000Z', 50);
    expect(pending.some((d) => d.reason === 'failed_retry_retire' && d.providerServerId === 123456)).toBe(true);
  });

  it('converges concurrent retries on a failed row to a single live machine', async () => {
    const { service } = createHarness();
    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await updateUserMachine(db, first.machineId, {
      status: 'failed',
      failureCode: 'provider_unavailable',
      failureAt: '2026-04-26T12:05:00.000Z',
    });

    const results = await Promise.allSettled([
      service.provision({ clerkUserId: 'user_123', handle: 'alice' }),
      service.provision({ clerkUserId: 'user_123', handle: 'alice' }),
    ]);

    const failures = results.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : []);
    expect(results.some((r) => r.status === 'fulfilled'), failures.join('\n')).toBe(true);
    const live = (await listUserMachines(db)).filter(
      (m) => m.clerkUserId === 'user_123' && m.deletedAt === null,
    );
    expect(live).toHaveLength(1);
  });

  it('converges concurrent retries with no billing lock via the unique index alone', async () => {
    // entitled:false skips lockUserMachineProvisioning, so the unique partial
    // index on (clerk_user_id, runtime_slot) WHERE deleted_at IS NULL is the
    // sole safety net. A losing racer must surface an error, never a silent
    // second live machine.
    const { service } = createHarness({ entitled: false });
    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await updateUserMachine(db, first.machineId, { status: 'failed', failureAt: '2026-04-26T12:05:00.000Z' });

    const results = await Promise.allSettled([
      service.provision({ clerkUserId: 'user_123', handle: 'alice' }),
      service.provision({ clerkUserId: 'user_123', handle: 'alice' }),
    ]);

    const failures = results.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : []);
    expect(results.some((r) => r.status === 'fulfilled'), failures.join('\n')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(Error);
      }
    }
    const live = (await listUserMachines(db)).filter(
      (m) => m.clerkUserId === 'user_123' && m.deletedAt === null,
    );
    expect(live).toHaveLength(1);
  });

  it('never retires a live (non-failed) machine', async () => {
    const { service } = createHarness();
    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    // The machine is still 'provisioning'; retiring it must be a no-op.
    await retireUserMachine(db, first.machineId, '2026-04-26T12:30:00.000Z');

    const row = await getUserMachine(db, first.machineId);
    expect(row?.deletedAt).toBeNull();
    expect(row?.status).toBe('provisioning');
  });

  it('stops retrying after the attempt cap is reached', async () => {
    const { service } = createHarness({ env: { CUSTOMER_VPS_MAX_PROVISION_ATTEMPTS: '2' } });

    const a1 = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await updateUserMachine(db, a1.machineId, { status: 'failed', failureAt: '2026-04-26T12:05:00.000Z' });
    const a2 = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    expect(a2.machineId).not.toBe(a1.machineId);
    await updateUserMachine(db, a2.machineId, { status: 'failed', failureAt: '2026-04-26T12:06:00.000Z' });

    await expect(
      service.provision({ clerkUserId: 'user_123', handle: 'alice' }),
    ).rejects.toMatchObject({ code: 'retry_exhausted' });
  });

  it('rejects registration for a retired machine', async () => {
    const { service } = createHarness();
    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await updateUserMachine(db, first.machineId, { status: 'failed', failureAt: '2026-04-26T12:05:00.000Z' });
    // Retire it by provisioning a replacement.
    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    await expect(
      service.register('reg-token', {
        machineId: first.machineId,
        hetznerServerId: 123456,
        publicIPv4: '203.0.113.10',
        publicIPv6: '2001:db8::/64',
        imageVersion: 'stable',
      }),
    ).rejects.toBeInstanceOf(CustomerVpsError);

    const retired = await getUserMachine(db, first.machineId);
    expect(retired?.status).not.toBe('running');
  });

  it('rejects registration once the registration token has expired', async () => {
    const { service, setClock } = createHarness();
    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    setClock('2026-04-26T14:01:00.000Z'); // past two-hour TTL
    await expect(
      service.register('reg-token', {
        machineId: first.machineId,
        hetznerServerId: 123456,
        publicIPv4: '203.0.113.10',
        publicIPv6: '2001:db8::/64',
        imageVersion: 'stable',
      }),
    ).rejects.toBeInstanceOf(CustomerVpsError);

    const row = await getUserMachine(db, first.machineId);
    expect(row?.status).toBe('provisioning');
  });
});
