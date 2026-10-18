import { describe, it, expect, vi } from 'vitest';
import { getActiveUserMachineByClerkId, getActiveUserMachineByHandle, getRunningUserMachineByHandle, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformRuntimeVerificationToken, buildPlatformSpeechRuntimeVerificationToken, timingSafeTokenEquals, buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { activeEntitlement, createTestConfig, useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

describe('platform/customer-vps', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture(value => { db = value!; });
  it('resolves staging machines by distinct handle for auth and sync fallback paths', async () => {
    let nextId = 0;
    const ids = [
      '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    ];
    const { service } = createService({
      machineIdFactory: () => ids[nextId++] ?? '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
    });

    const primary = await service.provision({ clerkUserId: 'user_123', handle: 'alice', runtimeSlot: 'primary' });
    const staging = await service.provision({ clerkUserId: 'user_123', handle: 'alice-staging', runtimeSlot: 'staging' });
    await updateUserMachine(db, primary.machineId, {
      status: 'running',
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });
    await updateUserMachine(db, staging.machineId, {
      status: 'running',
      publicIPv4: '203.0.113.11',
      imageVersion: 'matrix-os-host-2026.04.26-1',
    });

    await expect(getActiveUserMachineByHandle(db, 'alice-staging')).resolves.toMatchObject({
      machineId: staging.machineId,
      runtimeSlot: 'staging',
    });
    await expect(getRunningUserMachineByHandle(db, 'alice-staging')).resolves.toMatchObject({
      machineId: staging.machineId,
      runtimeSlot: 'staging',
      status: 'running',
    });
    await expect(getRunningUserMachineByHandle(db, 'alice-staging', 'primary')).resolves.toBeUndefined();
  });
  it('templates legacy and exact runtime-bound verification tokens into provisioned customer hosts', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const expected = buildPlatformVerificationToken('alice', 'platform-secret');
    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    const fundedRuntimeToken = createInput?.userData
      .match(/^\s*MATRIX_FUNDED_AI_RUNTIME_TOKEN=([^\s]+)$/m)?.[1];
    expect(createInput?.userData).toContain(`UPGRADE_TOKEN=${expected}`);
    expect(createInput?.userData).toContain(`MATRIX_AUTH_TOKEN=${expected}`);
    expect(createInput?.userData).toContain(`MATRIX_CODE_PROXY_TOKEN=${expected}`);
    expect(fundedRuntimeToken).toBe(buildPlatformRuntimeVerificationToken({
      handle: 'alice',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      runtimeSlot: 'primary',
    }, 'platform-secret'));
    expect(timingSafeTokenEquals(fundedRuntimeToken, buildPlatformRuntimeVerificationToken({
      handle: 'alice',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      runtimeSlot: 'staging',
    }, 'platform-secret'))).toBe(false);
    expect(timingSafeTokenEquals(fundedRuntimeToken, buildPlatformRuntimeVerificationToken({
      handle: 'alice',
      machineId: 'machine_predecessor',
      runtimeSlot: 'primary',
    }, 'platform-secret'))).toBe(false);
    expect(createInput?.userData).toContain('PLATFORM_INTERNAL_URL=http://localhost:9000');
    expect(createInput?.userData).not.toContain('PIPEDREAM_CLIENT_SECRET');
  });
  it('templates only the funded runtime flag and relay URL into customer hosts', async () => {
    const { service, hetzner } = createService({
      config: createTestConfig({
        fundedAiEnabled: true,
        fundedAiRelayUrl: 'https://relay.matrix-os.com',
      }),
    });

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain('MATRIX_FUNDED_AI_ENABLED=true');
    expect(createInput?.userData).toContain('MATRIX_FUNDED_AI_RELAY_URL=https://relay.matrix-os.com');
    const machine = await getActiveUserMachineByHandle(db, 'alice');
    const fundedToken = buildPlatformRuntimeVerificationToken({
      handle: 'alice',
      machineId: machine!.machineId,
      runtimeSlot: machine!.runtimeSlot,
    }, 'platform-secret');
    expect(createInput?.userData).toContain(`MATRIX_FUNDED_AI_RUNTIME_TOKEN=${fundedToken}`);
    expect(fundedToken).not.toBe(buildPlatformVerificationToken('alice', 'platform-secret'));
    expect(createInput?.userData).not.toContain('AI_RELAY_CONTROL_TOKEN');
    expect(createInput?.userData).not.toContain('CF_AIG_AUTHORIZATION');
  });
  it('templates managed speech runtime routing without provider credentials', async () => {
    const { service, hetzner } = createService({
      config: createTestConfig({ platformSpeechEnabled: true }),
    });

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    const runtimeToken = buildPlatformSpeechRuntimeVerificationToken({
      handle: 'alice',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      runtimeSlot: 'primary',
    }, 'platform-secret');
    expect(createInput?.userData).toContain('MATRIX_PLATFORM_SPEECH_ENABLED=true');
    expect(createInput?.userData).toContain('MATRIX_PLATFORM_SPEECH_ORIGIN=http://localhost:9000');
    expect(createInput?.userData).toContain(`MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=${runtimeToken}`);
    expect(createInput?.userData).not.toContain('PLATFORM_SPEECH_OPENAI_API_KEY');
  });
  it('never templates platform R2 credentials into provisioned customer hosts', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).not.toContain('AWS_ACCESS_KEY_ID');
    expect(createInput?.userData).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(createInput?.userData).not.toContain('R2_ENDPOINT');
    expect(createInput?.userData).not.toContain('/opt/matrix/env/r2.env');
  });
  it('templates public PostHog telemetry into provisioned customer hosts', async () => {
    const { service, hetzner } = createService();

    await service.provision({ clerkUserId: 'user_123', handle: 'alice' });

    const createInput = vi.mocked(hetzner.createServer).mock.calls[0]?.[0];
    expect(createInput?.userData).toContain('POSTHOG_TOKEN=phc_public');
    expect(createInput?.userData).toContain('POSTHOG_PROJECT_TOKEN=phc_project');
    expect(createInput?.userData).toContain('POSTHOG_HOST=https://eu.i.posthog.com');
    expect(createInput?.userData).toContain('NEXT_PUBLIC_POSTHOG_KEY=phc_public');
    expect(createInput?.userData).toContain('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_project');
    expect(createInput?.userData).toContain('NEXT_PUBLIC_POSTHOG_HOST=https://eu.posthog.com');
    expect(createInput?.userData).toContain('NEXT_PUBLIC_POSTHOG_API_HOST=/relay');
  });
  it.each(['ash', 'hil'] as const)(
    'continues to provision an existing US machine in %s',
    async (location) => {
      const { service, hetzner } = createService({
        config: createTestConfig({ location: 'nbg1' }),
        resolveBillingEntitlement: vi.fn().mockResolvedValue(activeEntitlement()),
      });

      await service.provision({
        clerkUserId: 'user_123',
        handle: 'alice',
        serverType: 'cpx22',
        location,
      });

      expect(vi.mocked(hetzner.createServer).mock.calls[0]?.[0]).toMatchObject({
        serverType: 'cpx22',
        location,
      });
      await expect(getActiveUserMachineByClerkId(db, 'user_123')).resolves.toMatchObject({
        serverType: 'cpx22',
        location,
      });
    },
  );

});
