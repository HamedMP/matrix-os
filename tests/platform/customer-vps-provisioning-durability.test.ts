import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveUserMachineByHandle,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  insertProvisioningJob,
  listProvisioningJobs,
  type NewProvisioningJob,
} from '../../packages/platform/src/customer-vps-provisioning-jobs.js';
import { createCustomerVpsRoutes } from '../../packages/platform/src/customer-vps-routes.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const PLATFORM_SECRET = 'platform-secret';
const ADMIN_HEADERS = {
  authorization: `Bearer ${PLATFORM_SECRET}`,
  'content-type': 'application/json',
};

describe('platform/customer-vps provisioning durability', () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function createHarness(overrides: Parameters<typeof createCustomerVpsService>[0] = {} as never) {
    const hetzner = createMockHetznerClient(overrides.hetzner);
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_SECRET,
        HETZNER_API_TOKEN: 'provider-token',
        PLATFORM_PUBLIC_URL: 'https://api.matrix-os.com',
        CUSTOMER_VPS_IMAGE_VERSION: 'dev',
        S3_ACCESS_KEY_ID: 'r2-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-secret-key',
        S3_ENDPOINT: 'https://r2.example',
        R2_BUCKET: 'matrixos-sync',
      }),
      hetzner,
      systemStore: createMockCustomerVpsSystemStore(),
      machineIdFactory: () => '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      provisioningJobIdFactory: () => '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
      tokenFactory: () => ({
        token: 'registration-token',
        hash: hashRegistrationToken('registration-token'),
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      postgresPasswordFactory: () => 'postgres-secret',
      now: () => new Date('2026-07-12T01:00:00.000Z'),
      ...overrides,
    });
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret: PLATFORM_SECRET }));
    return { app, hetzner, service };
  }

  async function previewProvision(app: Hono): Promise<Response> {
    return app.request('/vps/preview/provision', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({
        clerkUserId: 'user_preview',
        handle: 'pr-919',
        runtimeSlot: 'pr-919',
      }),
    });
  }

  it('moves an absent preview through durably visible provisioning to running', async () => {
    const { app, service } = createHarness();

    const accepted = await previewProvision(app);

    expect(accepted.status).toBe(202);
    const machine = await getActiveUserMachineByHandle(db, 'pr-919', 'pr-919');
    expect(machine).toMatchObject({ status: 'provisioning', provisioningClass: 'preview' });
    const jobs = await listProvisioningJobs(db, 10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ machineId: machine?.machineId, status: 'completed' });

    await service.register('registration-token', {
      machineId: machine!.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      publicIPv6: '2001:db8::1',
      imageVersion: 'dev',
    });

    await expect(getActiveUserMachineByHandle(db, 'pr-919', 'pr-919')).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('keeps repeated preview provisioning idempotent across the machine and job', async () => {
    const { app, hetzner } = createHarness();

    const first = await previewProvision(app);
    const second = await previewProvision(app);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
    expect(hetzner.createServer).toHaveBeenCalledTimes(1);
    await expect(listProvisioningJobs(db, 10)).resolves.toHaveLength(1);
  });

  it('rolls back the machine and returns non-success when durable enqueue fails', async () => {
    const enqueueProvisioningJob = vi.fn<(
      db: PlatformDB,
      job: NewProvisioningJob,
    ) => Promise<void>>().mockRejectedValue(new Error('persistence unavailable'));
    const { app, hetzner } = createHarness({ enqueueProvisioningJob });

    const response = await previewProvision(app);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Provisioning failed' });
    expect(hetzner.createServer).not.toHaveBeenCalled();
    await expect(getActiveUserMachineByHandle(db, 'pr-919', 'pr-919')).resolves.toBeUndefined();
  });

  it('shows the accepted machine in fleet immediately', async () => {
    const { app } = createHarness();

    expect((await previewProvision(app)).status).toBe(202);
    const fleet = await app.request('/vps/fleet', { headers: ADMIN_HEADERS });

    expect(fleet.status).toBe(200);
    expect(await fleet.json()).toMatchObject({
      machines: [expect.objectContaining({
        handle: 'pr-919',
        runtimeSlot: 'pr-919',
        status: 'provisioning',
      })],
    });
  });

  it('dispatches a durably queued job from the reconciliation worker', async () => {
    let currentTime = new Date('2026-07-12T01:00:00.000Z');
    const enqueueProvisioningJob = vi.fn(async (transaction: PlatformDB, job: NewProvisioningJob) => {
      await insertProvisioningJob(transaction, {
        ...job,
        availableAt: '2026-07-12T01:01:00.000Z',
      });
    });
    const { app, hetzner, service } = createHarness({
      enqueueProvisioningJob,
      now: () => currentTime,
    });

    expect((await previewProvision(app)).status).toBe(202);
    expect(hetzner.createServer).not.toHaveBeenCalled();
    await expect(listProvisioningJobs(db, 10)).resolves.toEqual([
      expect.objectContaining({ status: 'queued', attempts: 0 }),
    ]);

    currentTime = new Date('2026-07-12T01:02:00.000Z');
    await expect(service.dispatchProvisioningJobs()).resolves.toEqual({
      checked: 1,
      completed: 1,
      failed: 0,
    });
    expect(hetzner.createServer).toHaveBeenCalledOnce();
    await expect(listProvisioningJobs(db, 10)).resolves.toEqual([
      expect.objectContaining({ status: 'completed', attempts: 1, encryptedPayload: null }),
    ]);
  });

  it('adopts a provider server created before an expired worker lease instead of duplicating it', async () => {
    let currentTime = new Date('2026-07-12T01:00:00.000Z');
    const enqueueProvisioningJob = vi.fn(async (transaction: PlatformDB, job: NewProvisioningJob) => {
      await insertProvisioningJob(transaction, {
        ...job,
        availableAt: '2026-07-12T01:01:00.000Z',
      });
    });
    const hetzner = createMockHetznerClient({
      listServersByLabel: vi.fn().mockResolvedValue([{
        id: 654321,
        status: 'running',
        serverType: 'cpx22',
        publicIPv4: '203.0.113.20',
        publicIPv6: '2001:db8::20',
      }]),
    });
    const { app, service } = createHarness({
      enqueueProvisioningJob,
      hetzner,
      now: () => currentTime,
    });

    expect((await previewProvision(app)).status).toBe(202);
    currentTime = new Date('2026-07-12T01:02:00.000Z');
    await expect(service.dispatchProvisioningJobs()).resolves.toMatchObject({ completed: 1 });

    expect(hetzner.createServer).not.toHaveBeenCalled();
    await expect(getActiveUserMachineByHandle(db, 'pr-919', 'pr-919')).resolves.toMatchObject({
      hetznerServerId: 654321,
      publicIPv4: '203.0.113.20',
    });
  });

  it('fails an expired job at the bounded worker-attempt limit without corrupting its row', async () => {
    const enqueueProvisioningJob = vi.fn(async (transaction: PlatformDB, job: NewProvisioningJob) => {
      await insertProvisioningJob(transaction, {
        ...job,
        availableAt: '2026-07-12T01:01:00.000Z',
      });
    });
    let currentTime = new Date('2026-07-12T01:00:00.000Z');
    const { app, hetzner, service } = createHarness({
      enqueueProvisioningJob,
      now: () => currentTime,
    });
    expect((await previewProvision(app)).status).toBe(202);
    await db.executor.updateTable('provisioning_jobs').set({
      status: 'running',
      attempts: 100,
      claimed_at: '2026-07-12T00:50:00.000Z',
      lease_expires_at: '2026-07-12T00:55:00.000Z',
    }).execute();

    currentTime = new Date('2026-07-12T01:02:00.000Z');
    await expect(service.dispatchProvisioningJobs()).resolves.toEqual({
      checked: 1,
      completed: 0,
      failed: 1,
    });

    expect(hetzner.createServer).not.toHaveBeenCalled();
    await expect(listProvisioningJobs(db, 10)).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        attempts: 100,
        encryptedPayload: null,
        lastErrorCode: 'retry_exhausted',
      }),
    ]);
    await expect(getActiveUserMachineByHandle(db, 'pr-919', 'pr-919')).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'retry_exhausted',
    });
  });
});
