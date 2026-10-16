import type { R2ClientConfig } from './r2-client.js';

type StorageEnvironment = Readonly<Record<string, string | undefined>>;

function selectedSessionToken(env: StorageEnvironment, dedicated: boolean): string | undefined {
  // Explicit credentials must not inherit the ambient AWS credential chain, a
  // different family's token, or the primary bucket's token for bundle access.
  const s3Key = dedicated ? 'S3_BUNDLES_ACCESS_KEY_ID' : 'S3_ACCESS_KEY_ID';
  const family = env[s3Key] !== undefined ? 'S3' : 'R2';
  const key = `${family}${dedicated ? '_BUNDLES' : ''}_SESSION_TOKEN`;
  return env[key]?.trim() || undefined;
}

export function resolvePlatformObjectStorage(env: StorageEnvironment): {
  primary: R2ClientConfig | null;
  bundles: R2ClientConfig | null;
} {
  const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.R2_SECRET_ACCESS_KEY;
  const primaryToken = selectedSessionToken(env, false);
  const primary: R2ClientConfig | null = accessKeyId && secretAccessKey ? {
    accessKeyId,
    secretAccessKey,
    bucket: env.S3_BUCKET ?? env.R2_BUCKET ?? 'matrixos-sync',
    endpoint: env.S3_ENDPOINT ?? env.R2_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.R2_PUBLIC_ENDPOINT,
    accountId: env.R2_ACCOUNT_ID,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    ...(primaryToken ? { sessionToken: primaryToken } : {}),
  } : null;

  const bucket = env.S3_BUNDLES_BUCKET ?? env.R2_BUNDLES_BUCKET;
  const bundleKey = env.S3_BUNDLES_ACCESS_KEY_ID ?? env.R2_BUNDLES_ACCESS_KEY_ID;
  const bundleSecret = env.S3_BUNDLES_SECRET_ACCESS_KEY ?? env.R2_BUNDLES_SECRET_ACCESS_KEY;
  const bundleToken = selectedSessionToken(env, true);
  const bundles: R2ClientConfig | null = bucket && bundleKey && bundleSecret ? {
    accessKeyId: bundleKey,
    secretAccessKey: bundleSecret,
    bucket,
    endpoint: env.S3_BUNDLES_ENDPOINT ?? env.R2_BUNDLES_ENDPOINT,
    publicEndpoint: env.S3_BUNDLES_PUBLIC_ENDPOINT ?? env.R2_BUNDLES_PUBLIC_ENDPOINT,
    accountId: env.S3_BUNDLES_ACCOUNT_ID ?? env.R2_BUNDLES_ACCOUNT_ID ?? env.R2_ACCOUNT_ID,
    forcePathStyle: env.S3_BUNDLES_FORCE_PATH_STYLE === 'true',
    ...(bundleToken ? { sessionToken: bundleToken } : {}),
  } : null;

  return { primary, bundles };
}
