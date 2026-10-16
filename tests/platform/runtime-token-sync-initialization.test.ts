import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPlatformSyncVerificationToken, buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';

const modulePath = fileURLToPath(new URL('../../scripts/ops/runtime-token-sync-initialization.ts', import.meta.url));
const secret = 'initialization-test-platform-secret-12345';
const machineId = '12345678-1234-4234-9234-123456789012';
const identity = { ownerId: 'user_test', handle: 'test-main', machineId, runtimeSlot: 'primary' };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const recipientSha256 = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const verifierDigest = createHash('sha256').update(buildPlatformVerificationToken(identity.handle, secret)).digest('hex');
const now = new Date('2026-10-16T12:00:00.000Z');

async function preparation() {
  // Fail as a missing capability assertion, not an unresolved-import/environment error.
  expect(existsSync(modulePath), 'operator prepare-only Sync initialization is not implemented').toBe(true);
  const module = await import(pathToFileURL(modulePath).href);
  expect(typeof module.prepareSyncInitialization).toBe('function');
  return module.prepareSyncInitialization;
}
function options(epoch = 1) {
  return {
    machine: { machine_id: machineId, clerk_user_id: identity.ownerId, handle: identity.handle,
      runtime_slot: 'primary', runtime_token_epoch: epoch, status: 'running', deleted_at: null,
      provisioning_class: 'customer', activation_state: 'authorized' },
    expectedIdentity: identity, expectedRelease: { version: 'v-test-sync-init', gitCommit: 'a'.repeat(40) },
    expectedFile: { sha256: 'b'.repeat(64), inode: 123, device: 456 },
    recipientPublicKey: publicPem, recipientSha256, verifierDigest, platformSecret: secret,
    now, expiresAt: new Date(now.getTime() + 30_000), nonce: 'c'.repeat(32),
  };
}
function decrypt(envelope: Record<string, string | number>) {
  expect(envelope.version).toBe(2);
  expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'encryptedKey', 'nonce', 'tag', 'version']);
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256' }, Buffer.from(String(envelope.encryptedKey), 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.nonce), 'base64'));
  cipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(String(envelope.ciphertext), 'base64')), cipher.final()]).toString());
}

describe('operator prepare-only missing Sync enrollment', () => {
  it.each([1, 2, 19])('seals only Sync at authoritative epoch %i without mutating its input', async epoch => {
    const prepare = await preparation();
    const input = options(epoch); const before = structuredClone(input);
    const envelope = prepare(input); const payload = decrypt(envelope);
    expect(input).toEqual(before);
    expect(payload).toEqual({ contractVersion: 1, kind: 'matrix-sync-initialization',
      identity: { ...identity, runtimeTokenEpoch: epoch }, expectedRelease: input.expectedRelease,
      expectedFile: input.expectedFile, recipientSha256, issuedAt: now.toISOString(),
      expiresAt: input.expiresAt.toISOString(), nonce: input.nonce,
      syncRuntimeToken: buildPlatformSyncVerificationToken(identity, secret, epoch) });
    expect(JSON.stringify(envelope)).not.toContain(payload.syncRuntimeToken);
    expect(payload).not.toHaveProperty('fundedAi'); expect(payload).not.toHaveProperty('speech');
  });

  it.each([
    ['wrong owner', { clerk_user_id: 'user_other' }], ['wrong machine', { machine_id: '22345678-1234-4234-9234-123456789012' }],
    ['wrong handle', { handle: 'other-main' }], ['secondary', { runtime_slot: 'secondary' }],
    ['deleted', { deleted_at: now.toISOString() }], ['recovering', { status: 'recovering' }],
    ['private preview', { provisioning_class: 'private-preview' }], ['unauthorized', { activation_state: 'pending' }],
    ['zero epoch', { runtime_token_epoch: 0 }], ['boolean epoch', { runtime_token_epoch: true }],
  ])('refuses %s without deriving an initialization envelope', async (_name, patch) => {
    const prepare = await preparation(); const input = options(); Object.assign(input.machine, patch);
    expect(() => prepare(input)).toThrow();
  });

  it.each(['recipient', 'verifier', 'source', 'fingerprint', 'nonce', 'expired', 'future-expiry'])('refuses invalid %s binding', async failure => {
    const prepare = await preparation(); const input = options();
    if (failure === 'recipient') input.recipientSha256 = 'f'.repeat(64);
    if (failure === 'verifier') input.verifierDigest = 'f'.repeat(64);
    if (failure === 'source') input.expectedRelease.gitCommit = 'not-a-source';
    if (failure === 'fingerprint') input.expectedFile.inode = -1;
    if (failure === 'nonce') input.nonce = 'not-a-nonce';
    if (failure === 'expired') input.expiresAt = input.now;
    if (failure === 'future-expiry') input.expiresAt = new Date(input.now.getTime() + 30_001);
    expect(() => prepare(input)).toThrow();
  });

  it('requires the public key fingerprint from operator-verified recipient metadata', async () => {
    const prepare = await preparation(); const input = options();
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    input.recipientPublicKey = otherKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => prepare(input)).toThrow();
  });
});
