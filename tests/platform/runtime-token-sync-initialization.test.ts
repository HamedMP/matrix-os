import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
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

// Cross-language contract: real Node encryption and the exact protected Python decryptor.
describe('protected initialization envelope cryptography', () => {
  it.each(['valid', 'tampered', 'wrong-kind-version', 'wrong-recipient'])('handles %s without secret output', async mode => {
    const prepare = await preparation();
    const envelope = prepare(options());
    if (mode === 'tampered') {
      const bytes = Buffer.from(envelope.ciphertext, 'base64'); bytes[0] ^= 1;
      envelope.ciphertext = bytes.toString('base64');
    }
    if (mode === 'wrong-kind-version') envelope.version = 1;
    const recipient = mode === 'wrong-recipient' ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : privateKey;
    const { spawnSync } = await import('node:child_process');
    const program = `import json,runpy,sys
from pathlib import Path
n=runpy.run_path('distro/customer-vps/funded-host-config/install.py',run_name='crypto_test')
exec(compile(Path('distro/customer-vps/funded-host-config/sync-initialization.py').read_text(),'initialization','exec'),n)
request=json.load(sys.stdin)
try:
 value,recipient=n['decrypt_sync_initialization'](json.dumps(request['envelope']).encode(),request['key'].encode())
 print(json.dumps({'recipient':recipient,'epoch':value['identity']['runtimeTokenEpoch'],'kind':value['kind']}))
except Exception:
 print('configuration_deferred',file=sys.stderr);sys.exit(1)
`;
    const result = spawnSync('python3', ['-I', '-c', program], { encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ envelope, key: recipient.export({ type: 'pkcs8', format: 'pem' }).toString() }) });
    expect(result.status, result.stderr).toBe(mode === 'valid' ? 0 : 1);
    if (mode === 'valid') expect(JSON.parse(result.stdout)).toEqual({ recipient: recipientSha256, epoch: 1, kind: 'matrix-sync-initialization' });
    else expect(result.stderr.trim()).toBe('configuration_deferred');
    expect(result.stdout + result.stderr).not.toContain(buildPlatformSyncVerificationToken(identity, secret, 1));
    expect(result.stdout + result.stderr).not.toContain('PRIVATE KEY');
  });
});

describe('operator initialization database boundary', () => {
  it('reads actual identity and epoch in a bounded read-only transaction, with no activation write', async () => {
    await preparation();
    const { prepareSyncInitializationFromDatabase } = await import(pathToFileURL(modulePath).href);
    const queries: Array<{ sql: string; parameters: unknown[] }> = [];
    const input = options(7);
    const client = {
      async query(sql: string, parameters: unknown[] = []) {
        queries.push({ sql, parameters });
        expect(queries.length).toBeLessThan(20);
        return { rows: /select.*"user_machines"/i.test(sql) ? [input.machine] : [], rowCount: 0 };
      },
      release() {}, on() {}, removeListener() {},
    };
    const pool = { async connect() { return client; }, async end() {} };
    const db = new Kysely({ dialect: new PostgresDialect({ pool: pool as never }) });
    try {
      const payload = decrypt(await prepareSyncInitializationFromDatabase(db, machineId, input, () => now));
      expect(payload.identity.runtimeTokenEpoch).toBe(7);
      expect(queries.some(query => query.sql === 'SET TRANSACTION READ ONLY')).toBe(true);
      expect(queries.some(query => query.sql === "SET LOCAL statement_timeout = '5000ms'")).toBe(true);
      expect(queries.some(query => /repeatable read/i.test(query.sql))).toBe(true);
      expect(queries.some(query => /\b(insert|update|delete)\b/i.test(query.sql))).toBe(false);
      const selection = queries.find(query => /select.*"user_machines"/i.test(query.sql));
      expect(selection?.parameters).toEqual([machineId]);
      expect(input.machine.runtime_token_epoch).toBe(7);
    } finally { await db.destroy(); }
  });
});
