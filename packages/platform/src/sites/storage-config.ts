import type { R2ClientConfig } from '../r2-client.js';

type StorageEnvironment = Readonly<Record<string, string | undefined>>;

/** Dedicated public assets never borrow a sync/bundle credential or token. */
export function resolveSitesObjectStorage(env: StorageEnvironment): R2ClientConfig | null {
  const configured = [env.R2_SITES_BUCKET, env.R2_SITES_ACCESS_KEY_ID,
    env.R2_SITES_SECRET_ACCESS_KEY, env.R2_SITES_SESSION_TOKEN];
  if (!configured.some(Boolean)) return null;
  const bucket = env.R2_SITES_BUCKET?.trim();
  const accessKeyId = env.R2_SITES_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SITES_SECRET_ACCESS_KEY?.trim();
  const primaryBucket = (env.S3_BUCKET ?? env.R2_BUCKET ?? 'matrixos-sync').trim();
  const bundleBucket = (env.S3_BUNDLES_BUCKET ?? env.R2_BUNDLES_BUCKET)?.trim();
  // Compare configured names even if unrelated credentials are incomplete and
  // their resolver returns null. Match the object client's normalization.
  if (!bucket || !accessKeyId || !secretAccessKey || bucket === primaryBucket || bucket === bundleBucket) {
    throw new Error('Dedicated sites storage configuration unavailable');
  }
  const sessionToken = env.R2_SITES_SESSION_TOKEN?.trim();
  return { bucket, accessKeyId, secretAccessKey,
    endpoint: env.R2_SITES_ENDPOINT,
    accountId: env.R2_SITES_ACCOUNT_ID ?? env.R2_ACCOUNT_ID,
    ...(sessionToken ? { sessionToken } : {}) };
}
