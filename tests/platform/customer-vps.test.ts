import { describe, it, expect, vi } from 'vitest';
import { getActiveUserMachineByClerkId, getUserMachine, promoteHostBundleChannel, updateUserMachine, upsertHostBundleRelease, type PlatformDB } from '../../packages/platform/src/db.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import { getProvisioningJobByMachineId } from '../../packages/platform/src/customer-vps-provisioning-jobs.js';
import { createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestConfig, activeEntitlement, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });

  it('provisions a user machine idempotently by clerkUserId', async () => {
    const { service, hetzner } = createService({
      config: createTestConfig({ serverType: 'cpx42' }),
    });

    const first = await service.provision({ clerkUserId: 'user_123', handle: 'alice', developerTools: ['codex', 'pi'] });
    const second = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(first).toEqual({ machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', status: 'provisioning', etaSeconds: 90 });
    expect(second).toEqual(first);
    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.hetznerServerId).toBe(123456);
    expect(row?.provisioningClass).toBe('customer');
    expect(row?.registrationTokenHash).toBe(hashRegistrationToken('registration-token'));
    expect(row?.developerTools).toEqual(['codex', 'pi']);
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain("MATRIX_DEVELOPER_TOOLS='codex pi'");
  });

  it('returns after durable enqueue when provider dispatch is detached', async () => {
    let dispatch!: () => Promise<void>;
    let finishCreate!: (server: Awaited<ReturnType<ReturnType<typeof createMockHetznerClient>['createServer']>>) => void;
    const createStarted = Promise.withResolvers<void>();
    const createFinished = new Promise<Awaited<ReturnType<ReturnType<typeof createMockHetznerClient>['createServer']>>>((resolve) => {
      finishCreate = resolve;
    });
    const { service, hetzner } = createService({
      hetzner: {
        createServer: vi.fn(async () => {
          createStarted.resolve();
          return createFinished;
        }),
      },
      scheduleProvisioningDispatch: (scheduled) => {
        dispatch = scheduled;
      },
    });

    const response = await service.provision(
      { clerkUserId: 'user_123', handle: 'alice' },
      { dispatch: 'detached' },
    );
    expect(hetzner.createServer).not.toHaveBeenCalled();
    await expect(getProvisioningJobByMachineId(db, response.machineId)).resolves.toMatchObject({
      status: 'queued',
    });

    const dispatching = dispatch();
    await createStarted.promise;
    finishCreate({
      id: 123456,
      status: 'running',
      publicIPv4: '203.0.113.10',
      publicIPv6: '2001:db8::1',
    });
    await dispatching;

    expect(response).toEqual({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      status: 'provisioning',
      etaSeconds: 90,
    });
    expect(hetzner.createServer).toHaveBeenCalledOnce();
    await expect(getActiveUserMachineByClerkId(db, 'user_123')).resolves.toMatchObject({
      hetznerServerId: 123456,
    });
  });

  it('preserves an intentional empty developer tool selection', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice', developerTools: [] });

    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.developerTools).toEqual([]);
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain("MATRIX_DEVELOPER_TOOLS=''");
  });

  it('uses the active billing entitlement server type when provisioning new machines', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement()),
    });

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(vi.mocked(hetzner.createServer).mock.calls[0]?.[0]).toMatchObject({
      serverType: 'cpx32',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123')).resolves.toMatchObject({
      serverType: 'cpx32',
    });
  });

  it('normalizes billing entitlement server types before enforcing explicit selection', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        defaultServerType: 'CPX32',
        allowedServerTypes: ['CPX22', 'CPX32'],
      })),
    });

    await service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      serverType: 'cpx22',
    });

    expect(vi.mocked(hetzner.createServer).mock.calls[0]?.[0]).toMatchObject({
      serverType: 'cpx22',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123')).resolves.toMatchObject({
      serverType: 'cpx22',
    });
  });

  it('rejects a CPX22 provisioning request with multiple developer tools before creating a machine', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        defaultServerType: 'CPX22',
        allowedServerTypes: ['CPX22'],
      })),
    });

    await expect(service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      serverType: 'cpx22',
      developerTools: ['codex', 'pi'],
    })).rejects.toMatchObject({
      status: 400,
      publicMessage: 'Invalid request',
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
    await expect(getActiveUserMachineByClerkId(db, 'user_123')).resolves.toBeUndefined();
  });

  it('falls back to the first allowed billing server type when the default is missing', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        defaultServerType: '',
        allowedServerTypes: ['cpx22', 'cpx32'],
      })),
    });

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect(vi.mocked(hetzner.createServer).mock.calls[0]?.[0]).toMatchObject({
      serverType: 'cpx22',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123')).resolves.toMatchObject({
      serverType: 'cpx22',
    });
  });

  it('allows provisioning during the three-day billing grace period', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        status: 'past_due',
        gracePeriodEndsAt: '2026-04-27T00:00:00.000Z',
      })),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice' })).resolves.toMatchObject({
      status: 'provisioning',
    });
    expect(hetzner.createServer).toHaveBeenCalledOnce();
  });

  it('blocks new machine provisioning after billing access expires', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        status: 'past_due',
        gracePeriodEndsAt: '2026-04-25T23:59:59.000Z',
      })),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice' })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });

  it('blocks a new runtime slot without its own subscription and preserves the existing machine', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
      resolveBillingEntitlement: vi.fn(async (_billingDb, _clerkUserId, runtimeSlot) =>
        runtimeSlot === 'primary' ? activeEntitlement({ maxRuntimeSlots: 1 }) : null),
    });

    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary' });
    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice-tools', runtimeSlot: 'tools' })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });

    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    await expect(getUserMachine(db, primary.machineId)).resolves.toMatchObject({
      handle: 'alice',
      deletedAt: null,
    });
  });

  it('counts a billing-suspended computer against the retained runtime-slot limit', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? ids[1]!,
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        source: 'override',
        maxRuntimeSlots: 1,
      })),
    });
    const primary = await service.provision({
      clerkUserId: 'user_123',
      handle: 'alice',
      runtimeSlot: 'primary',
    });
    await updateUserMachine(db, primary.machineId, { status: 'suspended' });

    await expect(service.provision({
      clerkUserId: 'user_123',
      handle: 'alice-tools',
      runtimeSlot: 'tools',
    })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });

    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toMatchObject({
      machineId: primary.machineId,
      status: 'suspended',
      deletedAt: null,
    });
  });

  it('rechecks the exact slot subscription inside the machine-claim transaction', async () => {
    const resolveBillingEntitlement = vi.fn()
      .mockResolvedValueOnce(activeEntitlement({ maxRuntimeSlots: 1 }))
      .mockResolvedValueOnce(null);
    const { service, hetzner } = createService({ resolveBillingEntitlement });

    await expect(service.provision({
      clerkUserId: 'user_123',
      handle: 'alice-studio',
      runtimeSlot: 'studio',
    })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });

    expect(resolveBillingEntitlement).toHaveBeenCalledTimes(2);
    expect(hetzner.createServer).not.toHaveBeenCalled();
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'studio')).resolves.toBeUndefined();
  });

  it('rejects requested Hetzner server types outside the entitlement catalog', async () => {
    const { service, hetzner } = createService({
      resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement({
        allowedServerTypes: ['cpx22'],
        defaultServerType: 'cpx22',
      })),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice', serverType: 'cpx52' })).rejects.toMatchObject({
      status: 402,
      publicMessage: 'Billing upgrade required',
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });

  it('pins channel image versions to the current immutable host bundle release at provision time', async () => {
    await upsertHostBundleRelease(db, {
      version: 'v2026.05.25-80',
      channel: 'stable',
      gitCommit: 'adb12c560b8e6253fd0047eb2375b379e7659cbe',
      gitRef: 'main',
      buildTime: '2026-05-25T11:58:42.274Z',
      bundleKey: 'system-bundles/v2026.05.25-80/matrix-host-bundle.tar.gz',
      checksumKey: 'system-bundles/v2026.05.25-80/matrix-host-bundle.tar.gz.sha256',
      sha256: 'a'.repeat(64),
      size: 1_257_725_742,
      severity: 'normal',
      updateType: 'manual',
      changelog: 'Release latest main host bundle',
      createdAt: '2026-05-25T12:14:58.275Z',
    });
    await promoteHostBundleChannel(db, 'stable', 'v2026.05.25-80');
    const { service, hetzner } = createService();

    const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    expect((await getUserMachine(db, provisioned.machineId))?.imageVersion).toBe('v2026.05.25-80');
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain(
      'MATRIX_HOST_BUNDLE_URL=http://localhost:9000/system-bundles/v2026.05.25-80/matrix-host-bundle.tar.gz',
    );
    expect(createInput?.userData).toContain('MATRIX_IMAGE_VERSION=v2026.05.25-80');
    expect(createInput?.userData).toContain('MATRIX_UPDATE_CHANNEL=stable');
  });

  it('boots operator previews from an explicitly published immutable bundle', async () => {
    const version = 'v2026.09.11-pr1607-34614651893-1-1388d33';
    await upsertHostBundleRelease(db, {
      version,
      channel: 'none',
      gitCommit: '1388d33397ff502ff046f5d65cf3c3538b44d283',
      gitRef: 'codex/om-214-chat-agent-ui',
      buildTime: '2026-09-11T15:20:00.000Z',
      bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`,
      checksumKey: `system-bundles/${version}/matrix-host-bundle.tar.gz.sha256`,
      sha256: 'b'.repeat(64),
      size: 1_257_725_742,
      severity: 'normal',
      updateType: 'manual',
      changelog: 'Preview bundle',
      createdAt: '2026-09-11T15:22:00.000Z',
    });
    const { service, hetzner } = createService();

    const provisioned = await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-1607',
      runtimeSlot: 'pr-1607',
      bundleVersion: version,
    });

    expect((await getUserMachine(db, provisioned.machineId))?.imageVersion).toBe(version);
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain(
      `MATRIX_HOST_BUNDLE_URL=http://localhost:9000/system-bundles/${version}/matrix-host-bundle.tar.gz`,
    );
    expect(createInput?.userData).toContain(`MATRIX_IMAGE_VERSION=${version}`);
    expect(createInput?.userData).toContain('MATRIX_UPDATE_CHANNEL=stable');
  });

  it('rejects an unpublished explicit preview bundle before creating a server', async () => {
    const { service, hetzner } = createService();

    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-1607',
      runtimeSlot: 'pr-1607',
      bundleVersion: 'v2026.09.11-pr1607-1-1-abcdef0',
    })).rejects.toMatchObject({
      status: 409,
      code: 'invalid_state',
      publicMessage: 'Provisioning unavailable',
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });

  it('rejects an unpublished explicit bundle before resuming an existing preview', async () => {
    const { service, hetzner } = createService();
    await service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-1607',
      runtimeSlot: 'pr-1607',
    });
    vi.mocked(hetzner.createServer).mockClear();

    await expect(service.provisionPreview({
      clerkUserId: 'user_123',
      handle: 'pr-1607',
      runtimeSlot: 'pr-1607',
      bundleVersion: 'v2026.09.11-pr1607-unknown',
    })).rejects.toMatchObject({
      status: 409,
      code: 'invalid_state',
      publicMessage: 'Provisioning unavailable',
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });

  it('can provision an isolated staging runtime for the same Clerk user', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service, hetzner } = createService({
      machineIdFactory: () => ids[nextId++] ?? '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    });

    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary' });
    const staging = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });
    const stagingAgain = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });

    expect(primary.machineId).toBe(ids[0]);
    expect(staging.machineId).toBe(ids[1]);
    expect(stagingAgain).toEqual(staging);
    expect(hetzner.createServer).toHaveBeenCalledTimes(2);
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'primary')).resolves.toMatchObject({
      handle: 'alice',
      runtimeSlot: 'primary',
    });
    await expect(getActiveUserMachineByClerkId(db, 'user_123', 'staging')).resolves.toMatchObject({
      handle: 'alice-staging',
      runtimeSlot: 'staging',
    });
  });

  it('records a failed status with a generic failure code when Hetzner create fails', async () => {
    const { service } = createService({
      hetzner: createMockHetznerClient({
        createServer: vi.fn().mockRejectedValue(new CustomerVpsError(429, 'quota_exceeded', 'Provisioning capacity unavailable')),
      }),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice' })).rejects.toMatchObject({
      status: 429,
      code: 'quota_exceeded',
    });

    const row = await getActiveUserMachineByClerkId(db, 'user_123');
    expect(row?.status).toBe('failed');
    expect(row?.failureCode).toBe('quota_exceeded');
  });

  it('deletes a newly-created Hetzner server when recording it in the DB fails', async () => {
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const { service, hetzner } = createService({
      hetzner: createMockHetznerClient({
        createServer: vi.fn().mockImplementation(async () => {
          await db.destroy();
          return {
            id: 654321,
            status: 'running',
            publicIPv4: '203.0.113.20',
          };
        }),
        deleteServer,
      }),
    });

    await expect(service.provision({ clerkUserId: 'user_123', handle: 'alice' })).rejects.toMatchObject({
      status: 500,
      code: 'provider_unavailable',
    });

    expect(hetzner.createServer).toHaveBeenCalledOnce();
    expect(deleteServer).toHaveBeenCalledWith(654321);
  });

});
