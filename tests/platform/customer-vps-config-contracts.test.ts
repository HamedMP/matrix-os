import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { ProvisionRequestSchema } from '../../packages/platform/src/customer-vps-schema.js';
import { isPreviewMachine } from '../../packages/platform/src/customer-vps-preview.js';
import { validateDbLatestPointer } from '../../packages/platform/src/customer-vps-r2.js';

describe('platform/customer-vps', () => {
  it('defaults new customer VPS provisioning to the stable host bundle channel', () => {
    const config = loadCustomerVpsConfig({
      PLATFORM_PUBLIC_URL: 'https://app.matrix-os.com',
    });

    expect(config.imageVersion).toBe('stable');
    expect(config.hostBundleUrl).toBe('https://app.matrix-os.com/system-bundles/stable/matrix-host-bundle.tar.gz');
  });
  it('does not use the private PostHog ingest host as the public browser host', () => {
    const config = loadCustomerVpsConfig({
      POSTHOG_HOST: 'https://eu.i.posthog.com',
      NEXT_PUBLIC_POSTHOG_API_HOST: '/relay',
    });

    expect(config.posthogHost).toBe('https://eu.i.posthog.com');
    expect(config.posthogPublicHost).toBe('https://eu.posthog.com');
  });
  it('keeps the preview provisioning limit bounded for missing or invalid configuration', () => {
    expect(loadCustomerVpsConfig({}).previewProvisioningLimit).toBe(8);
    expect(loadCustomerVpsConfig({ CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT: '4' }).previewProvisioningLimit).toBe(4);
    expect(loadCustomerVpsConfig({ CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT: '0' }).previewProvisioningLimit).toBe(8);
    expect(loadCustomerVpsConfig({ CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT: '17' }).previewProvisioningLimit).toBe(8);
    expect(loadCustomerVpsConfig({ CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT: '2.5' }).previewProvisioningLimit).toBe(8);
  });
  it('keeps golden snapshots disabled by default and bounds every control-plane budget', () => {
    expect(loadCustomerVpsConfig({}).goldenSnapshots).toMatchObject({
      enabled: false,
      buildsEnabled: false,
      rolloutPercent: 0,
      serverType: 'cx23',
      maxBuildAttempts: 5,
      maxConcurrentBuilds: 2,
      callbackDeadlineMs: 60 * 60 * 1000,
      retentionLimit: 20,
      freshnessMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
      testModeTtlMs: 24 * 60 * 60 * 1000,
      auditRetentionMs: 90 * 24 * 60 * 60 * 1000,
    });

    expect(loadCustomerVpsConfig({
      GOLDEN_SNAPSHOTS_ENABLED: 'true',
      GOLDEN_SNAPSHOT_BUILDS_ENABLED: 'true',
      GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '25',
      GOLDEN_SNAPSHOT_MAX_BUILD_ATTEMPTS: '3',
      GOLDEN_SNAPSHOT_MAX_CONCURRENT_BUILDS: '4',
      GOLDEN_SNAPSHOT_CALLBACK_DEADLINE_MS: '2700000',
      GOLDEN_SNAPSHOT_RETENTION_LIMIT: '12',
      GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS: '120000',
      GOLDEN_SNAPSHOT_TEST_MODE_TTL_MS: '180000',
      GOLDEN_SNAPSHOT_AUDIT_RETENTION_MS: '86400000',
      GOLDEN_SNAPSHOT_ARCHITECTURE: 'x86',
      GOLDEN_SNAPSHOT_REGION: 'eu-central',
    }).goldenSnapshots).toMatchObject({
      enabled: true,
      buildsEnabled: true,
      rolloutPercent: 25,
      maxBuildAttempts: 3,
      maxConcurrentBuilds: 4,
      callbackDeadlineMs: 45 * 60 * 1000,
      retentionLimit: 12,
      freshnessMaxAgeMs: 120000,
      testModeTtlMs: 180000,
      auditRetentionMs: 86400000,
      compatibility: expect.objectContaining({ architecture: 'x86', region: 'eu-central' }),
    });

    expect(() => loadCustomerVpsConfig({
      GOLDEN_SNAPSHOT_ARCHITECTURE: 'arm',
    })).toThrow(/x86/);
    expect(loadCustomerVpsConfig({
      GOLDEN_SNAPSHOT_SERVER_TYPE: 'cpx11',
    }).goldenSnapshots.serverType).toBe('cpx11');
    expect(() => loadCustomerVpsConfig({
      GOLDEN_SNAPSHOT_SERVER_TYPE: 'INVALID!',
    })).toThrow();

    expect(loadCustomerVpsConfig({
      GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: '101',
      GOLDEN_SNAPSHOT_MAX_BUILD_ATTEMPTS: '0',
      GOLDEN_SNAPSHOT_MAX_CONCURRENT_BUILDS: '11',
      GOLDEN_SNAPSHOT_CALLBACK_DEADLINE_MS: '3600001',
      GOLDEN_SNAPSHOT_RETENTION_LIMIT: '31',
      GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS: '999',
      GOLDEN_SNAPSHOT_TEST_MODE_TTL_MS: '999',
      GOLDEN_SNAPSHOT_AUDIT_RETENTION_MS: '999',
      GOLDEN_SNAPSHOT_BUILD_LEASE_MS: '999',
    }).goldenSnapshots).toMatchObject({
      rolloutPercent: 0,
      maxBuildAttempts: 5,
      maxConcurrentBuilds: 2,
      callbackDeadlineMs: 60 * 60 * 1000,
      retentionLimit: 20,
      freshnessMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
      testModeTtlMs: 24 * 60 * 60 * 1000,
      auditRetentionMs: 90 * 24 * 60 * 60 * 1000,
      buildLeaseMs: 5 * 60 * 1000,
    });

    expect(loadCustomerVpsConfig({
      GOLDEN_SNAPSHOT_BASE_IMAGE: '',
      HETZNER_IMAGE: 'ubuntu-24.04',
    }).goldenSnapshots.compatibility.baseImage).toBe('ubuntu-24.04');
  });
  it('classifies only server-marked dedicated and legacy preview runtime slots as previews', () => {
    expect(isPreviewMachine({ handle: 'pr-897', runtimeSlot: 'pr-897', provisioningClass: 'preview' })).toBe(true);
    expect(isPreviewMachine({ handle: 'pr-703', runtimeSlot: 'preview', provisioningClass: 'preview' })).toBe(true);
    expect(isPreviewMachine({ handle: 'pr-897', runtimeSlot: 'pr-897', provisioningClass: 'customer' })).toBe(false);
    expect(isPreviewMachine({ handle: 'pr-897', runtimeSlot: 'primary', provisioningClass: 'preview' })).toBe(false);
    expect(isPreviewMachine({ handle: 'alice', runtimeSlot: 'pr-897', provisioningClass: 'preview' })).toBe(false);
  });
  it('accepts only supported Hetzner locations at the provisioning boundary', () => {
    for (const location of ['fsn1', 'nbg1', 'ash', 'hil']) {
      expect(ProvisionRequestSchema.safeParse({
        clerkUserId: 'user_123',
        handle: 'alice',
        location,
      }).success).toBe(true);
    }
    expect(ProvisionRequestSchema.safeParse({
      clerkUserId: 'user_123',
      handle: 'alice',
      location: 'untrusted-region',
    }).success).toBe(false);
  });
  it('validates R2 latest pointers without accepting paths or URLs', () => {
    expect(validateDbLatestPointer('system/db/snapshots/2026-04-26T1800Z.dump')).toBe(true);
    expect(validateDbLatestPointer('system/runtime-slots/staging/db/snapshots/2026-04-26T1800Z.dump')).toBe(true);
    expect(validateDbLatestPointer('../system/db/snapshots/2026-04-26T1800Z.dump')).toBe(false);
    expect(validateDbLatestPointer('https://example.com/snapshot.dump')).toBe(false);
    expect(validateDbLatestPointer('system/db/snapshots/not-a-date.dump')).toBe(false);
    expect(validateDbLatestPointer('system/runtime-slots/staging-/db/snapshots/2026-04-26T1800Z.dump')).toBe(false);
  });
  it('documents first-customer rollout checks and recovery expectations', () => {
    const quickstart = readFileSync('specs/070-vps-per-user/quickstart.md', 'utf8');

    expect(quickstart).toContain('First-Customer Rollout Checklist');
    expect(quickstart).toContain('Quota ceiling');
    expect(quickstart).toContain('Backup observation');
    expect(quickstart).toContain('Rollback');
    expect(quickstart).toContain('Non-production smoke commands');
  });

});
