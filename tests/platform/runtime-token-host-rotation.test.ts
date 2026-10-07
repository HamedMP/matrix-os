import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { encryptRuntimeTokenRotation } from '../../scripts/ops/runtime-token-envelope.mjs';
import { buildRotationPayload, parseRotationFlags } from '../../scripts/ops/rotate-runtime-tokens.js';

const hostScript = fileURLToPath(new URL('../../distro/customer-vps/host-bin/matrix-rotate-runtime-tokens.py', import.meta.url));
function apply(paths: { envPath: string; keyPath: string; envelopePath: string }) {
  return spawnSync('python3', ['-c',
    'import runpy,sys; runpy.run_path(sys.argv[1],run_name="rotation_test")["apply_rotation"](*sys.argv[2:])',
    hostScript, paths.envPath, paths.keyPath, paths.envelopePath], { encoding: 'utf8' });
}
function validate(paths: { envPath: string; keyPath: string; envelopePath: string }) {
  return spawnSync('python3', ['-c',
    'import runpy,sys; print(runpy.run_path(sys.argv[1],run_name="rotation_test")["validate_rotation"](*sys.argv[2:]))',
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

describe('image runtime-token rotation compatibility', () => {
 it('validates the matching image-enabled envelope without changing the host before activation', async () => {
  const paths = await fixture();
  const before = (await readFile(paths.envPath, 'utf8')) + 'MATRIX_PLATFORM_IMAGE_ENABLED=true\nMATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN=old\n';
  await writeFile(paths.envPath, before);
  const payload = buildRotationPayload({ machine_id: 'machine-1', handle: 'images', runtime_slot: 'primary' }, 'operator-secret-at-least-thirty-two-bytes', 2, 'confirmed');
  await writeFile(paths.envelopePath, JSON.stringify(encryptRuntimeTokenRotation(payload, paths.publicKey)));
  expect(validate(paths).status).toBe(0);
  expect(validate(paths).stdout.trim()).toBe('2');
  expect(await readFile(paths.envPath, 'utf8')).toBe(before);
  expect(apply(paths).status).toBe(0);
  expect(validate(paths).status).not.toBe(0);
 });
 it('rejects a missing-image envelope during pre-activation validation without changing credentials', async () => {
  const paths = await fixture();
  const before = (await readFile(paths.envPath, 'utf8')) + 'MATRIX_PLATFORM_IMAGE_ENABLED=true\nMATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN=old\n';
  await writeFile(paths.envPath, before);
  expect(validate(paths).status).not.toBe(0);
  expect(validate(paths).stderr).toContain('Missing image runtime token');
  expect(await readFile(paths.envPath, 'utf8')).toBe(before);
 });
 it('documents host capability and envelope validation before platform activation', async () => {
  const spec = await readFile(fileURLToPath(new URL('../../specs/527-runtime-token-rotation/spec.md', import.meta.url)), 'utf8');
  const sequence = spec.split('## Operator sequence')[1]!.split('## Acceptance')[0]!;
  expect(sequence).toContain('token-domains');
  expect(sequence).toContain('--host-image-support confirmed');
  const validation = sequence.indexOf('validate <encrypted-file>');
  const activation = sequence.indexOf('Use `activate`');
  expect(validation).toBeGreaterThan(-1);
  expect(activation).toBeGreaterThan(validation);
  expect(sequence).toContain('Do not activate');
 });
 it.each(['prepare', 'prepare-recovery'])('operator %s defaults to the three-domain payload accepted by older hosts', async (action) => {
  const paths = await fixture();
  const args = [action, '--machine-id', 'machine-1', '--db-file', 'db', '--secret-file', 'secret', '--public-key-file', 'public', '--verifier-digest', 'a'.repeat(64), '--out', 'out'];
  if (action === 'prepare-recovery') args.push('--host-epoch', '1');
  const options = parseRotationFlags(args);
  const payload = buildRotationPayload({ machine_id: 'machine-1', handle: 'images', runtime_slot: 'primary' }, 'operator-secret-at-least-thirty-two-bytes', 2, options['host-image-support']);
  expect(Object.keys(payload.tokens).sort()).toEqual(['fundedAi', 'speech', 'sync']);
  await writeFile(paths.envelopePath, JSON.stringify(encryptRuntimeTokenRotation(payload, paths.publicKey)));
  expect(apply(paths).status).toBe(0);
  expect(await readFile(paths.envPath, 'utf8')).not.toContain('MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN');
 });
 it('operator includes image tokens only with explicit confirmed host support', () => {
  const probe = spawnSync('python3', [hostScript, 'token-domains'], { encoding: 'utf8' });
  expect(probe.status).toBe(0);
  expect(JSON.parse(probe.stdout)).toEqual(['fundedAi', 'images', 'speech', 'sync']);
  const args = ['prepare', '--machine-id', 'machine-1', '--db-file', 'db', '--secret-file', 'secret', '--public-key-file', 'public', '--verifier-digest', 'a'.repeat(64), '--out', 'out'];
  expect(() => parseRotationFlags([...args, '--host-image-support', 'unknown'])).toThrow();
  const options = parseRotationFlags([...args, '--host-image-support', 'confirmed']);
  const payload = buildRotationPayload({ machine_id: 'machine-1', handle: 'images', runtime_slot: 'primary' }, 'operator-secret-at-least-thirty-two-bytes', 2, options['host-image-support']);
  expect(Object.keys(payload.tokens).sort()).toEqual(['fundedAi', 'images', 'speech', 'sync']);
 });
 it('rotates image credentials along with existing domains on a new host', async () => {
  const paths = await fixture();
  await writeFile(paths.envPath, (await readFile(paths.envPath, 'utf8')) + 'MATRIX_PLATFORM_IMAGE_ENABLED=true\nMATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN=old\n');
  const envelope = encryptRuntimeTokenRotation({ ...paths.payload, tokens: { ...paths.payload.tokens, images: 'd'.repeat(64) } }, paths.publicKey);
  await writeFile(paths.envelopePath, JSON.stringify(envelope));
  expect(apply(paths).status).toBe(0);
  expect(await readFile(paths.envPath, 'utf8')).toContain('MATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN=' + 'd'.repeat(64));
 });
 it('refuses a legacy envelope when funded images are enabled', async () => {
  const paths = await fixture();
  const before = (await readFile(paths.envPath, 'utf8')) + 'MATRIX_PLATFORM_IMAGE_ENABLED=true\nMATRIX_PLATFORM_IMAGE_RUNTIME_TOKEN=old\n';
  await writeFile(paths.envPath, before);
  expect(apply(paths).status).not.toBe(0); expect(await readFile(paths.envPath, 'utf8')).toBe(before);
 });
});
