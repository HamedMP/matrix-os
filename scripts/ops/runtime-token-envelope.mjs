import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';

export function encryptRuntimeTokenRotation(payload, publicKey) {
  if (!payload || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.machineId) ||
      !/^[a-z0-9-]{1,32}$/.test(payload.runtimeSlot) ||
      !Number.isSafeInteger(payload.epoch) || payload.epoch < 2 || payload.epoch > 2147483647 ||
      !payload.tokens || Object.keys(payload.tokens).sort().join(',') !== 'fundedAi,speech,sync' ||
      Object.values(payload.tokens).some((token) => typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))) {
    throw new Error('Invalid rotation payload');
  }
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  const encryptedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return {
    version: 1,
    encryptedKey: encryptedKey.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}
