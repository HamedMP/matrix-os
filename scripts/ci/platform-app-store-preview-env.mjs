import { pathToFileURL } from 'node:url';

/** Render references only. No credential is accepted or printed by this helper. */
export function appStorePreviewBindings(env) {
  const enabled = env.APP_STORE_PREVIEW_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('App Store preview opt-in must be true or false');
  if (enabled === 'false') return { environment: '|MATRIX_APP_STORE_ENABLED=false', secrets: '', secretNames: [] };
  const reviewers = [...new Set((env.PREVIEW_APP_STORE_REVIEWER_CLERK_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean))];
  if (!reviewers.length || reviewers.length > 100 || reviewers.some(value => !/^user_[A-Za-z0-9_-]{1,150}$/.test(value))) {
    throw new Error('App Store preview needs validated reviewer Clerk IDs');
  }
  const keyId = env.PREVIEW_APP_STORE_SIGNING_KEY_ID ?? 'preview-app-store-v1';
  if (!/^preview-[A-Za-z0-9_-]{1,56}$/.test(keyId)) throw new Error('App Store preview needs a distinct preview signing key ID');
  const bindings = [
    ['MATRIX_APP_STORE_SIGNING_PRIVATE_KEY', 'app-store-preview-signing-private-key'],
    ['R2_ACCOUNT_ID', 'app-store-preview-r2-account-id'],
    ['R2_BUCKET', 'app-store-preview-r2-bucket'],
    ['R2_ENDPOINT', 'app-store-preview-r2-endpoint'],
    ['R2_ACCESS_KEY_ID', 'app-store-preview-r2-access-key-id'],
    ['R2_SECRET_ACCESS_KEY', 'app-store-preview-r2-secret-access-key'],
  ];
  return {
    environment: `|MATRIX_APP_STORE_ENABLED=true|MATRIX_APP_STORE_REVIEWER_CLERK_IDS=${reviewers.join(',')}|MATRIX_APP_STORE_SIGNING_KEY_ID=${keyId}`,
    secrets: bindings.map(([setting, name]) => `,${setting}=${name}:latest`).join(''),
    secretNames: bindings.map(([, name]) => name),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = appStorePreviewBindings(process.env);
  process.stdout.write(`environment=${result.environment}\nsecrets=${result.secrets}\nsecret_names=${result.secretNames.join(' ')}\n`);
}
