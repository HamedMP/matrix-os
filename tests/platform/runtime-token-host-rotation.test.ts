import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { encryptRuntimeTokenRotation } from '../../scripts/ops/runtime-token-envelope.mjs';

const hostScript = fileURLToPath(new URL('../../distro/customer-vps/host-bin/matrix-rotate-runtime-tokens.py', import.meta.url));
function apply(paths: { envPath: string; keyPath: string; envelopePath: string }) {
  return spawnSync('python3', ['-c',
    'import runpy,sys; runpy.run_path(sys.argv[1],run_name="rotation_test")["apply_rotation"](*sys.argv[2:])',
    hostScript, paths.envPath, paths.keyPath, paths.envelopePath], { encoding: 'utf8' });
}

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
  await writeFile(envPath, 'MATRIX_MACHINE_ID=machine-1\nMATRIX_RUNTIME_SLOT=primary\nUPGRADE_TOKEN=host-verifier-value\nMATRIX_SYNC_RUNTIME_TOKEN=old\nMATRIX_FUNDED_AI_RUNTIME_TOKEN=old\nMATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=old\nOTHER_SETTING=keep\n', { mode: 0o600 });
  const payload = {
    machineId: 'machine-1', runtimeSlot: 'primary', epoch: 2,
    tokens: { sync: 'a'.repeat(64), fundedAi: 'b'.repeat(64), speech: 'c'.repeat(64) },
  };
  const envelope = encryptRuntimeTokenRotation(payload, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  await writeFile(envelopePath, JSON.stringify(envelope));
  return { envPath, keyPath, envelopePath, payload, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

describe('host runtime-token rotation', () => {
  it('reports only a one-way digest of the host verifier', async () => {
    const paths = await fixture();
    const result = spawnSync('python3', ['-c',
      'import runpy,sys; print(runpy.run_path(sys.argv[1],run_name="rotation_test")["host_verifier_digest"](sys.argv[2]))',
      hostScript, paths.envPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(createHash('sha256').update('host-verifier-value').digest('hex'));
    expect(result.stdout).not.toContain('host-verifier-value');
  });
  it('replaces only the three runtime tokens and records the epoch atomically', async () => {
    const paths = await fixture();
    expect(apply(paths).status).toBe(0);
    const env = await readFile(paths.envPath, 'utf8');
    expect(env).toContain('MATRIX_SYNC_RUNTIME_TOKEN=' + paths.payload.tokens.sync);
    expect(env).toContain('MATRIX_FUNDED_AI_RUNTIME_TOKEN=' + paths.payload.tokens.fundedAi);
    expect(env).toContain('MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=' + paths.payload.tokens.speech);
    expect(env).toContain('MATRIX_RUNTIME_TOKEN_EPOCH=2');
    expect(env).toContain('OTHER_SETTING=keep');
    expect(apply(paths).stderr).toContain('epoch');
  });

  it('rejects tampering without changing host.env', async () => {
    const paths = await fixture();
    const before = await readFile(paths.envPath, 'utf8');
    const envelope = JSON.parse(await readFile(paths.envelopePath, 'utf8'));
    envelope.ciphertext = envelope.ciphertext.slice(0, -2) + 'AA';
    await writeFile(paths.envelopePath, JSON.stringify(envelope));
    expect(apply(paths).status).not.toBe(0);
    expect(await readFile(paths.envPath, 'utf8')).toBe(before);
  });

  it('rejects a bundle for a different machine without changing host.env', async () => {
    const paths = await fixture();
    const before = await readFile(paths.envPath, 'utf8');
    const envelope = encryptRuntimeTokenRotation({ ...paths.payload, machineId: 'machine-2' }, paths.publicKey);
    await writeFile(paths.envelopePath, JSON.stringify(envelope));
    expect(apply(paths).stderr).toContain('target');
    expect(await readFile(paths.envPath, 'utf8')).toBe(before);
  });

  it('rejects a skipped epoch without changing host.env', async () => {
    const paths = await fixture();
    const before = await readFile(paths.envPath, 'utf8');
    const envelope = encryptRuntimeTokenRotation({ ...paths.payload, epoch: 3 }, paths.publicKey);
    await writeFile(paths.envelopePath, JSON.stringify(envelope));
    expect(apply(paths).stderr).toContain('epoch');
    expect(await readFile(paths.envPath, 'utf8')).toBe(before);
  });

  it('rejects duplicate token entries without changing host.env', async () => {
    const paths = await fixture();
    const before = (await readFile(paths.envPath, 'utf8')) + 'MATRIX_SYNC_RUNTIME_TOKEN=conflict\n';
    await writeFile(paths.envPath, before);
    expect(apply(paths).stderr).toContain('Invalid host environment');
    expect(await readFile(paths.envPath, 'utf8')).toBe(before);
  });
});
