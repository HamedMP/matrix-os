import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  PlatformStartupConfigError,
  loadPlatformRuntimeConfig,
} from '../../packages/platform/src/runtime-mode.js';
import { candidateRuntimeEnvironment } from './preview-pair-candidate-env.js';

describe('platform/runtime-mode', () => {
  it('boots a validated runtime-only candidate without enabling paid provisioning or Docker', () => {
    const config = loadPlatformRuntimeConfig({ ...candidateRuntimeEnvironment(), PLATFORM_RUNTIME_MODE: 'cloud_run',
      PLATFORM_DATABASE_URL: 'postgres://fixture:fixture@preview-db.example/fixture' });
    expect(config.customerVpsEnabled).toBe(false);
    expect(config.legacyContainerOrchestrationEnabled).toBe(false);
  });

  it('validates the candidate before ordinary customer startup can construct provider dependencies', () => {
    expect(() => loadPlatformRuntimeConfig({ ...candidateRuntimeEnvironment(), CUSTOMER_VPS_ENABLED: 'true',
      PLATFORM_RUNTIME_MODE: 'cloud_run', PLATFORM_DATABASE_URL: 'postgres://fixture:fixture@preview-db.example/fixture' }))
      .toThrow('Preview pairs are unavailable');
  });
  it('defaults to compose-compatible legacy orchestration', () => {
    const config = loadPlatformRuntimeConfig({
      POSTGRES_URL: 'postgres://postgres:postgres@db:5432',
    });

    expect(config.mode).toBe('compose');
    expect(config.platformDatabaseUrl).toBe('postgres://postgres:postgres@db:5432/matrixos_platform');
    expect(config.legacyContainerOrchestrationEnabled).toBe(true);
  });

  it('allows Cloud Run mode without Docker when customer VPS mode and a managed database are configured', () => {
    const config = loadPlatformRuntimeConfig({
      PLATFORM_RUNTIME_MODE: 'cloud_run',
      CUSTOMER_VPS_ENABLED: 'true',
      PLATFORM_DATABASE_URL: 'postgres://matrixos_platform:secret@ep-green-field.eu-central-1.aws.neon.tech/matrixos_platform',
    });

    expect(config.mode).toBe('cloud_run');
    expect(config.legacyContainerOrchestrationEnabled).toBe(false);
    expect(config.platformDatabaseUrl).toContain('neon.tech/matrixos_platform');
  });

  it('rejects Cloud Run mode when customer VPS provisioning is disabled', () => {
    expect(() => loadPlatformRuntimeConfig({
      PLATFORM_RUNTIME_MODE: 'cloud_run',
      CUSTOMER_VPS_ENABLED: 'false',
      PLATFORM_DATABASE_URL: 'postgres://matrixos_platform:secret@ep-green-field.eu-central-1.aws.neon.tech/matrixos_platform',
    })).toThrow(new PlatformStartupConfigError('CUSTOMER_VPS_ENABLED=true is required when PLATFORM_RUNTIME_MODE=cloud_run'));
  });

  it('rejects Cloud Run mode without an explicit platform database URL', () => {
    expect(() => loadPlatformRuntimeConfig({
      PLATFORM_RUNTIME_MODE: 'cloud_run',
      CUSTOMER_VPS_ENABLED: 'true',
      POSTGRES_URL: 'postgres://postgres:postgres@db:5432',
    })).toThrow(new PlatformStartupConfigError('PLATFORM_DATABASE_URL is required when PLATFORM_RUNTIME_MODE=cloud_run'));
  });

  it('rejects localhost platform database URLs in Cloud Run mode', () => {
    expect(() => loadPlatformRuntimeConfig({
      PLATFORM_RUNTIME_MODE: 'cloud_run',
      CUSTOMER_VPS_ENABLED: 'true',
      PLATFORM_DATABASE_URL: 'postgres://matrixos_platform:secret@localhost:5432/matrixos_platform',
    })).toThrow(new PlatformStartupConfigError('PLATFORM_DATABASE_URL must point at a managed Postgres host when PLATFORM_RUNTIME_MODE=cloud_run'));
  });

  it('rejects unknown runtime mode values', () => {
    expect(() => loadPlatformRuntimeConfig({
      PLATFORM_RUNTIME_MODE: 'kubernetes',
      PLATFORM_DATABASE_URL: 'postgres://postgres:postgres@db:5432/matrixos_platform',
    })).toThrow(new PlatformStartupConfigError('PLATFORM_RUNTIME_MODE must be one of: cloud_run, compose, local'));
  });
});

const registeredRuntimeEnv = {
  MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY: 'true',
  MATRIX_DEVSTACK_INSTANCE: 'demo-a',
  MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'true',
  PLATFORM_RUNTIME_MODE: 'local',
  PLATFORM_BACKGROUND_WORKERS_ENABLED: 'false',
  PLATFORM_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1/matrixos_devstack_demo_a',
};

describe('registered DevStack runtime startup admission', () => {
  it.each([
    [registeredRuntimeEnv.PLATFORM_DATABASE_URL, '127.0.0.1'],
    ['postgresql://fixture:fixture@[::1]/matrixos_devstack_demo_a', '::1'],
    [`${registeredRuntimeEnv.PLATFORM_DATABASE_URL}?host=%2Frun%2Fmatrix-devstack%2Fdemo-a%2Fpg-proxy`, '/run/matrix-devstack/demo-a/pg-proxy'],
  ])('admits an instance-owned database without Docker or a VPS provisioner', (databaseUrl, host) => {
    const config = loadPlatformRuntimeConfig({ ...registeredRuntimeEnv, PLATFORM_DATABASE_URL: databaseUrl });
    expect(config).toMatchObject({
      mode: 'local', customerVpsEnabled: false,
      legacyContainerOrchestrationEnabled: false, registeredRuntimeInstance: 'demo-a',
    });
    // Construct the real driver without connecting so the test observes its target parsing.
    const client = new Client({ connectionString: config.platformDatabaseUrl });
    expect({ host: client.host, database: client.database }).toEqual({ host, database: 'matrixos_devstack_demo_a' });
  });

  it.each([
    { MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY: '' },
    { MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY: 'True' },
    { MATRIX_DEVSTACK_INSTANCE: '../demo-a' },
    { PLATFORM_RUNTIME_MODE: 'compose' },
    { PLATFORM_RUNTIME_MODE: 'cloud_run' },
    { PLATFORM_BACKGROUND_WORKERS_ENABLED: undefined },
    { PLATFORM_BACKGROUND_WORKERS_ENABLED: 'true' },
    { MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'false' },
    { PLATFORM_DATABASE_URL: undefined, POSTGRES_URL: 'postgres://fixture:secret-marker@127.0.0.1' },
    { CUSTOMER_VPS_ENABLED: 'true' },
    { ...candidateRuntimeEnvironment() },
    { MATRIX_PREVIEW_PAIR_ENABLED: 'true' },
    { MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED: 'true' },
    { PLATFORM_DATABASE_URL: 'postgres://fixture:secret-marker@remote.test/matrixos_devstack_demo_a' },
    { PLATFORM_DATABASE_URL: 'postgres://fixture:secret-marker@127.0.0.1/matrixos_devstack_demo_b' },
    { PLATFORM_DATABASE_URL: 'postgres://fixture:secret-marker value@127.0.0.1/matrixos_devstack_demo_a?%68%6F%73%74=%2Frun%2Fmatrix-devstack%2Fdemo-a%2Fpg-proxy' },
    { PLATFORM_DATABASE_URL: 'postgres://fixture:secret-marker%zz@127.0.0.1/matrixos_devstack_demo_a?host=%2Frun%2Fmatrix-devstack%2Fdemo-a%2Fpg-proxy' },
    ...[
      'host=/run/matrix-devstack/demo-b/pg-proxy',
      'host=/run/matrix-devstack/demo-a/other/../pg-proxy',
      'host=/run/matrix-devstack/demo-a/pg-proxy&host=/run/matrix-devstack/demo-a/pg-proxy',
      'host=/run/matrix-devstack/demo-a/pg-proxy&sslmode=disable',
      'options=-c%20search_path=other',
    ].map(query => ({ PLATFORM_DATABASE_URL: `${registeredRuntimeEnv.PLATFORM_DATABASE_URL}?${query}` })),
  ])('rejects incompatible settings or out-of-instance connection options (%#)', override => {
    expect(() => loadPlatformRuntimeConfig({ ...registeredRuntimeEnv, ...override })).toThrow(/DevStack|Preview pairs/);
    try {
      loadPlatformRuntimeConfig({ ...registeredRuntimeEnv, ...override });
    } catch (error: unknown) {
      expect(String(error)).not.toContain('secret-marker');
    }
  });

  it('keeps ordinary local orchestration with explicit false', () => {
    expect(loadPlatformRuntimeConfig({
      ...registeredRuntimeEnv,
      MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY: 'false',
      PLATFORM_DATABASE_URL: 'postgres://fixture:fixture@db/shared',
    }).legacyContainerOrchestrationEnabled).toBe(true);
  });
});
