import {
  DEFAULT_GOLDEN_SNAPSHOT_CALLBACK_DEADLINE_MS,
  DEFAULT_GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS,
  GoldenSnapshotBuildArchitectureSchema,
  GoldenSnapshotRuntimeConfigSchema,
  type GoldenSnapshotRuntimeConfig,
} from './golden-snapshot-schema.js';

export interface CustomerVpsConfig {
  hetznerApiToken: string;
  location: string;
  serverType: string;
  image: string;
  sshKeyName?: string;
  imageVersion: string;
  hostBundleUrl: string;
  hostBundleUrlOverride?: boolean;
  platformRegisterUrl: string;
  platformSecret: string;
  r2PrefixRoot: string;
  posthogToken: string;
  posthogProjectToken: string;
  posthogHost: string;
  posthogPublicHost: string;
  posthogApiHost: string;
  fundedAiEnabled: boolean;
  fundedAiRelayUrl: string;
  provisionEtaSeconds: number;
  registrationTokenTtlMs: number;
  reconciliationBatchSize: number;
  reconciliationStaleAfterMs: number;
  maxProvisionAttempts: number;
  previewProvisioningLimit: number;
  goldenSnapshots: GoldenSnapshotRuntimeConfig;
}

const DEFAULT_POSTHOG_PUBLIC_HOST = 'https://eu.posthog.com';
const DEFAULT_PREVIEW_PROVISIONING_LIMIT = 8;
const MAX_PREVIEW_PROVISIONING_LIMIT = 16;

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedIntegerFromEnv(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function enabledFromEnv(value: string | undefined): boolean {
  return value === 'true';
}

function fundedAiRuntimeFromEnv(env: NodeJS.ProcessEnv): {
  fundedAiEnabled: boolean;
  fundedAiRelayUrl: string;
} {
  if (!enabledFromEnv(env.MATRIX_FUNDED_AI_RUNTIME_ENABLED)) {
    return { fundedAiEnabled: false, fundedAiRelayUrl: '' };
  }
  const raw = env.MATRIX_FUNDED_AI_RELAY_URL ?? '';
  if (!raw || raw.length > 2_048 || !/^[A-Za-z0-9:/._~%\[\]-]+$/.test(raw)) {
    throw new Error('Funded AI runtime is misconfigured');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error('Funded AI runtime is misconfigured');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Funded AI runtime is misconfigured');
  }
  return {
    fundedAiEnabled: true,
    fundedAiRelayUrl: url.toString().replace(/\/$/, ''),
  };
}

export function loadCustomerVpsConfig(env: NodeJS.ProcessEnv = process.env): CustomerVpsConfig {
  const platformUrl = env.PLATFORM_PUBLIC_URL ?? `http://localhost:${env.PLATFORM_PORT ?? 9000}`;
  const imageVersion = env.CUSTOMER_VPS_IMAGE_VERSION ?? 'stable';
  const bundleBaseUrl = (env.MATRIX_HOST_BUNDLE_BASE_URL ?? platformUrl).replace(/\/$/, '');
  const snapshotArchitecture = GoldenSnapshotBuildArchitectureSchema.parse(
    env.GOLDEN_SNAPSHOT_ARCHITECTURE ?? 'x86',
  );
  const fundedAiRuntime = fundedAiRuntimeFromEnv(env);
  return {
    hetznerApiToken: env.HETZNER_API_TOKEN ?? '',
    location: env.HETZNER_LOCATION ?? 'nbg1',
    serverType: env.HETZNER_SERVER_TYPE ?? 'cpx22',
    image: env.HETZNER_IMAGE ?? 'ubuntu-24.04',
    sshKeyName: env.HETZNER_SSH_KEY_NAME || undefined,
    imageVersion,
    hostBundleUrl:
      env.MATRIX_HOST_BUNDLE_URL ??
      `${bundleBaseUrl}/system-bundles/${encodeURIComponent(imageVersion)}/matrix-host-bundle.tar.gz`,
    hostBundleUrlOverride: Boolean(env.MATRIX_HOST_BUNDLE_URL),
    platformRegisterUrl: `${platformUrl.replace(/\/$/, '')}/vps/register`,
    platformSecret: env.PLATFORM_SECRET ?? '',
    r2PrefixRoot: env.R2_PREFIX_ROOT ?? 'matrixos-sync',
    posthogToken: env.POSTHOG_TOKEN ?? env.NEXT_PUBLIC_POSTHOG_KEY ?? '',
    posthogProjectToken:
      env.POSTHOG_PROJECT_TOKEN ??
      env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ??
      env.POSTHOG_TOKEN ??
      env.NEXT_PUBLIC_POSTHOG_KEY ??
      '',
    posthogHost: env.POSTHOG_HOST ?? env.NEXT_PUBLIC_POSTHOG_HOST ?? '',
    posthogPublicHost: env.NEXT_PUBLIC_POSTHOG_HOST ?? DEFAULT_POSTHOG_PUBLIC_HOST,
    posthogApiHost: env.NEXT_PUBLIC_POSTHOG_API_HOST ?? '',
    ...fundedAiRuntime,
    provisionEtaSeconds: numberFromEnv(env.CUSTOMER_VPS_PROVISION_ETA_SECONDS, 90),
    // Clean-image bootstrap allows 15 minutes for the host bundle download
    // and 30 minutes for prerequisite preparation before Gateway can register.
    // Keep a bounded buffer for the remaining host setup and reconciliation.
    registrationTokenTtlMs: 60 * 60 * 1000,
    reconciliationBatchSize: numberFromEnv(env.CUSTOMER_VPS_RECONCILIATION_BATCH_SIZE, 50),
    reconciliationStaleAfterMs: numberFromEnv(env.CUSTOMER_VPS_RECONCILIATION_STALE_AFTER_MS, 10 * 60 * 1000),
    maxProvisionAttempts: numberFromEnv(env.CUSTOMER_VPS_MAX_PROVISION_ATTEMPTS, 3),
    previewProvisioningLimit: boundedIntegerFromEnv(
      env.CUSTOMER_VPS_PREVIEW_PROVISIONING_LIMIT,
      DEFAULT_PREVIEW_PROVISIONING_LIMIT,
      MAX_PREVIEW_PROVISIONING_LIMIT,
    ),
    goldenSnapshots: GoldenSnapshotRuntimeConfigSchema.parse({
      enabled: enabledFromEnv(env.GOLDEN_SNAPSHOTS_ENABLED),
      buildsEnabled: enabledFromEnv(env.GOLDEN_SNAPSHOT_BUILDS_ENABLED),
      rolloutPercent: boundedInteger(env.GOLDEN_SNAPSHOT_ROLLOUT_PERCENT, 0, 0, 100),
      serverType: env.GOLDEN_SNAPSHOT_SERVER_TYPE ?? 'cx23',
      compatibility: {
        provider: 'hetzner',
        architecture: snapshotArchitecture,
        region: env.GOLDEN_SNAPSHOT_REGION ?? 'eu-central',
        baseImage: env.GOLDEN_SNAPSHOT_BASE_IMAGE || env.HETZNER_IMAGE || 'ubuntu-24.04',
        baseGeneration: env.GOLDEN_SNAPSHOT_BASE_GENERATION ?? 'ubuntu-24.04-v1',
        bootMode: env.GOLDEN_SNAPSHOT_BOOT_MODE ?? 'bios',
        activationAbi: env.GOLDEN_SNAPSHOT_ACTIVATION_ABI ?? 'host-v1',
        minimumDiskGb: boundedInteger(env.GOLDEN_SNAPSHOT_MINIMUM_DISK_GB, 40, 1, 2_048),
      },
      maxBuildAttempts: boundedInteger(env.GOLDEN_SNAPSHOT_MAX_BUILD_ATTEMPTS, 5, 1, 10),
      maxConcurrentBuilds: boundedInteger(env.GOLDEN_SNAPSHOT_MAX_CONCURRENT_BUILDS, 2, 1, 10),
      buildLeaseMs: boundedInteger(env.GOLDEN_SNAPSHOT_BUILD_LEASE_MS, 5 * 60 * 1000, 60_000, 30 * 60 * 1000),
      provisioningLeaseMs: boundedInteger(
        env.GOLDEN_SNAPSHOT_PROVISIONING_LEASE_MS,
        10 * 60 * 1000,
        60_000,
        30 * 60 * 1000,
      ),
      callbackDeadlineMs: boundedInteger(
        env.GOLDEN_SNAPSHOT_CALLBACK_DEADLINE_MS,
        DEFAULT_GOLDEN_SNAPSHOT_CALLBACK_DEADLINE_MS,
        60_000,
        60 * 60 * 1000,
      ),
      retentionLimit: boundedInteger(env.GOLDEN_SNAPSHOT_RETENTION_LIMIT, 20, 1, 29),
      freshnessMaxAgeMs: boundedInteger(
        env.GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS,
        DEFAULT_GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS,
        60_000,
        365 * 24 * 60 * 60 * 1000,
      ),
      testModeTtlMs: boundedInteger(
        env.GOLDEN_SNAPSHOT_TEST_MODE_TTL_MS,
        24 * 60 * 60 * 1000,
        60_000,
        30 * 24 * 60 * 60 * 1000,
      ),
      auditRetentionMs: boundedInteger(
        env.GOLDEN_SNAPSHOT_AUDIT_RETENTION_MS,
        90 * 24 * 60 * 60 * 1000,
        24 * 60 * 60 * 1000,
        365 * 24 * 60 * 60 * 1000,
      ),
      reconciliationBatchSize: boundedInteger(env.GOLDEN_SNAPSHOT_RECONCILIATION_BATCH_SIZE, 25, 1, 100),
    }),
  };
}
