import type { Server } from 'node:http';
import { Hono } from 'hono';

export type PlatformRole = 'web' | 'worker';

/**
 * Which part of the platform this replica runs (PLATFORM_ROLE). `web` (the
 * default) serves the platform's routes; `worker` runs only the background
 * workers (metal sleeper, reaper and teardown drainer, reconcilers, cleanups)
 * and serves a health endpoint, so a dedicated private Cloud Run service can
 * run them while web replicas keep them off.
 */
export function platformRole(env: NodeJS.ProcessEnv): PlatformRole {
  const raw = env.PLATFORM_ROLE?.trim() || 'web';
  if (raw !== 'web' && raw !== 'worker') throw new Error('PLATFORM_ROLE must be web or worker');
  return raw;
}

export type PlatformWorkerScope = 'all' | 'metal';

/**
 * Which background workers a worker runs (PLATFORM_WORKER_SCOPE). `all` (the
 * default) runs every one; `metal` runs only the metal sleeper, reaper and
 * teardown drainer, as the preview worker does against the shared preview
 * database, so PR code never runs the other reconcilers there. `metal` is
 * preview-only: outside a `PLATFORM_PREVIEW=true` revision it fails startup.
 */
export function platformWorkerScope(env: NodeJS.ProcessEnv): PlatformWorkerScope {
  const raw = env.PLATFORM_WORKER_SCOPE?.trim() || 'all';
  if (raw !== 'all' && raw !== 'metal') throw new Error('PLATFORM_WORKER_SCOPE must be all or metal');
  if (raw === 'metal' && env.PLATFORM_PREVIEW !== 'true') {
    throw new Error('PLATFORM_WORKER_SCOPE=metal is for preview revisions only');
  }
  return raw;
}

/** Whether this replica runs background workers at all (before any scope narrows them). */
function runsBackgroundWorkers(env: NodeJS.ProcessEnv): boolean {
  if (platformRole(env) === 'worker') return true;
  if (env.PLATFORM_BACKGROUND_WORKERS_ENABLED === 'true') return true;
  if (env.PLATFORM_BACKGROUND_WORKERS_ENABLED === 'false') return false;
  return env.K_SERVICE === undefined && env.PLATFORM_RUNTIME_MODE !== 'cloud_run';
}

/**
 * The general background workers (reconcilers, sweeps, cleanups). Cloud Run
 * replicas serve traffic by default; only a dedicated worker opts in, and a
 * metal-scoped worker runs none of them.
 */
export function shouldEnablePlatformBackgroundWorkers(env: NodeJS.ProcessEnv): boolean {
  return runsBackgroundWorkers(env) && platformWorkerScope(env) === 'all';
}

/** The metal passes (sleeper, stale-provisioning reaper, VM teardown drainer). */
export function shouldEnableMetalBackgroundWorkers(env: NodeJS.ProcessEnv): boolean {
  return runsBackgroundWorkers(env);
}

/** A worker replica serves no WebSocket: every upgrade is answered 404 and closed. */
export function refuseAllWebSocketUpgrades(server: Server): void {
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
}

/** The only HTTP surface of a worker-role replica: a health check, nothing public. */
export function createWorkerHealthApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ status: 'ok', role: 'worker' });
  });
  app.all('*', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.text('Not found', 404);
  });
  return app;
}
