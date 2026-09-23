#!/opt/matrix/runtime/node/bin/node
import { createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, constants, createPublicKey } from 'node:crypto';
import { open, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENV_PATH = '/opt/matrix/env/host.env';
const KEY_PATH = '/opt/matrix/env/runtime-token-rotation.pem';
const TOKEN_KEYS = {
  sync: 'MATRIX_SYNC_RUNTIME_TOKEN',
  fundedAi: 'MATRIX_FUNDED_AI_RUNTIME_TOKEN',
  speech: 'MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN',
};
const MAX_FILE_BYTES = 65536;

function encoded(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 8192) {
    throw new Error('Invalid rotation envelope');
  }
  return Buffer.from(value, 'base64');
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(payload.machineId) ||
      !/^[a-z0-9-]{1,32}$/.test(payload.runtimeSlot) ||
      !Number.isSafeInteger(payload.epoch) || payload.epoch < 2 || payload.epoch > 2147483647 ||
      !payload.tokens || Object.keys(payload.tokens).sort().join(',') !== 'fundedAi,speech,sync' ||
      Object.values(payload.tokens).some((token) => typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))) {
    throw new Error('Invalid rotation payload');
  }
  return payload;
}

export function encryptRuntimeTokenRotation(rawPayload, publicKey) {
  const payload = validPayload(rawPayload);
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

async function readRegular(path, maxBytes, rootOnly = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes || (info.mode & 0o022) || (rootOnly && (info.mode & 0o077))) {
    throw new Error('Unsafe rotation file');
  }
  if (rootOnly && typeof process.getuid === 'function' && process.getuid() === 0 && info.uid !== 0) {
    throw new Error('Unsafe rotation file owner');
  }
  return readFile(path);
}

function uniqueEnvValue(lines, key) {
  const matches = lines.filter((line) => line.startsWith(`${key}=`));
  if (matches.length !== 1) throw new Error('Invalid host environment');
  return matches[0].slice(key.length + 1);
}

export async function applyRuntimeTokenRotation({ envPath, keyPath, envelopePath }) {
  const [envBytes, privateKey, envelopeBytes] = await Promise.all([
    readRegular(envPath, MAX_FILE_BYTES),
    readRegular(keyPath, 8192, true),
    readRegular(envelopePath, MAX_FILE_BYTES),
  ]);
  const envelope = JSON.parse(envelopeBytes.toString('utf8'));
  if (envelope?.version !== 1 || Object.keys(envelope).sort().join(',') !== 'ciphertext,encryptedKey,nonce,tag,version') {
    throw new Error('Invalid rotation envelope');
  }
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, encoded(envelope.encryptedKey));
  const nonce = encoded(envelope.nonce);
  const tag = encoded(envelope.tag);
  if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid rotation envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const payload = validPayload(JSON.parse(Buffer.concat([decipher.update(encoded(envelope.ciphertext)), decipher.final()]).toString('utf8')));
  const env = envBytes.toString('utf8');
  const lines = env.split('\n');
  if (uniqueEnvValue(lines, 'MATRIX_MACHINE_ID') !== payload.machineId ||
      uniqueEnvValue(lines, 'MATRIX_RUNTIME_SLOT') !== payload.runtimeSlot) {
    throw new Error('Rotation target does not match this host');
  }
  const epochs = lines.filter((line) => line.startsWith('MATRIX_RUNTIME_TOKEN_EPOCH='));
  if (epochs.length > 1) throw new Error('Invalid host environment');
  const currentEpoch = epochs.length ? Number(epochs[0].slice('MATRIX_RUNTIME_TOKEN_EPOCH='.length)) : 1;
  if (!Number.isSafeInteger(currentEpoch) || payload.epoch !== currentEpoch + 1) {
    throw new Error('Unexpected runtime token epoch');
  }
  for (const keyName of Object.values(TOKEN_KEYS)) uniqueEnvValue(lines, keyName);
  const next = lines.map((line) => {
    for (const [field, keyName] of Object.entries(TOKEN_KEYS)) {
      if (line.startsWith(`${keyName}=`)) return `${keyName}=${payload.tokens[field]}`;
    }
    if (line.startsWith('MATRIX_RUNTIME_TOKEN_EPOCH=')) return `MATRIX_RUNTIME_TOKEN_EPOCH=${payload.epoch}`;
    return line;
  });
  if (!epochs.length) next.splice(next.at(-1) === '' ? next.length - 1 : next.length, 0, `MATRIX_RUNTIME_TOKEN_EPOCH=${payload.epoch}`);

  const destination = resolve(envPath);
  const directory = dirname(destination);
  const tempPath = `${destination}.rotation-${process.pid}-${randomBytes(8).toString('hex')}`;
  const original = await lstat(destination);
  let file;
  try {
    file = await open(tempPath, 'wx', original.mode & 0o777);
    await file.chown(original.uid, original.gid);
    await file.writeFile(next.join('\n'));
    await file.sync();
    await file.close();
    file = undefined;
    await rename(tempPath, destination);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    if (file) await file.close();
    await unlink(tempPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  return payload.epoch;
}

async function main() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new Error('Root is required');
  const action = process.argv[2];
  if (action === 'init' && process.argv.length === 3) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const file = await open(KEY_PATH, 'wx', 0o600);
    try { await file.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' })); await file.sync(); }
    finally { await file.close(); }
    process.stdout.write(publicKey.export({ type: 'spki', format: 'pem' }));
    return;
  }
  if (action === 'public-key' && process.argv.length === 3) {
    const key = await readRegular(KEY_PATH, 8192, true);
    process.stdout.write(createPublicKey(key).export({ type: 'spki', format: 'pem' }));
    return;
  }
  if (action === 'apply' && process.argv.length === 4) {
    const epoch = await applyRuntimeTokenRotation({ envPath: ENV_PATH, keyPath: KEY_PATH, envelopePath: process.argv[3] });
    process.stdout.write(`Runtime token epoch ${epoch} installed. Restart dependent services.\n`);
    return;
  }
  throw new Error('Usage: matrix-rotate-runtime-tokens <init|public-key|apply ENCRYPTED_FILE>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Runtime token rotation failed.\n'); process.exitCode = 1; });
}
