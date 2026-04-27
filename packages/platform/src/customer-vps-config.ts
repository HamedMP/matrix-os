export interface CustomerVpsConfig {
  hetznerApiToken: string;
  location: string;
  serverType: string;
  image: string;
  sshKeyName?: string;
  imageVersion: string;
  platformRegisterUrl: string;
  r2Bucket: string;
  r2PrefixRoot: string;
  provisionEtaSeconds: number;
  registrationTokenTtlMs: number;
  reconciliationBatchSize: number;
  reconciliationStaleAfterMs: number;
}

export function loadCustomerVpsConfig(env: NodeJS.ProcessEnv = process.env): CustomerVpsConfig {
  const platformUrl = env.PLATFORM_PUBLIC_URL ?? `http://localhost:${env.PLATFORM_PORT ?? 9000}`;
  return {
    hetznerApiToken: env.HETZNER_API_TOKEN ?? '',
    location: env.HETZNER_LOCATION ?? 'nbg1',
    serverType: env.HETZNER_SERVER_TYPE ?? 'cpx21',
    image: env.HETZNER_IMAGE ?? 'ubuntu-24.04',
    sshKeyName: env.HETZNER_SSH_KEY_NAME || undefined,
    imageVersion: env.CUSTOMER_VPS_IMAGE_VERSION ?? 'matrix-os-host-dev',
    platformRegisterUrl: `${platformUrl.replace(/\/$/, '')}/vps/register`,
    r2Bucket: env.S3_BUCKET ?? env.R2_BUCKET ?? 'matrixos-sync',
    r2PrefixRoot: env.R2_PREFIX_ROOT ?? 'matrixos-sync',
    provisionEtaSeconds: Number(env.CUSTOMER_VPS_PROVISION_ETA_SECONDS ?? 90),
    registrationTokenTtlMs: Number(env.CUSTOMER_VPS_REGISTRATION_TOKEN_TTL_MS ?? 15 * 60 * 1000),
    reconciliationBatchSize: Number(env.CUSTOMER_VPS_RECONCILIATION_BATCH_SIZE ?? 50),
    reconciliationStaleAfterMs: Number(env.CUSTOMER_VPS_RECONCILIATION_STALE_AFTER_MS ?? 10 * 60 * 1000),
  };
}
