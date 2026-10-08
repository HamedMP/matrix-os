import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { getActiveUserMachineByClerkId, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const secret = 'recovery-admission-secret-at-least-32';
const owner = 'user_recovery_admission';
describe('account deletion recovery admission', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    await insertUserMachine(db, { machineId: 'old-recovery', clerkUserId: owner, handle: 'recoverytest', status: 'running', runtimeSlot: 'primary', hetznerServerId: 123, serverType: 'cpx22', provisionedAt: '2026-10-04T12:00:00.000Z' });
  });
  afterEach(async () => { vi.unstubAllEnvs(); await destroyTestPlatformDb(db); });
  const schedule = () => new AccountDeletionRepository(db.kysely, { secret }).accept({ clerkUserId: owner, appleTokens: [] }, false);
  const compose = (hetzner = createMockHetznerClient()) => ({ hetzner, service: createCustomerVpsService({
    db, hetzner, systemStore: createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn().mockResolvedValue(true) }),
    config: loadCustomerVpsConfig({ PLATFORM_SECRET: 'platform-secret', HETZNER_API_TOKEN: 'test', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test', S3_ENDPOINT: 'https://r2.example', R2_BUCKET: 'test' }),
    machineIdFactory: () => 'a1111111-1111-4111-8111-111111111111',
  }) });
  it('refuses a scheduled owner before changing recovery identity or creating a replacement', async () => {
    const { service, hetzner } = compose(); await schedule();
    await expect(service.recover({ clerkUserId: owner })).rejects.toThrow();
    expect(hetzner.createServer).not.toHaveBeenCalled();
    expect(await getActiveUserMachineByClerkId(db, owner, 'primary')).toMatchObject({ machineId: 'old-recovery', status: 'running', hetznerServerId: 123 });
  });
  it('keeps an ambiguous recovery intent available for deletion drain instead of adopting a late provider server', async () => {
    const hetzner = createMockHetznerClient({ createServer: vi.fn().mockRejectedValue(new DOMException('Provider timeout', 'TimeoutError')) });
    const { service } = compose(hetzner);
    await expect(service.recover({ clerkUserId: owner })).rejects.toThrow();
    const pending = await getActiveUserMachineByClerkId(db, owner, 'primary');
    expect(pending).toMatchObject({ status: 'recovering', hetznerServerId: null, recoveryOldServerId: 123 });
    expect(pending?.recoveryEncryptedPayload).toEqual(expect.any(String));
    vi.mocked(hetzner.listServersByLabel!).mockResolvedValue([{ id: 456, status: 'running', publicIPv4: '203.0.113.12', publicIPv6: null,
      labels: { machine_id: pending!.machineId, clerk_user_id: owner, runtime_slot: 'primary', image_source: 'clean_image' } }]);
    await schedule(); await service.reconcileProvisioning();
    expect(await getActiveUserMachineByClerkId(db, owner, 'primary')).toMatchObject({ machineId: pending!.machineId, hetznerServerId: null, recoveryOldServerId: 123, recoveryEncryptedPayload: pending!.recoveryEncryptedPayload });
    expect(hetzner.createServer).toHaveBeenCalledOnce();
  });
});
