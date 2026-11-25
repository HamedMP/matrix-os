import { z } from 'zod/v4';
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
  slackDevCallbackOrigin?: string;
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

function loadSlackDevCallbackOrigin(env: NodeJS.ProcessEnv, mode: PlatformRuntimeMode): string | undefined {
  const flag = env.SLACK_DEV_CALLBACK_ONLY;
  if (flag === undefined || flag === 'false') return undefined;

  const origin = env.PLATFORM_PUBLIC_URL ?? '';
  const tag = /^https:\/\/slack-dev-([0-9a-f]{8})---matrix-platform-preview-[a-z0-9]+(?:-[a-z0-9]+)*\.a\.run\.app$/.exec(origin);
  if (flag !== 'true' || !tag || mode !== 'cloud_run' || env.K_SERVICE !== 'matrix-platform-preview'
    || env.PLATFORM_PREVIEW !== 'true' || env.AUTH_SHELL_ENABLED !== 'false'
    || env.CUSTOMER_VPS_ENABLED !== 'false' || env.PLATFORM_BACKGROUND_WORKERS_ENABLED === 'true'
    || (env.SLACK_PUBLIC_BASE_URL !== undefined && env.SLACK_PUBLIC_BASE_URL !== origin)) {
    throw new PlatformStartupConfigError('Slack Dev callback requires an isolated tagged Preview service');
  }
  if (Object.keys(env).some(key => /^(?:SLACK_PREVIEW_|MATRIX_PREVIEW_PAIR_|R2_|S3_|STRIPE_)/.test(key) && env[key])
    || env.HETZNER_API_TOKEN || env.POSTGRES_URL || env.ATS_DATABASE_URL) {
    throw new PlatformStartupConfigError('Slack Dev callback cannot load unrelated Platform credentials or targets');
  }
  if (env.PLATFORM_SECRET !== undefined && env.PLATFORM_SECRET.length < 32) {
    throw new PlatformStartupConfigError('Slack Dev callback requires a dedicated Platform secret');
  }

  let database: URL;
  try {
    database = new URL(env.PLATFORM_DATABASE_URL ?? '');
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw new PlatformStartupConfigError('Slack Dev callback requires its dedicated verified Postgres database');
  }
  const login = new RegExp(`^[a-z0-9]+_dev_slack_${tag[1]}$`);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname
    || !login.test(database.username) || !database.password || database.pathname !== `/matrixos_${database.username}`
    || database.hash || [...database.searchParams.keys()].some(key => key !== 'sslmode' && key !== 'channel_binding')
    || database.searchParams.getAll('sslmode').join(',') !== 'verify-full') {
    throw new PlatformStartupConfigError('Slack Dev callback requires its dedicated verified Postgres database');
  }
  return origin;
}

export function loadPlatformRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PlatformRuntimeConfig {
  // Validate isolation before startup may construct provider clients or workers.
  const candidateRuntime = loadPreviewPairCandidateRuntimeProfile(env);
  const rawMode = env.PLATFORM_RUNTIME_MODE ?? 'compose';
  const parsedMode = PlatformRuntimeModeSchema.safeParse(rawMode);
  if (!parsedMode.success) {
    throw new PlatformStartupConfigError('PLATFORM_RUNTIME_MODE must be one of: cloud_run, compose, local');
  }

  const mode = parsedMode.data;
  const slackDevCallbackOrigin = loadSlackDevCallbackOrigin(env, mode);
  const customerVpsEnabled = env.CUSTOMER_VPS_ENABLED === 'true';
  const platformDatabaseUrl = resolvePlatformDatabaseUrl(env);

  if (mode === 'cloud_run') {
    if (!customerVpsEnabled && !candidateRuntime && !slackDevCallbackOrigin) {
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
    legacyContainerOrchestrationEnabled: mode !== 'cloud_run' && !candidateRuntime,
    ...(slackDevCallbackOrigin ? { slackDevCallbackOrigin } : {}),
  };
}
