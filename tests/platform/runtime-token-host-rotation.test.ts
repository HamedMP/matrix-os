import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  applyRuntimeTokenRotation,
  encryptRuntimeTokenRotation,
} from '../../distro/customer-vps/host-bin/matrix-rotate-runtime-tokens.mjs';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'matrix-token-rotation-'));
  dirs.push(dir);
  const envPath = join(dir, 'host.env');
  const keyPath = join(dir, 'rotation.pem');
  const envelopePath = join(dir, 'rotation.json');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(envPath, 'MATRIX_MACHINE_ID=machine-1\nMATRIX_RUNTIME_SLOT=primary\nMATRIX_SYNC_RUNTIME_TOKEN=old\nMATRIX_FUNDED_AI_RUNTIME_TOKEN=old\nMATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=old\nOTHER_SETTING=keep\n', { mode: 0o600 });
  const payload = {
    machineId: 'machine-1', runtimeSlot: 'primary', epoch: 2,
    tokens: { sync: 'a'.repeat(64), fundedAi: 'b'.repeat(64), speech: 'c'.repeat(64) },
  };
  const envelope = encryptRuntimeTokenRotation(payload, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  await writeFile(envelopePath, JSON.stringify(envelope));
  return { envPath, keyPath, envelopePath, payload, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

describe('host runtime-token rotation', () => {
  it('replaces only the three runtime tokens and records the epoch atomically', async () => {
    const paths = await fixture();
    await applyRuntimeTokenRotation(paths);
    const env = await readFile(paths.envPath, 'utf8');
    expect(env).toContain('MATRIX_SYNC_RUNTIME_TOKEN=' + paths.payload.tokens.sync);
    expect(env).toContain('MATRIX_FUNDED_AI_RUNTIME_TOKEN=' + paths.payload.tokens.fundedAi);
    expect(env).toContain('MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=' + paths.payload.tokens.speech);
    expect(env).toContain('MATRIX_RUNTIME_TOKEN_EPOCH=2');
    expect(env).toContain('OTHER_SETTING=keep');
    await expect(applyRuntimeTokenRotation(paths)).rejects.toThrow('epoch');
  });

  it('rejects tampering without changing host.env', async () => {
    const paths = await fixture();
    const before = await readFile(paths.envPath, 'utf8');
    const envelope = JSON.parse(await readFile(paths.envelopePath, 'utf8'));
    envelope.ciphertext = envelope.ciphertext.slice(0, -2) + 'AA';
    await writeFile(paths.envelopePath, JSON.stringify(envelope));
    await expect(applyRuntimeTokenRotation(paths)).rejects.toThrow();
    expect(await readFile(paths.envPath, 'utf8')).toBe(before);
  });

  it('rejects a bundle for a different machine without changing host.env', async () => {
    const paths = await fixture();
    const before = await readFile(paths.envPath, 'utf8');
    const envelope = encryptRuntimeTokenRotation({ ...paths.payload, machineId: 'machine-2' }, paths.publicKey);
    await writeFile(paths.envelopePath, JSON.stringify(envelope));
    await expect(applyRuntimeTokenRotation(paths)).rejects.toThrow('target');
    expect(await readFile(paths.envPath, 'utf8')).toBe(before);
  });

  it('rejects a skipped epoch without changing host.env', async () => {
    const paths = await fixture();
    const before = await readFile(paths.envPath, 'utf8');
    const envelope = encryptRuntimeTokenRotation({ ...paths.payload, epoch: 3 }, paths.publicKey);
    await writeFile(paths.envelopePath, JSON.stringify(envelope));
    await expect(applyRuntimeTokenRotation(paths)).rejects.toThrow('epoch');
    expect(await readFile(paths.envPath, 'utf8')).toBe(before);
  });
});
