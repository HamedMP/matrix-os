import { beforeEach, afterEach, vi } from 'vitest';
import { type PlatformDB } from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import type { BillingEntitlement } from '../../packages/platform/src/billing.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
export const createTestConfig = (overrides: Partial<ReturnType<typeof loadCustomerVpsConfig>> = {}) => ({ ...loadCustomerVpsConfig({
    PLATFORM_PORT: '9000', PLATFORM_SECRET: 'platform-secret', HETZNER_API_TOKEN: 'token',
    S3_ACCESS_KEY_ID: 'r2-access-key', S3_SECRET_ACCESS_KEY: 'r2-secret-key',
    S3_ENDPOINT: 'https://r2.example', R2_BUCKET: 'matrixos-sync',
    POSTHOG_TOKEN: 'phc_public', POSTHOG_PROJECT_TOKEN: 'phc_project', NEXT_PUBLIC_POSTHOG_API_HOST: '/relay',
    POSTHOG_HOST: 'https://eu.i.posthog.com', NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.posthog.com',
  }), ...overrides });
export const activeEntitlement = (overrides: Partial<BillingEntitlement> = {}): BillingEntitlement => ({
  clerkUserId: 'user_123', source: 'stripe',
  planSlug: 'matrix_builder', status: 'active',
  maxRuntimeSlots: 1, includedRuntimeSlots: 1, addonRuntimeSlots: 0,
  defaultServerType: 'cpx32', allowedServerTypes: ['cpx22', 'cpx32'],
  stripeSubscriptionId: 'sub_123', stripePriceId: 'price_builder_monthly',
  gracePeriodEndsAt: '2026-05-30T00:00:00.000Z', effectiveFrom: '2026-05-01T00:00:00.000Z',
  effectiveUntil: null, updatedAt: '2026-05-30T00:00:00.000Z',
  ...overrides,
});
export function useCustomerVpsFixture(assign: (value: PlatformDB | undefined) => void = () => {}) {
  let db: PlatformDB | undefined;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); assign(db); });
  afterEach(async () => { vi.useRealTimers(); try { await destroyTestPlatformDb(db); } finally { db = undefined; assign(undefined); } });
  function createService(overrides: Parameters<typeof createCustomerVpsService>[0] = {} as any) {
    if (!db) throw new Error('Customer VPS test database is not initialized');
    const hetzner = createMockHetznerClient(overrides.hetzner);
    const systemStore = createMockCustomerVpsSystemStore(overrides.systemStore);
    const service = createCustomerVpsService({
      db, config: createTestConfig(), hetzner, systemStore,
      tokenFactory: () => ({
        token: 'registration-token', hash: hashRegistrationToken('registration-token'), expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      machineIdFactory: () => '9f05824c-8d0a-4d83-9cb4-b312d43ff112', postgresPasswordFactory: () => 'postgres-secret',
      now: () => new Date('2026-04-26T12:00:00.000Z'),
      ...overrides,
    });
    return { service, hetzner, systemStore };
  }
  return { createService };
}
