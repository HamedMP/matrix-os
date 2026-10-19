import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { renderCloudInitTemplate } from '../../packages/platform/src/customer-vps-cloud-init.js';
import { buildHostConfig } from '../../packages/platform/src/customer-vps-host-config.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import {
  getUserMachine, promoteHostBundleChannel, updateUserMachine, upsertHostBundleRelease, type PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  advanceGoldenSnapshot, claimGoldenSnapshotBuild, enqueueGoldenSnapshotBuild,
  markGoldenSnapshotReady, recordGoldenSnapshotProviderImage,
} from '../../packages/platform/src/golden-snapshot-repository.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const now = '2026-10-18T12:00:00.000Z';
const ownerId = 'user_onboarding';
const handle = 'onboarding';
const machineId = '30000000-0000-4000-8000-000000000001';
const replacementId = '30000000-0000-4000-8000-000000000002';
const platformSecret = 'fixture-platform-secret';
const model = '@cf/zai-org/glm-5.3-flash';
const bundleSha = '2'.repeat(64);
const template = await readFile(new URL('../../distro/customer-vps/cloud-init.yaml', import.meta.url), 'utf8');

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadCustomerVpsConfig({
    PLATFORM_PUBLIC_URL: 'https://app.matrix-os.com', PLATFORM_SECRET: platformSecret,
    MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true', MATRIX_FUNDED_AI_RELAY_URL: 'https://relay.matrix-os.com',
    MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: 'true',
    GOLDEN_SNAPSHOTS_ENABLED: 'false', GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '100',
    ...overrides,
  });
}

function hostEnv(userData: string): Record<string, string> {
  const cloud = parse(userData) as { write_files: Array<{ path: string; content: string; permissions: string }> };
  const host = cloud.write_files.find(file => file.path === '/opt/matrix/env/host.env');
  expect(host?.permissions).toBe('0640');
  expect(host?.content).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  return Object.fromEntries(host!.content.trim().split('\n').map(line => {
    const equal = line.indexOf('=');
    return [line.slice(0, equal), line.slice(equal + 1)];
  }));
}

// Independent wire derivation catches a mismatched domain, slot or epoch in the
// composed config/template path instead of calling its production token helper.
function token(domain: string, id: string, epoch = 1, slot = 'primary') {
  const payload = [domain, epoch === 1 ? 1 : 2, handle, id, slot];
  return createHmac('sha256', platformSecret)
    .update(JSON.stringify(epoch === 1 ? payload : [...payload, epoch])).digest('hex');
}

function expectManagedFeatures(env: Record<string, string>, id: string, epoch = 1) {
  expect(env).toMatchObject({
    MATRIX_MACHINE_ID: id, MATRIX_CLERK_USER_ID: ownerId, MATRIX_HANDLE: handle,
    MATRIX_RUNTIME_SLOT: 'primary', MATRIX_RUNTIME_TOKEN_EPOCH: String(epoch),
    PLATFORM_INTERNAL_URL: 'https://app.matrix-os.com',
    MATRIX_FUNDED_AI_ENABLED: 'true', MATRIX_FUNDED_AI_RELAY_URL: 'https://relay.matrix-os.com',
    MATRIX_FUNDED_AI_RUNTIME_TOKEN: token('matrix-funded-ai-runtime', id, epoch),
    MATRIX_PLATFORM_SPEECH_ENABLED: 'true', MATRIX_PLATFORM_SPEECH_ORIGIN: 'https://app.matrix-os.com',
    MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: token('matrix-platform-speech-runtime', id, epoch),
  });
  expect(env.MATRIX_FUNDED_AI_RUNTIME_TOKEN).not.toBe(env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN);
  for (const domain of ['matrix-funded-ai-runtime', 'matrix-platform-speech-runtime']) {
    const actual = domain === 'matrix-funded-ai-runtime'
      ? env.MATRIX_FUNDED_AI_RUNTIME_TOKEN : env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN;
    expect(actual).not.toBe(token(domain, id, epoch, 'staging'));
    expect(actual).not.toBe(token(domain, id === machineId ? replacementId : machineId, epoch));
  }
  for (const key of ['PLATFORM_SECRET', 'PLATFORM_SPEECH_OPENAI_API_KEY', 'CF_AIG_AUTHORIZATION', 'AI_RELAY_CONTROL_TOKEN']) {
    expect(env).not.toHaveProperty(key);
  }
}

describe('new customer managed-feature provisioning', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    vi.stubEnv('MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED', 'true');
    vi.stubEnv('MATRIX_FUNDED_AI_RUNTIME_ENABLED', 'true');
    vi.stubEnv('AI_FUNDED_CREDENTIAL_HASH_SECRET', 'h'.repeat(32));
    await db.executor.updateTable('ai_funded_global_policy').set({
      enabled: true, allowed_model_ids: JSON.stringify([model]), revision: 1,
    }).where('policy_id', '=', 'default').execute();
    await upsertHostBundleRelease(db, { version: 'v-onboarding', gitCommit: '1234567', buildTime: now,
      bundleKey: 'system-bundles/v-onboarding/matrix-host-bundle.tar.gz', checksumKey: null,
      sha256: bundleSha, size: 100, createdAt: now });
    await promoteHostBundleChannel(db, 'stable', 'v-onboarding', now);
  });
  afterEach(async () => { await destroyTestPlatformDb(db); vi.unstubAllEnvs(); });

  function service(env: NodeJS.ProcessEnv = {}) {
    const ids = [machineId, replacementId];
    const hetzner = createMockHetznerClient({
      createServer: vi.fn()
        .mockResolvedValueOnce({ id: 123, status: 'running', publicIPv4: '203.0.113.10' })
        .mockResolvedValueOnce({ id: 124, status: 'running', publicIPv4: '203.0.113.11' }),
    });
    const settings = config(env);
    const systemStore = createMockCustomerVpsSystemStore({ hasDbLatest: vi.fn().mockResolvedValue(true) });
    return { settings, hetzner, systemStore, service: createCustomerVpsService({ db, config: settings, hetzner,
      systemStore,
      cloudInitTemplate: template, machineIdFactory: () => ids.shift()!,
      tokenFactory: () => ({ token: 'fixture-registration', hash: hashRegistrationToken('fixture-registration'),
        expiresAt: '2026-10-18T13:00:00.000Z' }),
      now: () => new Date(now),
    }) };
  }

  async function register(instance: ReturnType<typeof service>['service'], id = machineId, serverId = 123) {
    await instance.register('fixture-registration', { machineId: id, hetznerServerId: serverId,
      publicIPv4: serverId === 123 ? '203.0.113.10' : '203.0.113.11',
      imageVersion: 'v-onboarding', bundleSha256: bundleSha, healthy: true });
  }

  async function readySnapshot(settings: ReturnType<typeof config>) {
    const enqueued = await enqueueGoldenSnapshotBuild(db, { bundleVersion: 'v-onboarding',
      compatibility: settings.goldenSnapshots.compatibility,
      snapshotId: '10000000-0000-4000-8000-000000000001',
      buildId: '20000000-0000-4000-8000-000000000001', now });
    const claimed = await claimGoldenSnapshotBuild(db, enqueued.build.buildId, now, '2026-10-18T12:10:00.000Z', 5);
    const fence = claimed!.leaseExpiresAt!;
    for (const [from, to] of [['candidate', 'building'], ['building', 'sanitizing'], ['sanitizing', 'validating']] as const) {
      await advanceGoldenSnapshot(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, fence, from, to, now);
    }
    await recordGoldenSnapshotProviderImage(db, enqueued.snapshot.snapshotId, {
      buildId: enqueued.build.buildId, expectedLeaseExpiresAt: fence, providerImageId: 302,
      providerImageStatus: 'available', imageDiskGb: 40, imageArchitecture: 'x86', now,
    });
    await db.executor.updateTable('golden_snapshot_builds').set({ phase: 'validation_boot' })
      .where('build_id', '=', enqueued.build.buildId).execute();
    await markGoldenSnapshotReady(db, enqueued.snapshot.snapshotId, enqueued.build.buildId, {
      validationSummary: { exactBundle: true, healthy: true, freshActivation: true,
        uniqueMachineId: true, uniqueSshHostKey: true, forbiddenStateAbsent: true },
      expectedLeaseExpiresAt: fence, now,
    });
  }

  it.each(['clean_image', 'snapshot'] as const)('configures both features before a %s customer first registers', async imageSource => {
    const fixture = service({ GOLDEN_SNAPSHOTS_ENABLED: String(imageSource === 'snapshot') });
    if (imageSource === 'snapshot') await readySnapshot(fixture.settings);
    await fixture.service.provision({ clerkUserId: ownerId, handle, runtimeSlot: 'primary' });
    const create = vi.mocked(fixture.hetzner.createServer).mock.calls[0]![0];
    expect(create.image).toBe(imageSource === 'snapshot' ? 302 : undefined);
    const env = hostEnv(create.userData);
    expectManagedFeatures(env, machineId);
    expect(env.MATRIX_IMAGE_SOURCE).toBe(imageSource);
    expect(env.MATRIX_TARGET_BUNDLE_SHA256).toBe(bundleSha);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toEqual([]);
    await register(fixture.service);
    expect(await getUserMachine(db, machineId)).toMatchObject({ status: 'running', activationState: 'authorized' });
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toEqual([
      expect.objectContaining({ machine_id: machineId, owner_id: ownerId, runtime_slot: 'primary',
        enabled: true, allowed_model_ids: JSON.stringify([model]) }),
    ]);
  });

  it.each(['clean_image', 'snapshot'] as const)('rebinds both credentials to a replacement recovered from %s', async imageSource => {
    const fixture = service({ GOLDEN_SNAPSHOTS_ENABLED: String(imageSource === 'snapshot') });
    if (imageSource === 'snapshot') await readySnapshot(fixture.settings);
    await fixture.service.provision({ clerkUserId: ownerId, handle, runtimeSlot: 'primary' });
    await register(fixture.service);
    await updateUserMachine(db, machineId, { runtimeTokenEpoch: 7 });
    const recovered = await fixture.service.recover({ clerkUserId: ownerId, runtimeSlot: 'primary' });
    expect(recovered.machineId).toBe(replacementId);
    const create = vi.mocked(fixture.hetzner.createServer).mock.calls[1]![0];
    expect(create.image).toBe(imageSource === 'snapshot' ? 302 : undefined);
    const env = hostEnv(create.userData);
    expectManagedFeatures(env, replacementId, 7);
    expect(env.MATRIX_IMAGE_SOURCE).toBe(imageSource);
    expect(env.MATRIX_FUNDED_AI_RUNTIME_TOKEN).not.toBe(token('matrix-funded-ai-runtime', machineId, 7));
    expect(env.MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN).not.toBe(token('matrix-platform-speech-runtime', machineId, 7));
    await register(fixture.service, replacementId, 124);
    expect(await getUserMachine(db, replacementId)).toMatchObject({ status: 'running', runtimeTokenEpoch: 7 });
  });

  it('renders rotated epochs through the production cloud-init template for both token domains', () => {
    const host = buildHostConfig(config(), { clerkUserId: ownerId, handle, runtimeSlot: 'primary' },
      machineId, 'registration', '2026-10-18T13:00:00.000Z', 'postgres-fixture',
      { imageVersion: 'v-onboarding', hostBundleUrl: 'https://app.matrix-os.com/system-bundles/v-onboarding/matrix-host-bundle.tar.gz' }, 7);
    expectManagedFeatures(hostEnv(renderCloudInitTemplate(template, host)), machineId, 7);
  });

  it('uses the claimed epoch when credentials rotate after the initial recovery read', async () => {
    const fixture = service();
    await fixture.service.provision({ clerkUserId: ownerId, handle, runtimeSlot: 'primary' });
    await register(fixture.service);
    vi.mocked(fixture.systemStore.hasDbLatest).mockImplementationOnce(async () => {
      await updateUserMachine(db, machineId, { runtimeTokenEpoch: 9 });
      return true;
    });
    await fixture.service.recover({ clerkUserId: ownerId, runtimeSlot: 'primary' });
    expectManagedFeatures(hostEnv(vi.mocked(fixture.hetzner.createServer).mock.calls[1]![0].userData), replacementId, 9);
    expect(await getUserMachine(db, replacementId)).toMatchObject({ runtimeTokenEpoch: 9 });
  });

  it.each([
    ['MATRIX_FUNDED_AI_RUNTIME_ENABLED', 'MATRIX_FUNDED_AI_ENABLED', 'MATRIX_PLATFORM_SPEECH_ENABLED'],
    ['MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED', 'MATRIX_PLATFORM_SPEECH_ENABLED', 'MATRIX_FUNDED_AI_ENABLED'],
  ])('preserves the independent disabled %s gate during provisioning', async (gate, disabled, enabled) => {
    vi.stubEnv(gate, 'false');
    const fixture = service({ [gate]: 'false' });
    await fixture.service.provision({ clerkUserId: ownerId, handle, runtimeSlot: 'primary' });
    const env = hostEnv(vi.mocked(fixture.hetzner.createServer).mock.calls[0]![0].userData);
    expect(env[disabled]).toBe('false');
    expect(env[enabled]).toBe('true');
    if (gate === 'MATRIX_FUNDED_AI_RUNTIME_ENABLED') expect(env.MATRIX_FUNDED_AI_RELAY_URL).toBe('');
    await register(fixture.service);
    const policies = await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute();
    expect(policies).toHaveLength(gate === 'MATRIX_FUNDED_AI_RUNTIME_ENABLED' ? 0 : 1);
  });

  it('does not turn host configuration into eligibility when the global funded policy is disabled', async () => {
    await db.executor.updateTable('ai_funded_global_policy').set({ enabled: false }).execute();
    const fixture = service();
    await fixture.service.provision({ clerkUserId: ownerId, handle, runtimeSlot: 'primary' });
    expectManagedFeatures(hostEnv(vi.mocked(fixture.hetzner.createServer).mock.calls[0]![0].userData), machineId);
    await register(fixture.service);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
  });
});
