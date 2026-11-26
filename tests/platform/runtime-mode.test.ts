import { describe, expect, it } from 'vitest';
import {
  PlatformStartupConfigError,
  loadPlatformRuntimeConfig,
} from '../../packages/platform/src/runtime-mode.js';
import { candidateRuntimeEnvironment } from './preview-pair-candidate-env.js';

const slackDevOrigin = 'https://slack-dev-1a2b3c4d---matrix-platform-preview-example-ey.a.run.app';
const slackDevEnvironment = {
  PLATFORM_RUNTIME_MODE: 'cloud_run',
  PLATFORM_PREVIEW: 'true',
  K_SERVICE: 'matrix-platform-preview',
  CUSTOMER_VPS_ENABLED: 'false',
  AUTH_SHELL_ENABLED: 'false',
  SLACK_DEV_CALLBACK_ONLY: 'true',
  PLATFORM_PUBLIC_URL: slackDevOrigin,
  PLATFORM_DATABASE_URL: 'postgres://eng85_dev_slack_1a2b3c4d:fixture@preview-db.example/matrixos_eng85_dev_slack_1a2b3c4d?sslmode=verify-full',
};

describe('platform/runtime-mode', () => {
  it('starts a dedicated Slack callback before App enrollment without provisioning, storage or Docker', () => {
    const config = loadPlatformRuntimeConfig(slackDevEnvironment);
    expect(config).toMatchObject({
      mode: 'cloud_run',
      customerVpsEnabled: false,
      legacyContainerOrchestrationEnabled: false,
      slackDevCallbackOrigin: slackDevOrigin,
    });
  });

  it.each([
    { SLACK_DEV_CALLBACK_ONLY: 'yes' },
    { PLATFORM_RUNTIME_MODE: 'local' },
    { PLATFORM_PREVIEW: 'false' },
    { K_SERVICE: 'matrix-platform' },
    { CUSTOMER_VPS_ENABLED: 'true' },
    { AUTH_SHELL_ENABLED: 'true' },
    { PLATFORM_BACKGROUND_WORKERS_ENABLED: 'true' },
    { PLATFORM_PUBLIC_URL: 'https://matrix-platform-preview-example-ey.a.run.app' },
    { PLATFORM_PUBLIC_URL: slackDevOrigin + '/extra' },
    { SLACK_PUBLIC_BASE_URL: 'https://slack-dev-ffffffff---matrix-platform-preview-example-ey.a.run.app' },
    { SLACK_PREVIEW_RUNTIME_HANDLE: 'pr-3482' },
    { PLATFORM_DATABASE_URL: 'postgres://prod:fixture@prod-db.example/matrixos_platform?sslmode=verify-full' },
    { PLATFORM_DATABASE_URL: slackDevEnvironment.PLATFORM_DATABASE_URL.replace('verify-full', 'require') },
    { PLATFORM_DATABASE_URL: slackDevEnvironment.PLATFORM_DATABASE_URL.replaceAll('1a2b3c4d', 'ffffffff') },
    { PLATFORM_DATABASE_URL: slackDevEnvironment.PLATFORM_DATABASE_URL.replace('preview-db.example', 'localhost') },
    { PLATFORM_DATABASE_URL: slackDevEnvironment.PLATFORM_DATABASE_URL + '&host=prod-db.example&user=prod' },
    { PLATFORM_DATABASE_URL: slackDevEnvironment.PLATFORM_DATABASE_URL + '&sslrootcert=/production-ca.pem' },
    { PLATFORM_DATABASE_URL: slackDevEnvironment.PLATFORM_DATABASE_URL + '&sslmode=no-verify' },
    { R2_BUNDLES_ACCESS_KEY_ID: 'shared-bundles' },
    { STRIPE_SECRET_KEY: 'test-provider-key' },
    { HETZNER_API_TOKEN: 'test-provider-key' },
  ])('rejects a Dev callback with unrelated authority or ambiguous routing (%o)', overrides => {
    expect(() => loadPlatformRuntimeConfig({ ...slackDevEnvironment, ...overrides }))
      .toThrow(PlatformStartupConfigError);
  });

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
