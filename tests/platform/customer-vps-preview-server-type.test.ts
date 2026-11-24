import { describe, expect, it, vi } from 'vitest';
import { getProvisioningJobByMachineId } from '../../packages/platform/src/customer-vps-provisioning-jobs.js';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestConfig, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

// ENG-563: preview machines run on the cheaper preview server type; customer
// machines and already-created previews keep the type they were created with.
describe('preview machine server type', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });
  const ids = [
    '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
    '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
  ];

  it('creates a new shared preview on cx23 while a customer machine keeps the customer type', async () => {
    let nextId = 0;
    const { service, hetzner } = createService({ machineIdFactory: () => ids[nextId++]! });

    const customer = await service.provision({ clerkUserId: 'user_customer', handle: 'alice' });
    const preview = await service.provisionPreview({
      clerkUserId: 'user_preview_owner',
      handle: 'pr-563',
      runtimeSlot: 'pr-563',
    });

    await expect(getUserMachine(db, customer.machineId)).resolves.toMatchObject({
      provisioningClass: 'customer',
      serverType: 'cpx22',
      developerTools: ['codex'],
    });
    await expect(getUserMachine(db, preview.machineId)).resolves.toMatchObject({
      provisioningClass: 'preview',
      serverType: 'cx23',
      location: 'nbg1',
      developerTools: ['codex', 'claude-code', 'opencode', 'pi'],
    });
    expect(vi.mocked(hetzner.createServer).mock.calls.map(([input]) => [input.name, input.serverType]))
      .toEqual([['matrix-alice', 'cpx22'], ['matrix-pr-563', 'cx23']]);
  });

  it('keeps the customer server type for a preview in a location without cx23', async () => {
    const { service, hetzner } = createService({
      config: createTestConfig({ location: 'ash', serverType: 'cpx21' }),
    });

    const preview = await service.provisionPreview({
      clerkUserId: 'user_preview_owner',
      handle: 'pr-564',
      runtimeSlot: 'pr-564',
    });

    await expect(getUserMachine(db, preview.machineId)).resolves.toMatchObject({
      serverType: 'cpx21',
      location: 'ash',
    });
    expect(vi.mocked(hetzner.createServer).mock.calls[0]?.[0]).toMatchObject({
      serverType: 'cpx21',
      location: 'ash',
    });
  });

  it('reuses an existing cpx22 preview unchanged when the same handle is provisioned again', async () => {
    const existingId = '188d9ce1-395d-4d4c-a7b7-22754c3ab991';
    await insertUserMachine(db, {
      machineId: existingId,
      clerkUserId: 'user_preview_owner',
      handle: 'pr-565',
      runtimeSlot: 'pr-565',
      provisioningClass: 'preview',
      status: 'running',
      serverType: 'cpx22',
      location: 'nbg1',
      hetznerServerId: 565,
      publicIPv4: '203.0.113.65',
      imageVersion: 'stable',
      developerTools: ['codex', 'claude-code', 'opencode', 'pi'],
      provisionedAt: '2026-04-20T12:00:00.000Z',
    });
    const { service, hetzner } = createService();

    const response = await service.provisionPreview({
      clerkUserId: 'user_preview_owner',
      handle: 'pr-565',
      runtimeSlot: 'pr-565',
    });

    expect(response).toMatchObject({ machineId: existingId, status: 'running' });
    expect(hetzner.createServer).not.toHaveBeenCalled();
    expect(hetzner.deleteServer).not.toHaveBeenCalled();
    expect(hetzner.resizeServer).not.toHaveBeenCalled();
    await expect(getProvisioningJobByMachineId(db, existingId)).resolves.toBeUndefined();
    await expect(getUserMachine(db, existingId)).resolves.toMatchObject({
      serverType: 'cpx22',
      hetznerServerId: 565,
      status: 'running',
    });
  });
});
