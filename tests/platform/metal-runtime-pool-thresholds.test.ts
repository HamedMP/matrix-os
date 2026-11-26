import { describe, expect, it, vi } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createTestConfig } from './customer-vps-service-test-helper.js';

const captured = vi.hoisted(() => ({ deps: [] as Array<Record<string, unknown>> }));
vi.mock('../../packages/platform/src/substrates/metal-provisioner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/platform/src/substrates/metal-provisioner.js')>();
  return {
    ...actual,
    createMetalProvisioner: (deps: Parameters<typeof actual.createMetalProvisioner>[0]) => {
      captured.deps.push(deps as unknown as Record<string, unknown>);
      return actual.createMetalProvisioner(deps);
    },
  };
});

const { createConfiguredMetalRuntime } = await import('../../packages/platform/src/substrates/metal-runtime.js');

/**
 * The thin-pool placement thresholds reach the provisioner from the platform
 * environment (METAL_POOL_MAX_*_PERCENT). Fault detected: a configured
 * threshold silently ignored, leaving placement on the defaults.
 */
describe('metal runtime thin-pool thresholds', () => {
  const db = { kysely: {} } as unknown as PlatformDB;
  const env = {
    METAL_HOSTS_ENABLED: '1',
    METAL_HOSTD_API_TOKEN: 'a'.repeat(40),
    METAL_HOSTD_INGRESS_TOKEN: 'b'.repeat(40),
    METAL_GOLDEN_VERSION: 'golden-2026.11.20-1',
  };

  it('passes configured thresholds to the provisioner and leaves defaults otherwise', async () => {
    const configured = createConfiguredMetalRuntime({
      db, env: { ...env, METAL_POOL_MAX_DATA_PERCENT: '70', METAL_POOL_MAX_METADATA_PERCENT: '60' },
      customerVps: { config: createTestConfig(), cloudInitTemplate: '#cloud-config\n' }, backgroundWorkersEnabled: false, log: () => {},
    });
    const defaults = createConfiguredMetalRuntime({
      db, env, customerVps: { config: createTestConfig(), cloudInitTemplate: '#cloud-config\n' }, backgroundWorkersEnabled: false, log: () => {},
    });

    expect(captured.deps[0]).toMatchObject({ poolMaxDataPercent: 70, poolMaxMetadataPercent: 60 });
    expect(captured.deps[1]).not.toHaveProperty('poolMaxDataPercent');
    expect(captured.deps[1]).not.toHaveProperty('poolMaxMetadataPercent');
    await configured?.shutdown();
    await defaults?.shutdown();
  });
});
