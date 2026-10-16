import { describe, expect, it } from 'vitest';
import { resolvePlatformObjectStorage } from '../../packages/platform/src/object-storage-config.js';
import { createR2Client } from '../../packages/platform/src/r2-client.js';

const primary = {
  R2_ACCOUNT_ID: 'account', R2_ACCESS_KEY_ID: 'sync-key',
  R2_SECRET_ACCESS_KEY: 'sync-secret', R2_BUCKET: 'sync-bucket',
  R2_ENDPOINT: 'https://account.eu.r2.cloudflarestorage.com',
};
const bundle = {
  R2_BUNDLES_ACCESS_KEY_ID: 'bundle-key', R2_BUNDLES_SECRET_ACCESS_KEY: 'bundle-secret',
  R2_BUNDLES_BUCKET: 'bundle-bucket', R2_BUNDLES_ENDPOINT: primary.R2_ENDPOINT,
};

describe('platform object storage configuration', () => {
  it('preserves the permanent primary and dedicated-bundle configuration', () => {
    expect(resolvePlatformObjectStorage({ ...primary, ...bundle })).toEqual({
      primary: { accessKeyId: 'sync-key', secretAccessKey: 'sync-secret', bucket: 'sync-bucket',
        endpoint: primary.R2_ENDPOINT, publicEndpoint: undefined, accountId: 'account', forcePathStyle: false },
      bundles: { accessKeyId: 'bundle-key', secretAccessKey: 'bundle-secret', bucket: 'bundle-bucket',
        endpoint: primary.R2_ENDPOINT, publicEndpoint: undefined, accountId: 'account', forcePathStyle: false },
    });
  });

  it('keeps primary and bundle session tokens independent through real SDK signing', async () => {
    const configs = resolvePlatformObjectStorage({ ...primary, ...bundle,
      R2_SESSION_TOKEN: 'sync-session', R2_BUNDLES_SESSION_TOKEN: 'bundle-session' });
    expect(configs.primary).not.toBeNull();
    expect(configs.bundles).not.toBeNull();
    for (const [config, token] of [[configs.primary!, 'sync-session'], [configs.bundles!, 'bundle-session']] as const) {
      const client = await createR2Client(config);
      try { expect(new URL(await client.getPresignedGetUrl('fixture.txt')).searchParams.get('X-Amz-Security-Token')).toBe(token); }
      finally { client.destroy(); }
    }
  });

  it('never fills a missing dedicated-bundle token with the primary or ambient token', () => {
    const result = resolvePlatformObjectStorage({ ...primary, ...bundle,
      R2_SESSION_TOKEN: 'sync-session', AWS_SESSION_TOKEN: 'ambient' });
    expect(result.primary?.sessionToken).toBe('sync-session');
    expect(result.bundles).not.toHaveProperty('sessionToken');
  });

  it('selects the session-token family belonging to the selected access key', () => {
    const result = resolvePlatformObjectStorage({ ...primary, ...bundle,
      S3_ACCESS_KEY_ID: 's3-sync-key', S3_SECRET_ACCESS_KEY: 's3-sync-secret',
      S3_SESSION_TOKEN: 's3-sync-session', R2_SESSION_TOKEN: 'unrelated-r2-session',
      S3_BUNDLES_ACCESS_KEY_ID: 's3-bundle-key', S3_BUNDLES_SECRET_ACCESS_KEY: 's3-bundle-secret',
      S3_BUNDLES_SESSION_TOKEN: 's3-bundle-session', R2_BUNDLES_SESSION_TOKEN: 'unrelated-r2-bundle-session' });
    expect(result.primary).toMatchObject({ accessKeyId: 's3-sync-key', sessionToken: 's3-sync-session' });
    expect(result.bundles).toMatchObject({ accessKeyId: 's3-bundle-key', sessionToken: 's3-bundle-session' });
  });

  it('ignores tokens from a credential family whose access key is not selected', () => {
    const result = resolvePlatformObjectStorage({ ...primary, ...bundle,
      S3_SESSION_TOKEN: 'unrelated-s3', S3_BUNDLES_SESSION_TOKEN: 'unrelated-s3-bundle',
      AWS_SESSION_TOKEN: 'ambient' });
    expect(result.primary).not.toHaveProperty('sessionToken');
    expect(result.bundles).not.toHaveProperty('sessionToken');
  });

  it('preserves primary-client fallback when dedicated bundle credentials are absent', () => {
    expect(resolvePlatformObjectStorage({ ...primary, R2_SESSION_TOKEN: 'sync-session' }).bundles).toBeNull();
  });

  it('does not enable storage with only session tokens or incomplete dedicated keys', () => {
    expect(resolvePlatformObjectStorage({ R2_SESSION_TOKEN: 'token' })).toEqual({ primary: null, bundles: null });
    expect(resolvePlatformObjectStorage({ ...primary, R2_BUNDLES_BUCKET: 'bundle', R2_BUNDLES_ACCESS_KEY_ID: 'only-key' }).bundles).toBeNull();
  });

  it('preserves explicit S3 transport configuration and existing nullish precedence', () => {
    const result = resolvePlatformObjectStorage({ ...primary, S3_ENDPOINT: 'https://s3.example.com',
      S3_BUCKET: 's3-bucket', S3_PUBLIC_ENDPOINT: 'https://download.example.com', S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: 's3-secret' });
    expect(result.primary).toBeNull();
    expect(resolvePlatformObjectStorage({ ...primary, S3_ENDPOINT: 'https://s3.example.com',
      S3_BUCKET: 's3-bucket', S3_PUBLIC_ENDPOINT: 'https://download.example.com', S3_FORCE_PATH_STYLE: 'true' }).primary)
      .toMatchObject({ endpoint: 'https://s3.example.com', bucket: 's3-bucket', publicEndpoint: 'https://download.example.com', forcePathStyle: true });
  });
});
