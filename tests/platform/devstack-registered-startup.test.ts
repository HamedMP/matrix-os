import { Agent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPlatformServer, type StartPlatformServerOptions } from '../../packages/platform/src/platform-startup.js';

const startup = vi.hoisted(() => ({
  createDb: vi.fn(),
  dockerImport: vi.fn(),
  dockerConstructor: vi.fn(),
  createLifecycle: vi.fn(),
  createStats: vi.fn(),
  lifecycleStart: vi.fn(),
  statsStart: vi.fn(),
}));
vi.mock('../../packages/platform/src/db.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/platform/src/db.js')>(),
  createPlatformDb: startup.createDb,
}));
vi.mock('dockerode', () => {
  startup.dockerImport();
  return { default: class {
    constructor() { startup.dockerConstructor(); }
  } };
});
vi.mock('../../packages/platform/src/lifecycle.js', () => ({ createLifecycleManager: startup.createLifecycle }));
vi.mock('../../packages/platform/src/stats-collector.js', () => ({ createStatsCollector: startup.createStats }));

const env = {
  MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY: 'true',
  MATRIX_DEVSTACK_INSTANCE: 'startup-test',
  MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'true',
  PLATFORM_RUNTIME_MODE: 'local',
  PLATFORM_BACKGROUND_WORKERS_ENABLED: 'false',
  PLATFORM_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1/matrixos_devstack_startup_test',
  NODE_ENV: 'test',
};

async function startFixture(override: NodeJS.ProcessEnv, inspect: StartPlatformServerOptions['createApp'], platformSecret = 'fixture'): Promise<void> {
  const previous = process.env;
  const container = new Agent();
  const vps = new Agent();
  const unused = () => { throw new Error('Unexpected request work during startup'); };
  process.env = { ...env, ...override };
  try {
    await startPlatformServer({
      port: 0, platformSecret, platformJwtSecret: 'fixture', codeServerPort: 8080,
      containerProxyDispatcher: container, customerVpsProxyDispatcher: vps,
      createApp: inspect,
      checkUnsafeDefaultSecrets: () => [], checkCustomerVpsPrimaryStorageEnv: () => [],
      checkPublicSitesEnv: () => [], checkHomeMirrorS3Env: () => [], checkHostBundleStorageEnv: () => [],
      collectTenantPublicTelemetryEnv: () => [], stripeBillingEntitlementsEnabled: () => false,
      resolveEffectiveBillingEntitlement: unused, getRuntimeEntitlementDecision: unused,
      getRuntimeEntitlementDecisionForUser: unused,
    });
  } finally {
    process.env = previous;
    await Promise.all([container.close(), vps.close()]);
  }
}

describe('registered DevStack production startup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('wires the disabled orchestrator without loading Docker or scheduling workers', async () => {
    const marker = new Error('stop before binding a listener');
    const destroy = vi.fn(async () => {});
    startup.createDb.mockReturnValue({ ready: Promise.resolve(), destroy });
    startup.createLifecycle.mockReturnValue({ start: startup.lifecycleStart });
    startup.createStats.mockReturnValue({ start: startup.statsStart });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    try {
      const actionResults: Promise<unknown>[] = [];
      const compose = vi.fn<StartPlatformServerOptions['createApp']>();
      compose.mockImplementation(deps => {
        expect.soft(deps.docker).toBeUndefined();
        expect.soft(deps.customerVpsService).toBeUndefined();
        expect.soft(deps).toMatchObject({ registeredRuntimeInstance: 'startup-test' });
        for (const action of [
          () => deps.orchestrator.provision('fixture', 'user_fixture'),
          () => deps.orchestrator.start('fixture'),
          () => deps.orchestrator.stop('fixture'),
          () => deps.orchestrator.destroy('fixture'),
          () => deps.orchestrator.upgrade('fixture'),
          () => deps.orchestrator.rollingRestart(),
        ]) {
          actionResults.push(Promise.resolve().then(action).then(
            () => ({ status: 'fulfilled' }), reason => ({ status: 'rejected', reason }),
          ));
        }
        throw marker;
      });
      await expect(startFixture({}, compose)).rejects.toBe(marker);
      expect.soft(compose).toHaveBeenCalledOnce();
      const lifecycle = await Promise.all(actionResults);
      expect.soft(lifecycle).toHaveLength(6);
      for (const result of lifecycle) {
        expect.soft(result).toMatchObject({ status: 'rejected', reason: { name: 'LegacyContainerOrchestrationDisabledError' } });
      }
      expect.soft(startup.dockerImport).not.toHaveBeenCalled();
      expect.soft(startup.dockerConstructor).not.toHaveBeenCalled();
      expect.soft(startup.createLifecycle).not.toHaveBeenCalled();
      expect.soft(startup.createStats).not.toHaveBeenCalled();
      expect.soft(intervals).not.toHaveBeenCalled();
      expect.soft(destroy).toHaveBeenCalledOnce();
    } finally {
      for (const result of intervals.mock.results) {
        if (result.type === 'return') clearInterval(result.value);
      }
    }
  });

  it('wires public preview membership without a Clerk secret only with pinned verify-only claims', async () => {
    const marker = new Error('stop before binding a listener');
    const destroy = vi.fn(async () => {});
    startup.createDb.mockReturnValue({ ready: Promise.resolve(), destroy });
    const origin = 'https://devstack.matrix-os.com';
    const issuer = 'https://clerk.matrix-os.com';
    const actor = 'user_fixture';
    const compose = vi.fn<StartPlatformServerOptions['createApp']>();
    compose.mockImplementation(deps => {
      expect(deps.devstackPreviewRoutes).toBeDefined();
      expect(deps.devstackPublicPreview).toBeDefined();
      expect(deps.devstackRunRoutes).toBeUndefined();
      throw marker;
    });
    const override = {
      MATRIX_APP_ORIGIN: origin,
      MATRIX_APP_DOMAIN_HOSTS: 'devstack.matrix-os.com',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
      CLERK_JWT_KEY: 'verify-only-fixture',
      CLERK_JWT_ISSUER: issuer,
      CLERK_AUTHORIZED_ORIGIN: origin,
      MATRIX_DEVSTACK_PREVIEW_CONFIG: JSON.stringify({
        issuer, previewOrigin: origin, publicBrowserOnly: true, membershipSource: 'private-preview-api',
        operators: [actor],
        targets: [{ runtime: 'hel1', worktree: 'candidate', owner: actor, handle: 'hel1-stage3', containerId: 'a'.repeat(64) }],
      }),
    };
    const secret = 'fixture'.repeat(6);
    await expect(startFixture(override, compose, secret)).rejects.toBe(marker);
    expect(compose).toHaveBeenCalledOnce();
    const stopped = new Error('startup rejected mismatched browser claim');
    vi.spyOn(process, 'exit').mockImplementation(() => { throw stopped; });
    await expect(startFixture({ ...override, CLERK_AUTHORIZED_ORIGIN: 'https://other.matrix-os.com' }, compose, secret)).rejects.toBe(stopped);
    expect(compose).toHaveBeenCalledOnce();
  });

  it('rejects an incompatible configuration before creating the Platform pool', async () => {
    const stopped = new Error('startup rejected');
    vi.spyOn(process, 'exit').mockImplementation(() => { throw stopped; });
    const compose = vi.fn();
    await expect(startFixture({ PLATFORM_BACKGROUND_WORKERS_ENABLED: 'true' }, () => {
      compose();
      throw new Error('invalid profile reached app composition');
    })).rejects.toBe(stopped);
    expect.soft(startup.createDb).not.toHaveBeenCalled();
    expect.soft(compose).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing organization', org: undefined, secretKey: 'sk_test_fixture' },
    { label: 'invalid organization', org: 'user_fixture', secretKey: 'sk_test_fixture' },
    { label: 'missing Clerk backend credential', org: 'org_Fixture', secretKey: undefined },
  ])('rejects DevStack runs with $label before opening the pool', async ({ org, secretKey }) => {
    const stopped = new Error('startup rejected');
    vi.spyOn(process, 'exit').mockImplementation(() => { throw stopped; });
    const poolAttempt = new Error('startup attempted to open a pool');
    startup.createDb.mockImplementation(() => { throw poolAttempt; });
    const compose = vi.fn();
    await expect(startFixture({
      MATRIX_DEVSTACK_RUN_CONFIG: JSON.stringify({
        issuer: 'https://clerk.example.test', previewOrigin: 'https://preview.example.test', operators: ['user_fixture'],
        targets: [{
          runtime: 'fixture', worktree: 'feature-a', owner: 'user_fixture', handle: 'fixture',
          containerId: 'a'.repeat(64), cwd: 'projects/feature-a', revision: 'b'.repeat(40),
        }],
      }),
      MATRIX_INTERNAL_CLERK_ORG_ID: org,
      CLERK_SECRET_KEY: secretKey,
      CLERK_JWT_KEY: 'fixture-jwt-key',
    }, compose, 'a'.repeat(32))).rejects.toBe(stopped);
    expect(startup.createDb).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('rejects an inherited ATS connection before opening either pool', async () => {
    const stopped = new Error('startup rejected');
    vi.spyOn(process, 'exit').mockImplementation(() => { throw stopped; });
    const poolAttempt = new Error('startup attempted to open a pool');
    startup.createDb.mockImplementation(() => { throw poolAttempt; });
    const compose = vi.fn();
    await expect(startFixture({ ATS_DATABASE_URL: 'postgres://fixture:fixture@recruiting.test/ats' }, compose))
      .rejects.toBe(stopped);
    expect(startup.createDb).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });
});
