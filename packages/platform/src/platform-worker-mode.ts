/** Cloud Run replicas serve traffic by default; only the dedicated worker opts in. */
export function shouldEnablePlatformBackgroundWorkers(env: NodeJS.ProcessEnv): boolean {
  if (env.PLATFORM_BACKGROUND_WORKERS_ENABLED === 'true') return true;
  if (env.PLATFORM_BACKGROUND_WORKERS_ENABLED === 'false') return false;
  return env.K_SERVICE === undefined && env.PLATFORM_RUNTIME_MODE !== 'cloud_run';
}
