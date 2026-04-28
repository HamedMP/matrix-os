export interface CustomerVpsConfig {
  hetznerApiToken: string;
  location: string;
  serverType: string;
  image: string;
  sshKeyName?: string;
  imageVersion: string;
  hostBundleUrl: string;
  platformRegisterUrl: string;
  platformSecret: string;
  r2Bucket: string;
  r2PrefixRoot: string;
  provisionEtaSeconds: number;
  registrationTokenTtlMs: number;
  reconciliationBatchSize: number;
  reconciliationStaleAfterMs: number;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadCustomerVpsConfig(env: NodeJS.ProcessEnv = process.env): CustomerVpsConfig {
  const platformUrl = env.PLATFORM_PUBLIC_URL ?? `http://localhost:${env.PLATFORM_PORT ?? 9000}`;
  const imageVersion = env.CUSTOMER_VPS_IMAGE_VERSION ?? 'matrix-os-host-dev';
  const bundleBaseUrl = (env.MATRIX_HOST_BUNDLE_BASE_URL ?? platformUrl).replace(/\/$/, '');
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
    platformRegisterUrl: `${platformUrl.replace(/\/$/, '')}/vps/register`,
    platformSecret: env.PLATFORM_SECRET ?? '',
    r2Bucket: env.S3_BUCKET ?? env.R2_BUCKET ?? 'matrixos-sync',
    r2PrefixRoot: env.R2_PREFIX_ROOT ?? 'matrixos-sync',
    provisionEtaSeconds: numberFromEnv(env.CUSTOMER_VPS_PROVISION_ETA_SECONDS, 90),
    registrationTokenTtlMs: numberFromEnv(env.CUSTOMER_VPS_REGISTRATION_TOKEN_TTL_MS, 15 * 60 * 1000),
    reconciliationBatchSize: numberFromEnv(env.CUSTOMER_VPS_RECONCILIATION_BATCH_SIZE, 50),
    reconciliationStaleAfterMs: numberFromEnv(env.CUSTOMER_VPS_RECONCILIATION_STALE_AFTER_MS, 10 * 60 * 1000),
  };
}
