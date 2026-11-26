/** Task-owned pr-3482 operator helper. It never provisions, registers or applies anything. */
import { readFile, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { parseDocument, stringify } from 'yaml';
const COLLECTOR = '/usr/local/sbin/matrix-preview-bootstrap-diag';
const USER = 'matrix-preview-diag';
const MAX_OUTPUT = 96 * 1024;
const NAME = /^matrix-preview-diag-[a-f0-9]{16,64}-[0-9]{13}\.json$/;

function identity(input, now = new Date()) {
  if (input.provisioningClass !== 'preview' || input.handle !== 'pr-3482' || input.runtimeSlot !== 'pr-3482'
    || !/^user_[A-Za-z0-9_-]{1,123}$/.test(input.ownerId) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.machineId)
    || !/^[a-f0-9]{16,64}$/.test(input.attemptId)) throw new Error('Exact task Preview identity required');
  const expiresAt = Math.floor(Date.parse(input.expiresAt) / 1000), issuedAt = Math.floor(+now / 1000);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt > issuedAt + 21600) throw new Error('Bounded diagnostic expiry required');
  return { provisioningClass: input.provisioningClass, handle: input.handle, runtimeSlot: input.runtimeSlot, ownerId: input.ownerId,
    machineId: input.machineId, attemptId: input.attemptId, issuedAt, expiresAt };
}
function publicKey(value) {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [A-Za-z0-9_.@:-]{1,128})?$/.exec(value ?? '');
  const bytes = match && Buffer.from(match[1], 'base64');
  if (!bytes || bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 || bytes.subarray(4, 15).toString() !== 'ssh-ed25519'
    || bytes.readUInt32BE(15) !== 32 || bytes.toString('base64') !== match[1]) throw new Error('An ed25519 public key is required');
  return `ssh-ed25519 ${match[1]}`;
}
function envValues(text) {
  return Object.fromEntries(text.split('\n').filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
}
export async function preparePreviewBootstrapDiagnostics(cloudInit, options) {
  const guard = identity(options, options.now), key = publicKey(options.publicKey);
  if (typeof cloudInit !== 'string' || Buffer.byteLength(cloudInit) > 128 * 1024 || !cloudInit.startsWith('#cloud-config\n')) throw new Error('Trusted rendered cloud-config required');
  if (cloudInit.includes(key.split(' ')[1])) throw new Error('Diagnostic key already present in rendered template');
  const document = parseDocument(cloudInit, { uniqueKeys: true, maxAliasCount: 0 });
  if (document.errors.length) throw new Error('Invalid cloud-config');
  const config = document.toJS({ maxAliasCount: 0 });
  if (!Array.isArray(config.write_files) || !Array.isArray(config.users) || !Array.isArray(config.runcmd)) throw new Error('Canonical cloud-config required');
  const hosts = config.write_files.filter(file => file.path === '/opt/matrix/env/host.env');
  if (hosts.length !== 1 || typeof hosts[0].content !== 'string' || hosts[0].encoding || hosts[0].defer) throw new Error('Rendered host identity required');
  const values = envValues(hosts[0].content);
  for (const [field, value] of Object.entries({ MATRIX_HANDLE: guard.handle, MATRIX_RUNTIME_SLOT: guard.runtimeSlot, MATRIX_CLERK_USER_ID: guard.ownerId, MATRIX_MACHINE_ID: guard.machineId, MATRIX_PREVIEW_RUNTIME: 'true' })) {
    if (values[field] !== value) throw new Error('Rendered Preview identity mismatch');
  }
  if (config.users.some(user => user.name === USER) || config.write_files.some(file => [COLLECTOR, '/etc/matrix-preview-bootstrap-diag.json', '/etc/sudoers.d/matrix-preview-diag'].includes(file.path))) throw new Error('Diagnostic injection already present');
  if (config.write_files.some(file => file.path?.startsWith('/usr/local/lib/matrix-preview-diag/'))) throw new Error('Diagnostic script path collision');
  const collector = await readFile(new URL('./task-preview-bootstrap-collector.py', import.meta.url), 'utf8');
  config.users.push({ name: USER, lock_passwd: true, shell: '/bin/sh', homedir: '/var/lib/matrix-preview-diag',
    ssh_authorized_keys: [`no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc,command="/usr/bin/sudo -n -- ${COLLECTOR}" ${key}`] });
  config.write_files.unshift({ path: COLLECTOR, owner: 'root:root', permissions: '0700', defer: false, content: collector },
    { path: '/etc/matrix-preview-bootstrap-diag.json', owner: 'root:root', permissions: '0600', defer: false, content: JSON.stringify(guard) },
    { path: '/etc/sudoers.d/matrix-preview-diag', owner: 'root:root', permissions: '0440', defer: false, content: `${USER} ALL=(root) NOPASSWD: ${COLLECTOR}\n` });
  // Move only large literal scripts into non-deferred root files. Dot-source
  // preserves the original runcmd shell, variables, options and failure behavior.
  // The trusted script bytes are unchanged; no separate shell/process is added.
  config.runcmd = config.runcmd.map((command, index) => {
    if (typeof command !== 'string' || Buffer.byteLength(command) <= 512) return command;
    const path = `/usr/local/lib/matrix-preview-diag/runcmd-${index}.sh`;
    config.write_files.push({ path, owner: 'root:root', permissions: '0600', defer: false, content: command });
    return `. ${path}`;
  });
  // Cloud-init's documented gz+b64 encoding preserves exact decoded bytes and
  // keeps the rendered payload under Hetzner's 32KiB user_data limit.
  for (const file of config.write_files) if (!file.encoding && typeof file.content === 'string' && Buffer.byteLength(file.content) > 512) {
    file.content = gzipSync(Buffer.from(file.content)).toString('base64'); file.encoding = 'gz+b64';
  }
  const result = '#cloud-config\n' + stringify(config, { lineWidth: 0 });
  if (Buffer.byteLength(result) > 32768) throw new Error('Diagnostic user-data exceeds provider limit');
  return result;
}

async function privateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid?.() || info.size > 65536) throw new Error('Private regular operator file required');
}
export async function savePreviewDiagnostic(directory, expected, data, now = Date.now()) {
  const {attemptId}=expected;
  if (!/^[a-f0-9]{16,64}$/.test(attemptId) || Buffer.byteLength(data) > MAX_OUTPUT) throw new Error('Bounded diagnostic result required');
  const parsed = JSON.parse(data);
  const fields=['ownerId','machineId','handle','runtimeSlot','provisioningClass'];
  const allowed=['version','attemptId','identityMatched','identityStage','identity','sections','truncated'];
  const names=['cloud-init-status','bootstrap-log','service-state','service-journal'];
  if (Object.keys(parsed).some(key=>!allowed.includes(key)) || parsed.version !== 1 || parsed.attemptId !== attemptId || parsed.identityMatched !== true
    || !parsed.identity || fields.some(key=>parsed.identity[key]!==expected[key]) || Object.keys(parsed.identity).some(key=>!fields.includes(key))
    || !['host_env','rendered_guard_only'].includes(parsed.identityStage) || !Array.isArray(parsed.sections) || parsed.sections.length!==4
    || parsed.sections.some((section,index)=>section.name!==names[index] || !['ok','failed','timeout','truncated','unavailable'].includes(section.status)
      || !(section.exitCode===null || Number.isInteger(section.exitCode)&&section.exitCode>=-255&&section.exitCode<=255)
      || typeof section.output!=='string' || Buffer.byteLength(section.output)>16384 || Object.keys(section).some(key=>!['name','status','exitCode','output'].includes(key)))) throw new Error('Diagnostic identity mismatch');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.mode & 0o077 || dir.uid !== process.getuid?.()) throw new Error('Private output directory required');
  const retained = []; let scanned=0;
  for await (const entry of await opendir(directory)) {
    if(++scanned>256)throw new Error('Diagnostic directory capacity exceeded');
    if (!NAME.test(entry.name)) continue;
    if (retained.length >= 64) throw new Error('Diagnostic retention capacity exceeded');
    const path = join(directory, entry.name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) continue;
    if (now - info.mtimeMs > 86400000) await unlink(path); else retained.push({ path, time: info.mtimeMs });
  }
  retained.sort((a, b) => b.time - a.time);
  for (const file of retained.slice(7)) await unlink(file.path);
  const path = join(directory, `matrix-preview-diag-${attemptId}-${now}.json`);
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(parsed)); } finally { await file.close(); }
  return path;
}

export async function collectPreviewBootstrapDiagnostics(options) {
  const guard = identity(options, options.now);
  if (isIP(options.host) !== 4 || /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(options.host)) throw new Error('Verified public guest IPv4 required');
  await privateFile(options.privateKeyPath); await privateFile(options.knownHostsPath);
  const bytes = await new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${options.knownHostsPath}`, '-o', 'IdentitiesOnly=yes', '-i', options.privateKeyPath, `${USER}@${options.host}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, finished = false, failure; let kill;
    const timer = setTimeout(() => { failure = new Error('Diagnostic SSH timed out'); child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 250); }, Math.min(20000, Math.max(1, options.timeoutMs ?? 20000)));
    child.stdout.on('data', chunk => { if (finished || failure) return; size += chunk.length; if (size > MAX_OUTPUT) { failure = new Error('Diagnostic SSH output exceeded cap'); child.kill('SIGKILL'); } else chunks.push(chunk); });
    child.once('error', () => { finished = true; clearTimeout(timer); clearTimeout(kill); reject(new Error('Diagnostic SSH unavailable')); });
    child.once('close', code => { finished = true; clearTimeout(timer); clearTimeout(kill); if (failure || code !== 0) reject(failure ?? new Error('Diagnostic SSH failed')); else resolve(Buffer.concat(chunks).toString('utf8')); });
  });
  return savePreviewDiagnostic(options.outputDirectory, guard, bytes);
}
