#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';

const SYNC_JWT_AUDIENCE = 'matrix-os-sync';
const SYNC_JWT_ISSUER = 'matrix-os-platform';
const DEFAULT_WS_PATHS = ['/ws'];
const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function selectProbeMachine(fleet) {
  const machines = Array.isArray(fleet?.machines) ? fleet.machines : [];
  for (const machine of machines) {
    if (!isRecord(machine)) continue;
    if (machine.status !== 'running' || machine.healthy !== true) continue;
    if (
      typeof machine.handle !== 'string' ||
      !machine.handle ||
      typeof machine.clerkUserId !== 'string' ||
      !machine.clerkUserId
    ) {
      continue;
    }
    return {
      handle: machine.handle,
      clerkUserId: machine.clerkUserId,
      runtimeSlot: typeof machine.runtimeSlot === 'string' && machine.runtimeSlot
        ? machine.runtimeSlot
        : 'primary',
    };
  }
  return null;
}

export function buildProbeWebSocketUrl(platformPublicUrl, path, token) {
  const base = new URL(platformPublicUrl || 'https://app.matrix-os.com');
  if (base.protocol === 'https:') {
    base.protocol = 'wss:';
  } else if (base.protocol === 'http:') {
    base.protocol = 'ws:';
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, `${base.origin}/`);
  url.searchParams.set('token', token);
  return url;
}

export function redactProbeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', 'REDACTED');
    }
    return url.toString();
  } catch (err) {
    if (!(err instanceof TypeError)) {
      console.warn('[cloudflared-watchdog] Failed to redact malformed probe URL:', err instanceof Error ? err.message : String(err));
    }
    return '[invalid-url]';
  }
}

function classifyProbeFailureReason(reason) {
  if (typeof reason !== 'string' || !reason) return 'probe_failed';
  if (/^status_\d{3}$/.test(reason)) return reason;
  if (/^close_\d+$/.test(reason)) return reason;
  if (reason === 'timeout') return reason;
  return 'websocket_error';
}

export function buildPublicLiveRouteDiagnostic({ machine, results }) {
  const safeResults = Array.isArray(results) ? results : [];
  const failures = safeResults
    .filter((result) => result && result.ok !== true)
    .map((result) => ({
      path: typeof result.path === 'string' && result.path ? result.path : 'unknown',
      reason: classifyProbeFailureReason(result.reason),
    }));
  const probedPaths = safeResults
    .map((result) => (typeof result?.path === 'string' && result.path ? result.path : null))
    .filter((path) => path !== null);
  const runtimeSlot = typeof machine?.runtimeSlot === 'string' && machine.runtimeSlot ? machine.runtimeSlot : 'primary';

  return {
    version: 1,
    layer: failures.length > 0 ? 'public-route' : 'runtime-reachable',
    runtimeReachability: machine ? 'online' : 'unavailable',
    publicLiveRoute: failures.length > 0 ? 'unavailable' : 'online',
    runtimeSlot,
    probedPaths,
    failures,
  };
}

export function shouldRestartCloudflared(consecutiveFailures, threshold) {
  return consecutiveFailures >= Math.max(1, threshold);
}

function parseConfig(env = process.env) {
  const terminalSession = env.CLOUDFLARED_WATCHDOG_TERMINAL_SESSION || 'main';
  return {
    platformInternalUrl: env.PLATFORM_INTERNAL_URL || 'http://platform:9000',
    platformPublicUrl: env.PLATFORM_PUBLIC_URL || 'https://app.matrix-os.com',
    platformSecret: env.PLATFORM_SECRET || '',
    platformJwtSecret: env.PLATFORM_JWT_SECRET || '',
    intervalMs: toPositiveInt(env.CLOUDFLARED_WATCHDOG_INTERVAL_MS, 60_000),
    probeTimeoutMs: toPositiveInt(env.CLOUDFLARED_WATCHDOG_PROBE_TIMEOUT_MS, 10_000),
    failureThreshold: toPositiveInt(env.CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD, 3),
    restartCooldownMs: toPositiveInt(env.CLOUDFLARED_WATCHDOG_RESTART_COOLDOWN_MS, 300_000),
    dockerSocket: env.CLOUDFLARED_WATCHDOG_DOCKER_SOCKET || DEFAULT_DOCKER_SOCKET,
    containerName: env.CLOUDFLARED_WATCHDOG_CONTAINER || '',
    wsPaths: [
      ...DEFAULT_WS_PATHS,
      `/ws/terminal/session?session=${encodeURIComponent(terminalSession)}&fromSeq=0`,
    ],
  };
}

async function fetchFleet(config) {
  if (!config.platformSecret) {
    throw new Error('PLATFORM_SECRET is required for websocket watchdog fleet probes');
  }
  const url = new URL('/vps/fleet', config.platformInternalUrl);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.platformSecret}`,
    },
    signal: AbortSignal.timeout(config.probeTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`fleet probe failed with status ${response.status}`);
  }
  return response.json();
}

async function issueProbeToken(config, machine) {
  if (config.platformJwtSecret.length < 32) {
    throw new Error('PLATFORM_JWT_SECRET must be at least 32 characters for websocket watchdog probes');
  }
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: machine.clerkUserId,
    handle: machine.handle,
    gateway_url: config.platformPublicUrl,
    runtime_slot: machine.runtimeSlot,
    aud: SYNC_JWT_AUDIENCE,
    iat: now,
    exp: now + 120,
    iss: SYNC_JWT_ISSUER,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(SYNC_JWT_AUDIENCE)
    .sign(new TextEncoder().encode(config.platformJwtSecret));
}

async function probeWebSocket(url, timeoutMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs + 1_000);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    ws.once('open', () => {
      ws.close();
      finish({ ok: true, reason: 'open' });
    });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      finish({ ok: false, reason: `status_${response.statusCode}` });
    });
    ws.once('error', (err) => {
      finish({ ok: false, reason: err instanceof Error ? err.message : 'websocket_error' });
    });
    ws.once('close', (code) => {
      finish({ ok: false, reason: `close_${code}` });
    });
  });
}

async function dockerRequest(config, method, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: config.dockerSocket,
      path: requestPath,
      method,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(body);
          return;
        }
        reject(new Error(`Docker API ${method} ${requestPath} failed with status ${response.statusCode}`));
      });
    });
    request.setTimeout(config.probeTimeoutMs, () => {
      request.destroy(new Error('Docker API request timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function dockerJson(config, requestPath) {
  const body = await dockerRequest(config, 'GET', requestPath);
  return body ? JSON.parse(body) : null;
}

async function resolveCloudflaredContainer(config) {
  if (config.containerName) return config.containerName;

  let projectLabel = '';
  try {
    const self = await dockerJson(config, `/containers/${encodeURIComponent(os.hostname())}/json`);
    projectLabel = self?.Config?.Labels?.['com.docker.compose.project'] || '';
  } catch (err) {
    console.warn('[cloudflared-watchdog] Could not inspect watchdog container:', err instanceof Error ? err.message : String(err));
  }

  const labels = ['com.docker.compose.service=cloudflared'];
  if (projectLabel) labels.push(`com.docker.compose.project=${projectLabel}`);
  const filters = encodeURIComponent(JSON.stringify({ label: labels }));
  const containers = await dockerJson(config, `/containers/json?all=false&filters=${filters}`);
  if (!Array.isArray(containers) || containers.length === 0 || typeof containers[0]?.Id !== 'string') {
    throw new Error('Could not find running cloudflared container by Docker Compose labels');
  }
  return containers[0].Id;
}

async function restartCloudflared(config) {
  const container = await resolveCloudflaredContainer(config);
  await dockerRequest(config, 'POST', `/containers/${encodeURIComponent(container)}/restart?t=10`);
  console.warn('[cloudflared-watchdog] Restarted cloudflared after repeated public websocket probe failures');
}

async function runProbeCycle(config) {
  const fleet = await fetchFleet(config);
  const machine = selectProbeMachine(fleet);
  if (!machine) {
    console.warn('[cloudflared-watchdog] No healthy running customer machine available; skipping websocket probe cycle');
    return true;
  }
  const token = await issueProbeToken(config, machine);
  const results = [];
  for (const path of config.wsPaths) {
    const url = buildProbeWebSocketUrl(config.platformPublicUrl, path, token);
    const result = await probeWebSocket(url, config.probeTimeoutMs);
    results.push({ path, url: url.toString(), ...result });
  }
  const failures = results.filter((result) => !result.ok);
  for (const failure of failures) {
    console.warn(
      `[cloudflared-watchdog] Public websocket probe failed path=${failure.path} reason=${failure.reason} url=${redactProbeUrl(failure.url)}`,
    );
  }
  const diagnostic = buildPublicLiveRouteDiagnostic({ machine, results });
  if (diagnostic.layer === 'public-route') {
    console.warn(`[cloudflared-watchdog] Public live-route diagnostic ${JSON.stringify(diagnostic)}`);
  }
  return failures.length === 0;
}

async function runLoop(config) {
  let consecutiveFailures = 0;
  let lastRestartAt = 0;

  for (;;) {
    try {
      const ok = await runProbeCycle(config);
      consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
    } catch (err) {
      consecutiveFailures = 0;
      console.warn(
        '[cloudflared-watchdog] Probe cycle could not complete; not restarting cloudflared without public websocket failure evidence:',
        err instanceof Error ? err.message : String(err),
      );
    }

    if (shouldRestartCloudflared(consecutiveFailures, config.failureThreshold)) {
      const now = Date.now();
      if (now - lastRestartAt >= config.restartCooldownMs) {
        await restartCloudflared(config);
        lastRestartAt = now;
        consecutiveFailures = 0;
      } else {
        console.warn('[cloudflared-watchdog] Restart threshold reached during cooldown; leaving cloudflared running');
      }
    }

    await sleep(config.intervalMs);
  }
}

async function assertDockerSocketReachable(config) {
  await dockerRequest(config, 'GET', '/_ping');
}

async function main() {
  const config = parseConfig();
  await assertDockerSocketReachable(config);
  console.log('[cloudflared-watchdog] Starting public websocket watchdog');
  await runLoop(config);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('[cloudflared-watchdog] Fatal startup error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
