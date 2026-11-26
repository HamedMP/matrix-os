import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb } from './platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';
import { createConfiguredAccountDeletionRuntime } from '../../packages/platform/src/account-deletion/wiring.js';
import { createApp } from '../../packages/platform/src/main.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { SITE_MANAGEMENT_CONTRACT_VERSION, SITE_MANAGEMENT_CONTRACT_VERSION_HEADER } from '@matrix-os/contracts';

// Fault detected: production main.ts never passes readiness, so the Private tab
// stays hidden even when every allowlist prerequisite is configured.
const platformSecret = 'p'.repeat(40);
const identity = { machineId: 'b8167260-fcde-4459-b8c2-9f99441778ba', handle: 'launch', runtimeSlot: 'primary' };
const url = '/internal/containers/launch/sites/not-published/email-invitation-capabilities?runtimeSlot=primary';
const env = {
  ACCOUNT_DELETION_CONFIGURED: 'true', ACCOUNT_DELETION_ENABLED: 'true', ACCOUNT_DELETION_SECRET: 'd'.repeat(40),
  CLERK_SECRET_KEY: 'sk_live_' + 'c'.repeat(32), NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_' + 'k'.repeat(32),
  CLERK_USER_WEBHOOK_SIGNING_SECRET: 'whsec_' + Buffer.alloc(24, 3).toString('base64'),
  R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', SITES_EDGE_SECRET: 'e'.repeat(40),
  MATRIX_PAGE_EMAIL_INVITATIONS_ENABLED: 'true', MATRIX_PAGE_EMAIL_EDGE_VERIFIED: 'true',
  MATRIX_PAGE_EMAIL_CLERK_SATELLITE_VERIFIED: 'true',
};

const store = vi.hoisted(() => ({ listObjects: vi.fn(async () => ({ keys: [], nextCursor: null })), deleteObject: vi.fn(),
  abortOwnerMultipartUploads: vi.fn(), destroy: vi.fn(), getPresignedGetUrl: vi.fn() }));
vi.mock('../../packages/platform/src/account-deletion/storage.js', async importOriginal => ({
  ...await importOriginal<object>(), createAccountDeletionObjectStore: () => store }));
afterEach(() => vi.restoreAllMocks());

describe('production Matrix.page allowlist readiness wiring', () => {
  async function capability(appEnv: Record<string, string>, withAccountDeletion: boolean) {
    const { db } = await createTestPlatformDb();
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: 'user_launch', handle: 'launch',
      runtimeTokenEpoch: 2, status: 'running', provisionedAt: new Date().toISOString() });
    const runtime = withAccountDeletion
      ? await createConfiguredAccountDeletionRuntime({ db, env: appEnv, backgroundWorkersEnabled: false }) : undefined;
    try {
      const app = createApp({ db, env: appEnv, platformSecret, orchestrator: stubOrchestrator(),
        accountDeletion: runtime ?? undefined,
        clerkAuth: { verify: async () => ({ authenticated: false }), extractToken: () => null } as never });
      const response = await app.request(url, { headers: {
        [SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]: SITE_MANAGEMENT_CONTRACT_VERSION,
        authorization: `Bearer ${buildPlatformSyncVerificationToken(identity, platformSecret, 2)}` } });
      expect(response.status).toBe(200);
      return await response.json();
    } finally {
      runtime?.stop(); await runtime?.drain(); runtime?.close(); await db.destroy();
    }
  }

  it('advertises allowlist invitations with no email delivery when the platform is configured', async () => {
    expect(await capability(env, true)).toEqual({ privateEmailInvitations: true, emailDelivery: 'none' });
  });

  it('keeps the capability off without the signed lifecycle webhook runtime or an operator check', async () => {
    expect(await capability(env, false)).toEqual({ privateEmailInvitations: false, emailDelivery: 'none' });
    expect(await capability({ ...env, MATRIX_PAGE_EMAIL_CLERK_SATELLITE_VERIFIED: 'false' }, true))
      .toEqual({ privateEmailInvitations: false, emailDelivery: 'none' });
  });
});
