import { z } from 'zod/v4';
import { assertLocalDevstackDatabase, DevstackBootstrapError } from './devstack-identity.js';
import { loadPreviewPairCandidateRuntimeProfile } from './preview-pair/candidate-profile.js';

const PlatformRuntimeModeSchema = z.enum(['cloud_run', 'compose', 'local']);
const LOCAL_DATABASE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
]);

export type PlatformRuntimeMode = z.infer<typeof PlatformRuntimeModeSchema>;

export interface PlatformRuntimeConfig {
  mode: PlatformRuntimeMode;
  platformDatabaseUrl: string;
  customerVpsEnabled: boolean;
  legacyContainerOrchestrationEnabled: boolean;
  registeredRuntimeInstance?: string;
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

function loadRegisteredRuntimeProfile(env: NodeJS.ProcessEnv): { instance: string; databaseUrl: string } | undefined {
  const flag = env.MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY;
  if (flag === undefined || flag === 'false') return undefined;
  if (flag !== 'true') {
    throw new PlatformStartupConfigError('MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY must be true or false (DevStack).');
  }
  if (env.PLATFORM_RUNTIME_MODE !== 'local'
    || env.PLATFORM_BACKGROUND_WORKERS_ENABLED !== 'false'
    || env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED !== 'true'
    || env.CUSTOMER_VPS_ENABLED === 'true'
    || env.MATRIX_PREVIEW_PAIR_RUNTIME_ONLY === 'true'
    || env.MATRIX_PREVIEW_PAIR_ENABLED === 'true'
    || env.MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED === 'true') {
    throw new PlatformStartupConfigError(
      'Registered DevStack routing requires local legacy routing with background workers, customer VPS and Preview pairs disabled.',
    );
  }
  if (!env.MATRIX_DEVSTACK_INSTANCE || !env.PLATFORM_DATABASE_URL) {
    throw new PlatformStartupConfigError('Registered DevStack routing requires an instance slug and PLATFORM_DATABASE_URL.');
  }
  try {
    return {
      instance: env.MATRIX_DEVSTACK_INSTANCE,
      databaseUrl: assertLocalDevstackDatabase(env.PLATFORM_DATABASE_URL, env.MATRIX_DEVSTACK_INSTANCE, 'local', true),
    };
  } catch (error: unknown) {
    if (!(error instanceof DevstackBootstrapError)) throw error;
    throw new PlatformStartupConfigError(error.message);
  }
}

export function loadPlatformRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PlatformRuntimeConfig {
  // Validate isolation before startup may construct provider clients or workers.
  const registeredRuntime = loadRegisteredRuntimeProfile(env);
  const candidateRuntime = loadPreviewPairCandidateRuntimeProfile(env);
  const rawMode = env.PLATFORM_RUNTIME_MODE ?? 'compose';
  const parsedMode = PlatformRuntimeModeSchema.safeParse(rawMode);
  if (!parsedMode.success) {
    throw new PlatformStartupConfigError('PLATFORM_RUNTIME_MODE must be one of: cloud_run, compose, local');
  }

  const mode = parsedMode.data;
  const customerVpsEnabled = env.CUSTOMER_VPS_ENABLED === 'true';
  const platformDatabaseUrl = registeredRuntime?.databaseUrl ?? resolvePlatformDatabaseUrl(env);

  if (mode === 'cloud_run') {
    if (!customerVpsEnabled && !candidateRuntime) {
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
    legacyContainerOrchestrationEnabled: mode !== 'cloud_run' && !candidateRuntime && !registeredRuntime,
    ...(registeredRuntime ? { registeredRuntimeInstance: registeredRuntime.instance } : {}),
  };
}
