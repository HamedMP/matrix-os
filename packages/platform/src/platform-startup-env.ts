const DEV_PLATFORM_SECRET = 'dev-secret';
const DEV_PLATFORM_JWT_SECRET = 'dev-platform-jwt-secret-please-change-32';
const DEFAULT_SYNC_BUCKET = 'matrixos-sync';

const TENANT_PUBLIC_TELEMETRY_ENV_KEYS = [
  'POSTHOG_TOKEN',
  'POSTHOG_PROJECT_TOKEN',
  'POSTHOG_HOST',
  'NEXT_PUBLIC_POSTHOG_KEY',
  'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN',
  'NEXT_PUBLIC_POSTHOG_HOST',
  'NEXT_PUBLIC_POSTHOG_API_HOST',
] as const;

export function collectTenantPublicTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return TENANT_PUBLIC_TELEMETRY_ENV_KEYS
    .map((key) => {
      const value = env[key];
      if (!value) return null;
      if (/[\r\n\0]/.test(value)) {
        throw new Error(`Invalid public telemetry env value for ${key}`);
      }
      return `${key}=${value}`;
    })
    .filter((value): value is string => value !== null);
}

export function checkUnsafeDefaultSecrets(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.error,
): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  if (!env.PLATFORM_SECRET || env.PLATFORM_SECRET === DEV_PLATFORM_SECRET) {
    problems.push('PLATFORM_SECRET');
  }

  if (
    !env.PLATFORM_JWT_SECRET ||
    env.PLATFORM_JWT_SECRET === DEV_PLATFORM_JWT_SECRET
  ) {
    problems.push('PLATFORM_JWT_SECRET');
  }

  if (problems.length > 0) {
    log(
      `[platform] Refusing to start in production with missing or unsafe default secrets: ${problems.join(', ')}.`,
    );
  }

  return problems;
}

export function checkHostBundleStorageEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.warn,
): string[] {
  if (env.CUSTOMER_VPS_ENABLED !== 'true') return [];
  const problems: string[] = [];
  if (!(env.S3_BUNDLES_ENDPOINT || env.R2_BUNDLES_ENDPOINT || env.S3_BUNDLES_ACCOUNT_ID || env.R2_BUNDLES_ACCOUNT_ID)) {
    problems.push('S3_BUNDLES_ENDPOINT/R2_BUNDLES_ENDPOINT or S3_BUNDLES_ACCOUNT_ID/R2_BUNDLES_ACCOUNT_ID');
  }
  if (!(env.S3_BUNDLES_ACCESS_KEY_ID || env.R2_BUNDLES_ACCESS_KEY_ID)) {
    problems.push('S3_BUNDLES_ACCESS_KEY_ID/R2_BUNDLES_ACCESS_KEY_ID');
  }
  if (!(env.S3_BUNDLES_SECRET_ACCESS_KEY || env.R2_BUNDLES_SECRET_ACCESS_KEY)) {
    problems.push('S3_BUNDLES_SECRET_ACCESS_KEY/R2_BUNDLES_SECRET_ACCESS_KEY');
  }
  const bundleBucket = env.S3_BUNDLES_BUCKET ?? env.R2_BUNDLES_BUCKET;
  if (!bundleBucket) {
    problems.push('S3_BUNDLES_BUCKET/R2_BUNDLES_BUCKET');
  } else {
    const syncBucket = env.S3_BUCKET ?? env.R2_BUCKET ?? DEFAULT_SYNC_BUCKET;
    if (bundleBucket === syncBucket) {
      problems.push('S3_BUNDLES_BUCKET/R2_BUNDLES_BUCKET must not equal S3_BUCKET/R2_BUCKET');
    }
  }
  if (problems.length > 0) {
    log(
      `[platform] CUSTOMER_VPS_ENABLED=true but dedicated host bundle storage is incomplete; refusing to fall back to the sync bucket for signed host bundle URLs. Problems: ${problems.join(', ')}.`,
    );
  }
  return problems;
}

export function checkHomeMirrorS3Env(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.warn,
): string[] {
  if (env.MATRIX_HOME_MIRROR !== 'true') return [];
  const missing: string[] = [];
  if (!(env.S3_ENDPOINT || env.R2_ENDPOINT || env.R2_ACCOUNT_ID)) {
    missing.push('S3_ENDPOINT/R2_ENDPOINT or R2_ACCOUNT_ID');
  }
  if (!(env.S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID)) {
    missing.push('S3_ACCESS_KEY_ID/R2_ACCESS_KEY_ID');
  }
  if (!(env.S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY)) {
    missing.push('S3_SECRET_ACCESS_KEY/R2_SECRET_ACCESS_KEY');
  }
  if (!(env.S3_BUCKET || env.R2_BUCKET)) {
    missing.push('S3_BUCKET/R2_BUCKET');
  }
  if (!env.PLATFORM_SECRET) {
    missing.push('PLATFORM_SECRET');
  }
  if (missing.length > 0) {
    log(
      `[platform] MATRIX_HOME_MIRROR=true but trusted sync storage is incomplete; user containers no longer receive raw S3 credentials and must proxy sync storage through the platform. Missing: ${missing.join(', ')}.`,
    );
  }
  return missing;
}
