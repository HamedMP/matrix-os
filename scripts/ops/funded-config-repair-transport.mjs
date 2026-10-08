import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const nodeRequire = createRequire(import.meta.url);
const CONTEXT = 'matrix-funded-chat-repair-envelope-v1';

/** Existing per-host auth bearer only. Never supply the broad Platform secret. */
export function sealFundedConfigRepair(request, helperSource, authToken, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(authToken) || typeof helperSource !== 'string'
    || Buffer.byteLength(helperSource) > 65_536 || !Number.isSafeInteger(now)) {
    throw new Error('Invalid repair transport input');
  }
  const plaintext = Buffer.from(JSON.stringify(request));
  if (plaintext.length > 4096 || !request?.identity || !request?.expectedFile
    || !['apply', 'rollback'].includes(request.action)) throw new Error('Invalid repair request');
  if (helperSource.includes(authToken) || (typeof request.config?.runtimeToken === 'string'
    && helperSource.includes(request.config.runtimeToken))) throw new Error('Secrets must not be embedded in helper source');
  const aad = {
    identity: request.identity, action: request.action, expectedFile: request.expectedFile,
    helperSha256: createHash('sha256').update(helperSource).digest('hex'),
    requestSha256: createHash('sha256').update(plaintext).digest('hex'),
    issuedAt: now, expiresAt: now + 120_000,
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = hkdfSync('sha256', Buffer.from(authToken, 'hex'), salt, Buffer.from(CONTEXT), 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    envelope: { version: 1, aad, salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
    helper: deflateSync(Buffer.from(helperSource)).toString('base64'),
  };
}

/** Isolated bootstrap; production command calls only fixed defaults.
 * Path/UID overrides are for unprivileged process tests, never envelope fields. */
export function executeFundedConfigRepairBridge(transport, options = {}) {
  const fs = nodeRequire('node:fs');
  const crypto = nodeRequire('node:crypto');
  const zlib = nodeRequire('node:zlib');
  const { spawnSync } = nodeRequire('node:child_process');
  const requireCondition = value => { if (!value) throw new Error('Repair transport rejected'); };
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  const uid = options.uid ?? 0;
  const envPath = options.envPath ?? '/opt/matrix/env/host.env';
  requireCondition(process.getuid() === uid && Buffer.byteLength(JSON.stringify(transport)) <= 16_384);
  if (options.checkAncestors !== false) {
    for (const path of ['/opt', '/opt/matrix', '/opt/matrix/env']) {
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        requireCondition(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022));
      } finally { fs.closeSync(fd); }
    }
  }
  let gid = options.gid;
  if (gid === undefined) {
    const group = spawnSync('/usr/bin/getent', ['group', 'matrix'], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 });
    requireCondition(group.status === 0 && /^matrix:[^:\n]*:\d+:[^\n]*\n?$/.test(group.stdout));
    gid = Number(group.stdout.split(':')[2]);
  }
  const fd = fs.openSync(envPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    requireCondition(stat.isFile() && stat.nlink === 1 && stat.uid === uid && stat.gid === gid
      && (stat.mode & 0o7777) === 0o640 && stat.size <= 65_536);
    const buffer = Buffer.alloc(65_537);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fs.fstatSync(fd);
    requireCondition(length <= 65_536 && stat.size === after.size && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs);
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  const names = { machineId: 'MATRIX_MACHINE_ID', ownerId: 'MATRIX_CLERK_USER_ID',
    handle: 'MATRIX_HANDLE', runtimeSlot: 'MATRIX_RUNTIME_SLOT', epoch: 'MATRIX_RUNTIME_TOKEN_EPOCH' };
  const watched = new Set([...Object.values(names), 'MATRIX_AUTH_TOKEN']);
  const values = {};
  for (const line of bytes.toString('utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !watched.has(match[1])) continue;
    requireCondition(!(match[1] in values) && line.startsWith(match[1] + '=')
      && /^[A-Za-z0-9_-]+$/.test(line.slice(match[1].length + 1)));
    values[match[1]] = line.slice(match[1].length + 1);
  }
  const envelope = transport.envelope;
  requireCondition(envelope?.version === 1 && /^[a-f0-9]{64}$/.test(values.MATRIX_AUTH_TOKEN ?? ''));
  const aad = envelope.aad;
  const now = Date.now();
  requireCondition(aad && Number.isSafeInteger(aad.issuedAt) && Number.isSafeInteger(aad.expiresAt)
    && aad.issuedAt <= now + 5000 && aad.expiresAt >= now
    && aad.expiresAt > aad.issuedAt && aad.expiresAt - aad.issuedAt <= 120_000
    && /^[a-f0-9]{64}$/.test(aad.helperSha256) && /^[a-f0-9]{64}$/.test(aad.requestSha256)
    && aad.identity && Object.keys(aad.identity).sort().join() === Object.keys(names).sort().join()
    && aad.identity.runtimeSlot === 'primary' && Number.isSafeInteger(aad.identity.epoch)
    && aad.identity.epoch >= 1 && aad.identity.epoch <= 2147483647);
  for (const [key, name] of Object.entries(names)) requireCondition(values[name] === String(aad.identity[key]));
  const decode = (value, limit, exact) => {
    requireCondition(typeof value === 'string' && value.length <= Math.ceil(limit / 3) * 4
      && /^[A-Za-z0-9+/]*={0,2}$/.test(value));
    const buffer = Buffer.from(value, 'base64');
    requireCondition(buffer.length <= limit && buffer.toString('base64') === value && (exact === undefined || buffer.length === exact));
    return buffer;
  };
  const key = crypto.hkdfSync('sha256', Buffer.from(values.MATRIX_AUTH_TOKEN, 'hex'),
    decode(envelope.salt, 16, 16), Buffer.from('matrix-funded-chat-repair-envelope-v1'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12, 12));
  decipher.setAAD(Buffer.from(JSON.stringify(aad)));
  decipher.setAuthTag(decode(envelope.tag, 16, 16));
  const plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext, 4096)), decipher.final()]);
  requireCondition(plaintext.length <= 4096 && hash(plaintext) === aad.requestSha256);
  const request = JSON.parse(plaintext.toString('utf8'));
  requireCondition(request.action === aad.action && JSON.stringify(request.identity) === JSON.stringify(aad.identity)
    && JSON.stringify(request.expectedFile) === JSON.stringify(aad.expectedFile));
  const helper = zlib.inflateSync(decode(transport.helper, 65_536), { maxOutputLength: 65_536 });
  requireCondition(hash(helper) === aad.helperSha256);
  const result = spawnSync(options.pythonPath ?? '/usr/bin/python3', ['-I', '-c', helper.toString('utf8')], {
    input: plaintext, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, shell: false,
  });
  requireCondition(result.status === 0);
  const receipt = JSON.parse(result.stdout);
  const rendered = JSON.stringify(receipt);
  requireCondition(!rendered.includes(values.MATRIX_AUTH_TOKEN)
    && !(typeof request.config?.runtimeToken === 'string' && rendered.includes(request.config.runtimeToken)));
  requireCondition(Object.keys(receipt).sort().join() === ['action', 'afterSha256', 'backup', 'beforeSha256', 'changed', 'restartRequired'].sort().join()
    && receipt.action === aad.action && typeof receipt.changed === 'boolean'
    && receipt.restartRequired === receipt.changed
    && /^[a-f0-9]{64}$/.test(receipt.beforeSha256) && /^[a-f0-9]{64}$/.test(receipt.afterSha256)
    && (receipt.backup === null || /^host\.env\.funded-[a-z0-9-]{1,48}\.json$/.test(receipt.backup)));
  return receipt;
}

/** Argument-vector request for the existing owner-authenticated terminal runner. */
export function buildFundedConfigRepairCommand(request, helperSource, authToken, now = Date.now()) {
  const transport = sealFundedConfigRepair(request, helperSource, authToken, now);
  const bootstrap = `const nodeRequire=require;${executeFundedConfigRepairBridge.toString()};try{process.stdout.write(JSON.stringify(executeFundedConfigRepairBridge(JSON.parse(Buffer.from(process.argv.slice(2).join(''),'base64').toString('utf8'))))+'\\n')}catch{process.stderr.write('{"error":"transport_failed"}\\n');process.exit(1)}`;
  const compressedBootstrap = deflateSync(Buffer.from(bootstrap)).toString('base64');
  const loader = "require('node:vm').runInThisContext(require('node:zlib').inflateSync(Buffer.from(process.argv[1],'base64'),{maxOutputLength:32768}).toString('utf8'))";
  const encoded = Buffer.from(JSON.stringify(transport)).toString('base64');
  const chunks = encoded.match(/.{1,4096}/g) ?? [];
  const command = ['/usr/bin/sudo', '-n', '/opt/matrix/runtime/node/bin/node', '-e', loader, '--', compressedBootstrap, ...chunks];
  if (command.length > 64 || command.some(arg => arg.length > 4096)
    || Buffer.byteLength(JSON.stringify({ command, timeoutMs: 15_000 })) > 16_384) {
    throw new Error('Repair transport exceeds terminal limits');
  }
  return command;
}
