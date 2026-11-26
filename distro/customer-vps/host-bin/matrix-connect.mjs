#!/usr/bin/env node
// Spec 2707: connect this machine to a Matrix account as an owned computer.
// Subcommands: enroll, heartbeat, disconnect, status. No npm dependencies.

import { execFile as execFileCb, spawn } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { arch as osArch, hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCb);

export const OWNED_MACHINE_ENV_KEYS = [
  'MATRIX_MACHINE_ID', 'MATRIX_CLERK_USER_ID', 'MATRIX_HANDLE', 'MATRIX_RUNTIME_SLOT',
  'MATRIX_RUNTIME_TOKEN_EPOCH', 'MATRIX_SUBSTRATE', 'MATRIX_UPDATE_CHANNEL', 'PLATFORM_INTERNAL_URL',
  'UPGRADE_TOKEN', 'MATRIX_AUTH_TOKEN', 'MATRIX_CODE_PROXY_TOKEN', 'MATRIX_SYNC_RUNTIME_TOKEN',
  'MATRIX_FUNDED_AI_RUNTIME_TOKEN', 'MATRIX_FUNDED_AI_ENABLED', 'MATRIX_FUNDED_AI_RELAY_URL',
  'MATRIX_PLATFORM_SPEECH_ENABLED', 'MATRIX_PLATFORM_SPEECH_ORIGIN', 'MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN',
];
const ENV_VALUE = /^[^\0\r\n'"\\$`]{0,2048}$/;
const TUNNEL_TOKEN = /^[A-Za-z0-9_=+/.-]{1,4096}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT = /^owned-[0-9a-f]{8}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const API_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;
const MAX_JSON_BYTES = 64 * 1024;
export const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;
export const TUNNEL_LISTEN = '127.0.0.1:8790';
export const UNITS = ['matrix-connect.service', 'matrix-cloudflared.service'];

export const EXIT = { ok: 0, usage: 1, denied: 2, unavailable: 3, revoked: 4 };

export function paths(env = process.env) {
  const etc = env.MATRIX_CONNECT_ETC_DIR ?? '/etc/matrix';
  const envDir = env.MATRIX_CONNECT_ENV_DIR ?? '/opt/matrix/env';
  return {
    machineEnv: join(etc, 'owned-machine.env'),
    tunnelToken: join(etc, 'cloudflared.token'),
    // Next to host.env so the update poller (matrix-sync-agent, group matrix) can read it;
    // /etc/matrix is root-only. The poller skips auto-apply while it exists.
    autoUpdatesDisabled: join(envDir, 'auto-updates-disabled'),
    hostEnv: env.MATRIX_CONNECT_HOST_ENV ?? '/opt/matrix/env/host.env',
    envDir,
    state: join(env.MATRIX_CONNECT_STATE_DIR ?? '/var/lib/matrix-connect', 'state.json'),
    nginxSite: env.MATRIX_CONNECT_NGINX_SITE ?? '/etc/nginx/sites-available/matrix-owned-tunnel',
    nginxEnabled: env.MATRIX_CONNECT_NGINX_ENABLED ?? '/etc/nginx/sites-enabled/matrix-owned-tunnel',
    unitSrc: env.MATRIX_CONNECT_UNIT_SRC ?? '/opt/matrix/systemd',
    unitDst: env.MATRIX_CONNECT_UNIT_DST ?? '/etc/systemd/system',
    bundleVersion: env.MATRIX_CONNECT_BUNDLE_VERSION_FILE ?? '/opt/matrix/app/BUNDLE_VERSION',
    releaseJson: env.MATRIX_CONNECT_RELEASE_FILE ?? '/opt/matrix/release.json',
    osRelease: env.MATRIX_CONNECT_OS_RELEASE ?? '/etc/os-release',
  };
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function warn(message) {
  process.stderr.write(`matrix-connect: ${message}\n`);
}

function errorName(err) {
  return err instanceof Error ? err.name : 'UnknownError';
}

// ---------------------------------------------------------------- validation

export function validateMachineEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('invalid machine environment');
  const keys = Object.keys(env);
  if (keys.length !== OWNED_MACHINE_ENV_KEYS.length || !OWNED_MACHINE_ENV_KEYS.every((key) => keys.includes(key))) {
    throw new Error('invalid machine environment');
  }
  for (const key of OWNED_MACHINE_ENV_KEYS) {
    if (typeof env[key] !== 'string' || !ENV_VALUE.test(env[key])) throw new Error('invalid machine environment');
  }
  if (!UUID.test(env.MATRIX_MACHINE_ID) || !SLOT.test(env.MATRIX_RUNTIME_SLOT)
    || !/^[1-9][0-9]{0,9}$/.test(env.MATRIX_RUNTIME_TOKEN_EPOCH) || env.UPGRADE_TOKEN.length < 32) {
    throw new Error('invalid machine environment');
  }
  for (const key of ['PLATFORM_INTERNAL_URL']) {
    if (!env[key].startsWith('https://')) throw new Error('invalid machine environment');
  }
  return env;
}

export function validateTunnelToken(token) {
  if (typeof token !== 'string' || !TUNNEL_TOKEN.test(token)) throw new Error('invalid tunnel token');
  return token;
}

export function parsePlatformUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (err) {
    if (err instanceof TypeError) throw new Error('platform URL must be https');
    throw err;
  }
  const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) {
    throw new Error('platform URL must be https');
  }
  return url.origin;
}

// ---------------------------------------------------------------- files

async function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Atomic write: temp file in the same directory, fsync, chmod/chown, rename.
 * Any failure after the temp file exists removes it, so a full disk or a
 * crash-looping caller never accumulates partial secret files.
 */
export async function writeFileAtomic(path, content, { mode, owner } = { mode: 0o600 }) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle = await open(tmp, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(tmp, mode);
    if (owner && await isRoot()) await chown(tmp, owner.uid, owner.gid);
    await rename(tmp, path);
  } catch (err) {
    warn(`write of ${path} failed (${errorName(err)})`);
    if (handle) {
      try { await handle.close(); } catch (closeErr) { warn(`temp close failed (${errorName(closeErr)})`); }
    }
    try { await rm(tmp, { force: true }); } catch (cleanupErr) { warn(`temp cleanup failed (${errorName(cleanupErr)})`); }
    throw err;
  }
}

export function serializeEnv(env) {
  return `${OWNED_MACHINE_ENV_KEYS.map((key) => `${key}=${env[key]}`).join('\n')}\n`;
}

export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/**
 * Replaces owned-machine keys in host.env and keeps every other line. The
 * gateway's owner (MATRIX_USER_ID) becomes the enrolled account, replacing the
 * installer's standalone self-host id, so platform-routed requests from the
 * owner reach Terminal and other owner-only routes.
 */
export function mergeHostEnv(existing, env, platformUrl) {
  // The gateway trusts the enrolled platform's app origin for the browser requests it
  // forwards, next to the installer's own origin (for example the tailnet URL).
  const platformOrigin = platformUrl ? parsePlatformUrl(platformUrl) : null;
  const replaced = [...OWNED_MACHINE_ENV_KEYS, 'MATRIX_USER_ID', ...(platformOrigin ? ['MATRIX_PUBLIC_APP_URL'] : [])];
  const keep = existing.split('\n').filter((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    return !(match && replaced.includes(match[1]));
  });
  while (keep.length && keep.at(-1) === '') keep.pop();
  return `${[
    ...keep,
    ...OWNED_MACHINE_ENV_KEYS.map((key) => `${key}=${env[key]}`),
    `MATRIX_USER_ID=${env.MATRIX_CLERK_USER_ID}`,
    ...(platformOrigin ? [`MATRIX_PUBLIC_APP_URL=${platformOrigin}`] : []),
  ].join('\n')}\n`;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function matrixGroup() {
  try {
    const { stdout } = await execFile('getent', ['group', 'matrix'], { timeout: 5_000 });
    const gid = Number(stdout.split(':')[2]);
    return Number.isInteger(gid) ? gid : null;
  } catch (err) {
    warn(`matrix group lookup failed (${errorName(err)})`);
    return null;
  }
}

export function nginxSite(env) {
  // Loopback only: cloudflared is the sole client. Requests must carry the
  // machine's platform bearer; the gateway verifies it again.
  return `# Managed by matrix-connect (spec 2707). Do not edit.
server {
  listen ${TUNNEL_LISTEN};
  server_name _;
  client_max_body_size 21m;

  set $matrix_owned_ok 0;
  if ($http_authorization = "Bearer ${env.MATRIX_AUTH_TOKEN}") { set $matrix_owned_ok 1; }
  if ($http_x_matrix_code_proxy_token = "${env.MATRIX_CODE_PROXY_TOKEN}") { set $matrix_owned_ok 1; }
  if ($matrix_owned_ok = 0) { return 401; }

  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $http_x_forwarded_host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header X-Real-IP $remote_addr;

  location ~ "^/api/apps/[a-z0-9][a-z0-9-]{0,63}/site$" {
    proxy_read_timeout 300s;
    proxy_pass http://127.0.0.1:4000;
  }
  location /api/ { proxy_read_timeout 300s; proxy_pass http://127.0.0.1:4000; }
  location /files/ { proxy_pass http://127.0.0.1:4000; }
  location /icons/ { proxy_pass http://127.0.0.1:4000; }
  location /apps/ { proxy_pass http://127.0.0.1:4000; }
  location /health { proxy_pass http://127.0.0.1:4000; }
  location /ws {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_pass http://127.0.0.1:4000;
  }
  location / {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://127.0.0.1:3000;
  }
}
`;
}

export async function writeMachineFiles(env, tunnelToken, p = paths(), platformUrl = undefined) {
  validateMachineEnv(env);
  validateTunnelToken(tunnelToken);
  const root = { uid: 0, gid: 0 };
  await writeFileAtomic(p.machineEnv, serializeEnv(env), { mode: 0o600, owner: root });
  await writeFileAtomic(p.tunnelToken, `${tunnelToken}\n`, { mode: 0o600, owner: root });
  const existing = (await readText(p.hostEnv)) ?? '';
  const gid = await isRoot() ? await matrixGroup() : null;
  await writeFileAtomic(p.hostEnv, mergeHostEnv(existing, env, platformUrl), { mode: 0o640, owner: gid === null ? undefined : { uid: 0, gid } });
  // The port-80 self-host server injects the gateway bearer; keep it in step.
  await writeFileAtomic(join(p.envDir, 'gateway-auth-token.conf'),
    `proxy_set_header Authorization "Bearer ${env.MATRIX_AUTH_TOKEN}";\n`, { mode: 0o600, owner: root });
  await writeFileAtomic(join(p.envDir, 'code-proxy-token.conf'),
    `proxy_set_header X-Matrix-Code-Proxy-Token "${env.MATRIX_CODE_PROXY_TOKEN}";\n`, { mode: 0o600, owner: root });
  await writeFileAtomic(p.nginxSite, nginxSite(env), { mode: 0o600, owner: root });
}

async function readState(p) {
  const text = await readText(p.state);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

async function writeState(p, state) {
  await writeFileAtomic(p.state, `${JSON.stringify(state)}\n`, { mode: 0o600, owner: { uid: 0, gid: 0 } });
}

// ---------------------------------------------------------------- system

async function systemctl(args, env = process.env) {
  const bin = env.MATRIX_CONNECT_SYSTEMCTL ?? 'systemctl';
  try {
    await execFile(bin, args, { timeout: 60_000 });
    return true;
  } catch (err) {
    warn(`systemctl ${args[0]} failed (${errorName(err)})`);
    return false;
  }
}

export class ActivationError extends Error {
  constructor(step) {
    super(`activation failed at ${step}`);
    this.name = 'ActivationError';
    this.step = step;
  }
}

/** Installs units and starts services. Throws ActivationError naming the first failed step. */
async function activate(p, env = process.env) {
  for (const unit of UNITS) {
    const src = join(p.unitSrc, unit);
    if (await readText(src) !== null) await copyFile(src, join(p.unitDst, unit));
  }
  try {
    const { symlink, lstat } = await import('node:fs/promises');
    try {
      await lstat(p.nginxEnabled);
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) throw err;
      await symlink(p.nginxSite, p.nginxEnabled);
    }
  } catch (err) {
    warn(`nginx site link failed (${errorName(err)})`);
    throw new ActivationError('the nginx tunnel site');
  }
  const steps = [
    [['daemon-reload'], 'systemd'],
    [['reload-or-restart', 'nginx'], 'nginx'],
    [['restart', 'matrix-gateway', 'matrix-shell', 'matrix-code'], 'the Matrix services'],
    [['enable', '--now', ...UNITS], 'matrix-connect.service'],
    [['restart', 'matrix-cloudflared'], 'matrix-cloudflared.service'],
  ];
  for (const [args, step] of steps) {
    if (!(await systemctl(args, env))) throw new ActivationError(step);
  }
}

async function activateOrExplain(p, env) {
  try {
    await activate(p, env);
    return true;
  } catch (err) {
    if (!(err instanceof ActivationError)) throw err;
    warn(`could not start ${err.step}. Credentials are saved; run \`sudo matrix-connect refresh\` after fixing ${err.step}.`);
    return false;
  }
}

// ---------------------------------------------------------------- http

/**
 * Reads at most `max` bytes, cancelling the stream as soon as it grows past
 * the cap, so a response without Content-Length cannot be buffered whole.
 * The request's AbortSignal still bounds the time spent reading.
 */
async function readBoundedBody(response, max) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Error('response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function requestJson(url, { method = 'POST', body, headers = {}, timeoutMs = API_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new Error('response too large');
  }
  const text = await readBoundedBody(response, MAX_JSON_BYTES);
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return { status: response.status, json };
}

async function readOsName(p) {
  const text = (await readText(p.osRelease)) ?? '';
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(text)?.[1] ?? 'Linux';
  return pretty.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64) || 'Linux';
}

export function reportArch(value = osArch()) {
  if (value === 'x64') return 'x86_64';
  if (value === 'arm64') return 'arm64';
  throw new Error('unsupported architecture');
}

async function agentVersion(p) {
  const raw = ((await readText(p.bundleVersion)) ?? '').trim();
  if (/^[0-9A-Za-z._+-]{1,64}$/.test(raw)) return raw;
  // Bundles record their version in release.json; BUNDLE_VERSION is optional.
  let release;
  try {
    release = JSON.parse((await readText(p.releaseJson)) ?? 'null');
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  const version = typeof release?.version === 'string' ? release.version.trim() : '';
  return /^[0-9A-Za-z._+-]{1,64}$/.test(version) ? version : 'unknown';
}

function machineHeaders(env) {
  return { authorization: `Bearer ${env.UPGRADE_TOKEN}`, 'x-matrix-machine-id': env.MATRIX_MACHINE_ID };
}

// ---------------------------------------------------------------- commands

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform' || arg === '--platform-url') out.platform = argv[++i];
    else throw new Error(`unknown option ${arg.slice(0, 40)}`);
  }
  return out;
}

function openBrowser(url, env) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return;
  try {
    const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', (err) => warn(`could not open a browser (${errorName(err)})`));
    child.unref();
  } catch (err) {
    warn(`could not open a browser (${errorName(err)})`);
  }
}

export async function enroll(argv, env = process.env) {
  const args = parseArgs(argv);
  const p = paths(env);
  const platform = parsePlatformUrl(args.platform ?? env.MATRIX_PLATFORM_URL ?? 'https://app.matrix-os.com');
  const hostname = osHostname().replace(/[^\x21-\x7e]/g, '').slice(0, 253) || 'matrix-computer';
  const report = {
    hostname: PRINTABLE.test(hostname) ? hostname : 'matrix-computer',
    os: await readOsName(p),
    arch: reportArch(env.MATRIX_CONNECT_ARCH ?? osArch()),
    agentVersion: await agentVersion(p),
  };
  let start;
  try {
    start = await requestJson(`${platform}/api/machines/enroll/start`, { body: report });
  } catch (err) {
    warn(`platform unavailable (${errorName(err)})`);
    return EXIT.unavailable;
  }
  if (start.status === 429) { warn('too many connection attempts, try again in an hour'); return EXIT.unavailable; }
  const s = start.json;
  if (start.status !== 200 || !s || !DEVICE_CODE.test(s.deviceCode ?? '') || !USER_CODE.test(s.userCode ?? '')) {
    warn('platform unavailable');
    return EXIT.unavailable;
  }
  // The approval link is built from the platform this machine chose, never
  // taken from the response, so the printed URL always names that platform.
  const approvalUrl = `${platform}/connect?code=${encodeURIComponent(s.userCode)}`;
  log(`Open ${approvalUrl} and enter ${s.userCode}`);
  log('Waiting for approval...');
  openBrowser(approvalUrl, env);
  let intervalMs = Math.max(1, Math.min(60, Number(s.interval) || 5)) * 1000;
  const deadline = Date.now() + Math.max(60, Math.min(3600, Number(s.expiresIn) || 900)) * 1000;
  const sleep = env.MATRIX_CONNECT_TEST_FAST === '1' ? () => delay(10) : (ms) => delay(ms);
  let failures = 0;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let poll;
    try {
      poll = await requestJson(`${platform}/api/machines/enroll/poll`, { body: { deviceCode: s.deviceCode } });
    } catch (err) {
      failures += 1;
      warn(`poll failed (${errorName(err)})`);
      if (failures >= 10) return EXIT.unavailable;
      continue;
    }
    if (poll.status >= 500) { failures += 1; if (failures >= 10) return EXIT.unavailable; continue; }
    failures = 0;
    const status = poll.json?.status;
    if (status === 'pending') continue;
    if (status === 'slow_down') { intervalMs = Math.min(intervalMs + 5_000, 60_000); continue; }
    if (status === 'expired') { warn('the code expired, run matrix-connect enroll again'); return EXIT.denied; }
    if (status === 'denied') { warn('the connection was denied'); return EXIT.denied; }
    if (status === 'ready') {
      try {
        validateMachineEnv(poll.json.env);
        validateTunnelToken(poll.json.tunnelToken);
      } catch (err) {
        warn(`platform sent an invalid answer (${errorName(err)})`);
        return EXIT.unavailable;
      }
      await writeMachineFiles(poll.json.env, poll.json.tunnelToken, p, platform);
      await writeState(p, {
        platformUrl: platform,
        machineId: poll.json.env.MATRIX_MACHINE_ID,
        handle: poll.json.env.MATRIX_HANDLE,
        runtimeSlot: poll.json.env.MATRIX_RUNTIME_SLOT,
        connectedAt: new Date().toISOString(),
        lastHeartbeat: null,
      });
      if (env.MATRIX_CONNECT_NO_ACTIVATE !== '1' && !(await activateOrExplain(p, env))) return EXIT.unavailable;
      log(`Connected. Open ${platform}`);
      return EXIT.ok;
    }
    warn('platform sent an unexpected answer');
  }
  warn('the code expired, run matrix-connect enroll again');
  return EXIT.denied;
}

async function loadMachine(p) {
  const text = await readText(p.machineEnv);
  if (!text) return null;
  const env = parseEnvFile(text);
  try {
    return validateMachineEnv(Object.fromEntries(OWNED_MACHINE_ENV_KEYS.map((key) => [key, env[key]])));
  } catch (err) {
    warn(`machine environment unreadable (${errorName(err)})`);
    return null;
  }
}

async function gatewayHealthy(env) {
  try {
    const response = await fetch(env.MATRIX_CONNECT_HEALTH_URL ?? 'http://127.0.0.1:4000/health', {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'error',
    });
    await response.body?.cancel();
    return response.ok;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

async function diskFreeBytes() {
  try {
    const { statfs } = await import('node:fs/promises');
    const stats = await statfs('/');
    return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, stats.bavail * stats.bsize));
  } catch (err) {
    warn(`disk stat failed (${errorName(err)})`);
    return 0;
  }
}

/** One heartbeat. Returns 'ok', 'revoked' or 'error'. */
export async function heartbeatOnce(env = process.env, p = paths(env)) {
  const machine = await loadMachine(p);
  const state = await readState(p);
  if (!machine || !state.platformUrl) return 'revoked';
  const platform = parsePlatformUrl(state.platformUrl);
  const body = {
    agentVersion: await agentVersion(p),
    uptimeSec: Math.floor(process.uptime()),
    diskFreeBytes: await diskFreeBytes(),
    gatewayHealthy: await gatewayHealthy(env),
  };
  let result;
  try {
    result = await requestJson(`${platform}/api/machines/heartbeat`, { body, headers: machineHeaders(machine) });
  } catch (err) {
    warn(`heartbeat failed (${errorName(err)})`);
    await writeState(p, { ...state, lastHeartbeat: { at: new Date().toISOString(), result: 'unreachable' } });
    return 'error';
  }
  if (result.status === 401) {
    await writeState(p, { ...state, lastHeartbeat: { at: new Date().toISOString(), result: 'revoked' } });
    return 'revoked';
  }
  if (result.status !== 200 || result.json?.status !== 'ok') {
    await writeState(p, { ...state, lastHeartbeat: { at: new Date().toISOString(), result: 'error' } });
    return 'error';
  }
  // A reissue stays pending until a new token is saved and the tunnel restarted:
  // the platform reports `ok` again once the replacement is ready, so the flag,
  // not the latest heartbeat, decides whether to keep asking.
  let pendingTunnelReissue = state.pendingTunnelReissue === true || result.json.tunnel === 'reissue';
  if (pendingTunnelReissue) {
    await writeState(p, { ...state, pendingTunnelReissue: true });
    try {
      const tunnel = await requestJson(`${platform}/api/machines/tunnel`, { headers: machineHeaders(machine) });
      if (tunnel.status === 200) {
        await writeFileAtomic(p.tunnelToken, `${validateTunnelToken(tunnel.json?.tunnelToken)}\n`, { mode: 0o600, owner: { uid: 0, gid: 0 } });
        if (await systemctl(['restart', 'matrix-cloudflared'], env)) pendingTunnelReissue = false;
      } else if (tunnel.status === 401) {
        return 'revoked';
      }
    } catch (err) {
      warn(`tunnel reissue failed (${errorName(err)})`);
    }
  }
  const autoSecurityUpdates = Boolean(result.json.autoSecurityUpdates);
  if (autoSecurityUpdates) await rm(p.autoUpdatesDisabled, { force: true });
  else {
    const gid = await isRoot() ? await matrixGroup() : null;
    await writeFileAtomic(p.autoUpdatesDisabled, 'off\n', { mode: 0o640, owner: gid === null ? undefined : { uid: 0, gid } });
  }
  await writeState(p, {
    ...state,
    pendingTunnelReissue,
    lastHeartbeat: { at: new Date().toISOString(), result: 'ok' },
    autoSecurityUpdates,
    backupsEnabled: Boolean(result.json.backupsEnabled),
  });
  return 'ok';
}

export async function heartbeatLoop(env = process.env) {
  const p = paths(env);
  const fast = env.MATRIX_CONNECT_TEST_FAST === '1';
  let backoff = HEARTBEAT_INTERVAL_MS;
  for (let i = 0; ; i += 1) {
    const outcome = await heartbeatOnce(env, p);
    if (outcome === 'revoked') {
      warn('this computer was removed from its Matrix account; stopping the tunnel');
      await systemctl(['stop', 'matrix-cloudflared'], env);
      return EXIT.revoked;
    }
    backoff = outcome === 'ok' ? HEARTBEAT_INTERVAL_MS : Math.min(backoff * 2, MAX_BACKOFF_MS);
    const jitter = Math.floor(Math.random() * 5_000);
    if (env.MATRIX_CONNECT_MAX_BEATS && i + 1 >= Number(env.MATRIX_CONNECT_MAX_BEATS)) return EXIT.ok;
    await delay(fast ? 10 : backoff + jitter);
  }
}

export async function disconnect(env = process.env) {
  const p = paths(env);
  const machine = await loadMachine(p);
  const state = await readState(p);
  if (machine && state.platformUrl) {
    try {
      const result = await requestJson(`${parsePlatformUrl(state.platformUrl)}/api/machines/self`, {
        method: 'DELETE', headers: machineHeaders(machine),
      });
      if (result.status !== 204 && result.status !== 401) warn('platform did not confirm removal; remove it in Settings too');
    } catch (err) {
      warn(`platform unreachable (${errorName(err)}); remove this computer in Settings too`);
    }
  }
  await systemctl(['disable', '--now', ...UNITS], env);
  await rm(p.machineEnv, { force: true });
  await rm(p.tunnelToken, { force: true });
  await rm(p.autoUpdatesDisabled, { force: true });
  await rm(p.nginxEnabled, { force: true });
  await systemctl(['reload-or-restart', 'nginx'], env);
  await writeState(p, { ...state, disconnectedAt: new Date().toISOString() });
  log('Disconnected. Your data stays on this computer.');
  return EXIT.ok;
}

/** Rewrites host.env, nginx and gateway includes from the stored machine files (after a reinstall). */
export async function refresh(env = process.env) {
  const p = paths(env);
  const machine = await loadMachine(p);
  const token = ((await readText(p.tunnelToken)) ?? '').trim();
  if (!machine || !token) {
    log('Not connected to a Matrix account.');
    return EXIT.ok;
  }
  const state = await readState(p);
  await writeMachineFiles(machine, token, p, state.platformUrl);
  if (env.MATRIX_CONNECT_NO_ACTIVATE !== '1' && !(await activateOrExplain(p, env))) return EXIT.unavailable;
  log('Connection settings refreshed.');
  return EXIT.ok;
}

export async function status(env = process.env) {
  const p = paths(env);
  const machine = await loadMachine(p);
  const state = await readState(p);
  if (!machine) {
    log('Not connected to a Matrix account.');
    return EXIT.ok;
  }
  const last = state.lastHeartbeat;
  const connected = last?.result === 'ok' && Date.now() - Date.parse(last.at) < 90_000;
  log(`Status: ${connected ? 'connected' : 'offline'}`);
  log(`Machine: ${machine.MATRIX_MACHINE_ID}`);
  log(`Handle: ${machine.MATRIX_HANDLE}`);
  log(`Slot: ${machine.MATRIX_RUNTIME_SLOT}`);
  log(`Last heartbeat: ${last ? `${last.at} (${last.result})` : 'never'}`);
  return EXIT.ok;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  try {
    if (command === 'enroll') return await enroll(rest, env);
    if (command === 'heartbeat') return await heartbeatLoop(env);
    if (command === 'disconnect') return await disconnect(env);
    if (command === 'status') return await status(env);
    if (command === 'refresh') return await refresh(env);
  } catch (err) {
    warn(`${command} failed (${errorName(err)}: ${err instanceof Error ? err.message.slice(0, 120) : ''})`);
    return EXIT.unavailable;
  }
  process.stderr.write('usage: matrix-connect enroll [--platform URL] | heartbeat | disconnect | status | refresh\n');
  return EXIT.usage;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
