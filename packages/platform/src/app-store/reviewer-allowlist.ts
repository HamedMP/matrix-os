import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { StoreRepositoryOptions } from './repository-review.js';
import type { StoreSigningKey } from '@matrix-os/contracts/app-store-signing';
export function readStoreConfiguration(env: NodeJS.ProcessEnv) {
  // Fixed configuration cap; replaced only on process restart, no runtime growth.
  const reviewers = (env.MATRIX_APP_STORE_REVIEWER_CLERK_IDS ?? '').split(',').map(value => value.trim()).filter(value => /^[A-Za-z0-9_-]{3,256}$/.test(value)).slice(0, 100);
  let signing: StoreRepositoryOptions['signing']; const signingKeys: StoreSigningKey[] = [];
  const keyId = env.MATRIX_APP_STORE_SIGNING_KEY_ID; const privateKey = env.MATRIX_APP_STORE_SIGNING_PRIVATE_KEY;
  if (keyId || privateKey) {
    if (!keyId || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || !privateKey || privateKey.length > 4096) throw new Error('App Store signing configuration is invalid');
    const key = createPrivateKey(privateKey.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('App Store signing configuration is invalid');
    signing = { keyId, privateKey: key.export({ format: 'pem', type: 'pkcs8' }).toString() };
    signingKeys.push({ keyId, publicKey: createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString() });
  }
  if (env.MATRIX_APP_STORE_PREVIOUS_SIGNING_KEYS) {
    const text = env.MATRIX_APP_STORE_PREVIOUS_SIGNING_KEYS;
    if (text.length > 4096) throw new Error('App Store signing configuration is invalid');
    const previous: unknown = JSON.parse(text);
    if (!Array.isArray(previous) || previous.length > 3) throw new Error('App Store signing configuration is invalid');
    for (const entry of previous) {
      if (!entry || typeof entry !== 'object' || typeof entry.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.keyId)
        || typeof entry.publicKey !== 'string' || entry.publicKey.length > 1024 || signingKeys.some(key => key.keyId === entry.keyId)) throw new Error('App Store signing configuration is invalid');
      const publicKey = createPublicKey(entry.publicKey);
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('App Store signing configuration is invalid');
      signingKeys.push({ keyId: entry.keyId, publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString() });
    }
  }
  return { enabled: ['true', '1'].includes(env.MATRIX_APP_STORE_ENABLED ?? ''), reviewers, signing, signingKeys };
}
