import { describe, expect, it } from 'vitest';
import {
  GoldenSnapshotCompatibilitySchema,
  GoldenSnapshotRuntimeConfigSchema,
  GoldenSnapshotStateSchema,
  canTransitionGoldenSnapshot,
  compatibilityKey,
} from '../../packages/platform/src/golden-snapshot-schema.js';

describe('golden snapshot schema', () => {
  const compatibility = {
    provider: 'hetzner' as const,
    architecture: 'x86' as const,
    region: 'eu-central',
    baseImage: 'ubuntu-24.04',
    baseGeneration: 'ubuntu-24.04-v1',
    bootMode: 'bios' as const,
    activationAbi: 'host-v1',
    minimumDiskGb: 40,
  };

  it('normalizes a bounded compatibility class into a stable identity', () => {
    const parsed = GoldenSnapshotCompatibilitySchema.parse(compatibility);
    expect(compatibilityKey(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(compatibilityKey(parsed)).toBe(compatibilityKey({ ...parsed }));
  });

  it('rejects unbounded or unsafe compatibility values', () => {
    expect(GoldenSnapshotCompatibilitySchema.safeParse({ ...compatibility, region: '../nbg1' }).success).toBe(false);
    expect(GoldenSnapshotCompatibilitySchema.safeParse({ ...compatibility, minimumDiskGb: 0 }).success).toBe(false);
    expect(GoldenSnapshotCompatibilitySchema.safeParse({ ...compatibility, minimumDiskGb: 10_000 }).success).toBe(false);
    expect(GoldenSnapshotCompatibilitySchema.safeParse({ ...compatibility, provider: 'arbitrary' }).success).toBe(false);
  });

  it('allows only explicit fail-closed lifecycle transitions', () => {
    expect(GoldenSnapshotStateSchema.options).toEqual([
      'candidate',
      'building',
      'sanitizing',
      'validating',
      'ready',
      'failed',
      'quarantined',
      'retiring',
      'deleted',
    ]);
    expect(canTransitionGoldenSnapshot('candidate', 'building')).toBe(true);
    expect(canTransitionGoldenSnapshot('validating', 'ready')).toBe(true);
    expect(canTransitionGoldenSnapshot('ready', 'quarantined')).toBe(true);
    expect(canTransitionGoldenSnapshot('ready', 'deleted')).toBe(false);
    expect(canTransitionGoldenSnapshot('quarantined', 'ready')).toBe(false);
    expect(canTransitionGoldenSnapshot('failed', 'building')).toBe(false);
    expect(canTransitionGoldenSnapshot('deleted', 'candidate')).toBe(false);
  });

  it('bounds concurrent snapshot infrastructure', () => {
    const base = {
      enabled: false,
      buildsEnabled: false,
      rolloutPercent: 0,
      compatibility,
      maxBuildAttempts: 5,
      maxConcurrentBuilds: 2,
      buildLeaseMs: 60_000,
      provisioningLeaseMs: 60_000,
      retentionLimit: 20,
      freshnessMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
      testModeTtlMs: 24 * 60 * 60 * 1000,
      auditRetentionMs: 90 * 24 * 60 * 60 * 1000,
      reconciliationBatchSize: 25,
    };
    expect(GoldenSnapshotRuntimeConfigSchema.parse(base).maxConcurrentBuilds).toBe(2);
    expect(GoldenSnapshotRuntimeConfigSchema.safeParse({ ...base, maxConcurrentBuilds: 0 }).success).toBe(false);
    expect(GoldenSnapshotRuntimeConfigSchema.safeParse({ ...base, maxConcurrentBuilds: 11 }).success).toBe(false);
    expect(GoldenSnapshotRuntimeConfigSchema.safeParse({ ...base, retentionLimit: 0 }).success).toBe(false);
    expect(GoldenSnapshotRuntimeConfigSchema.safeParse({ ...base, freshnessMaxAgeMs: 0 }).success).toBe(false);
    expect(GoldenSnapshotRuntimeConfigSchema.safeParse({ ...base, testModeTtlMs: 0 }).success).toBe(false);
  });
});
