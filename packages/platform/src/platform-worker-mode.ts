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

/** Cloud Run replicas serve traffic by default; only the dedicated worker opts in. */
export function shouldEnablePlatformBackgroundWorkers(env: NodeJS.ProcessEnv): boolean {
  if (platformRole(env) === 'worker') return true;
  if (env.PLATFORM_BACKGROUND_WORKERS_ENABLED === 'true') return true;
  if (env.PLATFORM_BACKGROUND_WORKERS_ENABLED === 'false') return false;
  return env.K_SERVICE === undefined && env.PLATFORM_RUNTIME_MODE !== 'cloud_run';
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
