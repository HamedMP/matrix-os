import { z } from 'zod/v4';

const PlatformRuntimeModeSchema = z.enum(['cloud_run', 'compose', 'local']);
const LOCAL_DATABASE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

export type PlatformRuntimeMode = z.infer<typeof PlatformRuntimeModeSchema>;

export interface PlatformRuntimeConfig {
  mode: PlatformRuntimeMode;
  platformDatabaseUrl: string;
  customerVpsEnabled: boolean;
  dockerRequired: boolean;
  legacyContainerOrchestrationEnabled: boolean;
}

export class PlatformStartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformStartupConfigError';
  }
}

function resolvePlatformDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.PLATFORM_DATABASE_URL ??
    (env.POSTGRES_URL ? `${env.POSTGRES_URL}/matrixos_platform` : undefined);
}

function isLocalDatabaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
    throw new PlatformStartupConfigError('PLATFORM_DATABASE_URL must be a valid Postgres URL');
  }
  const hostname = parsed.hostname.toLowerCase();
  return LOCAL_DATABASE_HOSTS.has(hostname) || hostname.startsWith('127.');
}

export function loadPlatformRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PlatformRuntimeConfig {
  const rawMode = env.PLATFORM_RUNTIME_MODE ?? 'compose';
  const parsedMode = PlatformRuntimeModeSchema.safeParse(rawMode);
  if (!parsedMode.success) {
    throw new PlatformStartupConfigError('PLATFORM_RUNTIME_MODE must be one of: cloud_run, compose, local');
  }

  const mode = parsedMode.data;
  const customerVpsEnabled = env.CUSTOMER_VPS_ENABLED === 'true';
  const platformDatabaseUrl = resolvePlatformDatabaseUrl(env);

  if (mode === 'cloud_run') {
    if (!customerVpsEnabled) {
      throw new PlatformStartupConfigError('CUSTOMER_VPS_ENABLED=true is required when PLATFORM_RUNTIME_MODE=cloud_run');
    }
    if (!env.PLATFORM_DATABASE_URL) {
      throw new PlatformStartupConfigError('PLATFORM_DATABASE_URL is required when PLATFORM_RUNTIME_MODE=cloud_run');
    }
    if (isLocalDatabaseUrl(env.PLATFORM_DATABASE_URL)) {
      throw new PlatformStartupConfigError('PLATFORM_DATABASE_URL must point at a managed Postgres host when PLATFORM_RUNTIME_MODE=cloud_run');
    }
  }

  if (!platformDatabaseUrl) {
    throw new PlatformStartupConfigError('Platform Postgres URL is required: set PLATFORM_DATABASE_URL or POSTGRES_URL');
  }

  return {
    mode,
    platformDatabaseUrl,
    customerVpsEnabled,
    dockerRequired: mode !== 'cloud_run',
    legacyContainerOrchestrationEnabled: mode !== 'cloud_run',
  };
}
