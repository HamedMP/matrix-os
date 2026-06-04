import { describe, expect, it } from 'vitest';
import {
  PlatformStartupConfigError,
  loadPlatformRuntimeConfig,
} from '../../packages/platform/src/runtime-mode.js';

describe('platform/runtime-mode', () => {
  it('defaults to compose-compatible legacy orchestration', () => {
    const config = loadPlatformRuntimeConfig({
      POSTGRES_URL: 'postgres://postgres:postgres@db:5432',
    });

    expect(config.mode).toBe('compose');
    expect(config.platformDatabaseUrl).toBe('postgres://postgres:postgres@db:5432/matrixos_platform');
    expect(config.dockerRequired).toBe(true);
    expect(config.legacyContainerOrchestrationEnabled).toBe(true);
  });

  it('allows Cloud Run mode without Docker when customer VPS mode and a managed database are configured', () => {
    const config = loadPlatformRuntimeConfig({
      PLATFORM_RUNTIME_MODE: 'cloud_run',
      CUSTOMER_VPS_ENABLED: 'true',
      PLATFORM_DATABASE_URL: 'postgres://matrixos_platform:secret@ep-green-field.eu-central-1.aws.neon.tech/matrixos_platform',
    });

    expect(config.mode).toBe('cloud_run');
    expect(config.dockerRequired).toBe(false);
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
