import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { insertUserMachine, listRunningUserMachines, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestConfig, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });
  it('sends channel deploy targets to the VPS system updater endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { service } = createService();
      const provisioned = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
      await service.register('registration-token', {
        machineId: provisioned.machineId,
        hetznerServerId: 123456,
        publicIPv4: '203.0.113.10',
        imageVersion: 'stable',
      });
      await expect(service.deploy({ channel: 'dev' })).resolves.toMatchObject({ triggered: 1, failed: 0 });
      expect(timeoutSpy).toHaveBeenCalledOnce();
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://203.0.113.10:443/api/system/update',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ channel: 'dev' }),
          signal: timeoutSpy.mock.results[0]?.value,
        }),
      );
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it('activates speech only on running authorized customer computers', async () => {
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff140',
      clerkUserId: 'customer_owner',
      handle: 'customer-one',
      runtimeSlot: 'primary',
      provisioningClass: 'customer',
      publicIPv4: '203.0.113.10',
      status: 'running',
      imageVersion: 'v1',
      provisionedAt: '2026-04-26T12:00:00.000Z',
      activationState: 'authorized',
    });
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff141',
      clerkUserId: 'preview_owner',
      handle: 'pr-992',
      runtimeSlot: 'pr-992',
      provisioningClass: 'preview',
      publicIPv4: '203.0.113.11',
      status: 'running',
      imageVersion: 'v1',
      provisionedAt: '2026-04-26T12:01:00.000Z',
      activationState: 'authorized',
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('{}', { status: 202 });
      const post = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(String(post.body)) as {
        machineId: string; runtimeSlot: string; origin: string; runtimeToken: string;
      };
      return Response.json({
        configured: true,
        configurationRevision: createHash('sha256')
          .update(`${body.machineId}\0${body.runtimeSlot}\0${body.origin}\0${body.runtimeToken}`)
          .digest('hex'),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { service } = createService({
      config: createTestConfig({
        platformRegisterUrl: 'https://app.matrix-os.com/vps/register',
        platformSecret: 'p'.repeat(32),
      }),
    });

    try {
      await expect(service.activateSpeech()).resolves.toMatchObject({
        activated: 1,
        failed: 0,
        complete: true,
        nextCursor: null,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://203.0.113.10:443/api/internal/platform-speech/config',
        expect.objectContaining({ method: 'POST' }),
      );
      const request = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff140',
        runtimeSlot: 'primary',
        enabled: true,
        origin: 'https://app.matrix-os.com',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('continues speech activation after one request-bounded machine page', async () => {
    const machineIds: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const suffix = String(200 + index).padStart(3, '0');
      const machineId = `9f05824c-8d0a-4d83-9cb4-b312d43ff${suffix}`;
      machineIds.push(machineId);
      await insertUserMachine(db, {
        machineId,
        clerkUserId: `customer_owner_${index}`,
        handle: `customer-${String(index).padStart(2, '0')}`,
        runtimeSlot: 'primary',
        provisioningClass: 'customer',
        publicIPv4: `203.0.113.${10 + index}`,
        status: 'running',
        imageVersion: 'v1',
        provisionedAt: '2026-04-26T12:00:00.000Z',
        activationState: 'authorized',
      });
    }
    const postedByUrl = new Map<string, {
      machineId: string; runtimeSlot: string; origin: string; runtimeToken: string;
    }>();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const key = String(url);
      if (init?.method === 'POST') {
        postedByUrl.set(key, JSON.parse(String(init.body)));
        return new Response('{}', { status: 202 });
      }
      const body = postedByUrl.get(key)!;
      return Response.json({
        configured: true,
        configurationRevision: createHash('sha256')
          .update(`${body.machineId}\0${body.runtimeSlot}\0${body.origin}\0${body.runtimeToken}`)
          .digest('hex'),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { service } = createService({
      config: createTestConfig({
        platformRegisterUrl: 'https://app.matrix-os.com/vps/register',
        platformSecret: 'p'.repeat(32),
      }),
    });

    try {
      const first = await service.activateSpeech();
      expect(first).toMatchObject({
        activated: 32,
        failed: 0,
        complete: false,
        nextCursor: machineIds[31],
      });
      const second = await service.activateSpeech({ afterMachineId: first.nextCursor! });
      expect(second).toMatchObject({
        activated: 1,
        failed: 0,
        complete: true,
        nextCursor: null,
        results: [expect.objectContaining({ machineId: machineIds[32] })],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('filters deploy candidates before applying the running-machine limit', async () => {
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff120',
      clerkUserId: 'preview_owner',
      handle: 'pr-992',
      runtimeSlot: 'pr-992',
      provisioningClass: 'preview',
      status: 'running',
      provisionedAt: '2026-04-26T12:01:00.000Z',
      lastSeenAt: '2026-04-26T12:01:00.000Z',
    });
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff121',
      clerkUserId: 'customer_owner',
      handle: 'alice',
      provisioningClass: 'customer',
      status: 'running',
      provisionedAt: '2026-04-26T12:00:00.000Z',
      lastSeenAt: '2026-04-26T12:00:00.000Z',
    });

    const candidates = await listRunningUserMachines(db, 1, {
      provisioningClass: 'customer',
    });

    expect(candidates.map((machine) => machine.handle)).toEqual(['alice']);
  });
  it('only deploys to the requested VPS handle when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const machineIds = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '9f05824c-8d0a-4d83-9cb4-b312d43ff113',
    ];
    const { service } = createService({
      machineIdFactory: () => machineIds.shift() ?? '9f05824c-8d0a-4d83-9cb4-b312d43ff114',
    });
    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice' });
    await service.register('registration-token', {
      machineId: primary.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'stable',
    });
    const staging = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });
    await service.register('registration-token', {
      machineId: staging.machineId,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.11',
      imageVersion: 'stable',
    });

    try {
      await expect(service.deploy({ version: 'v082-onboarding-test', handle: 'alice-staging' }))
        .resolves.toMatchObject({ triggered: 1, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://203.0.113.11:443/api/system/update',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ version: 'v082-onboarding-test' }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

});
