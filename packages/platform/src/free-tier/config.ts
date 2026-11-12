import { z } from 'zod/v4';
import { DEFAULT_STORAGE_QUOTA_LIMITS, type StorageQuotaLimits } from './storage-quota.js';

export interface FreeTierConfig {
  /** Global ceiling on non-deleted free runtimes; creation beyond it is refused as busy. */
  maxRuntimes: number;
  /** Invite-only signup (spec decision D4) unless explicitly opened. */
  inviteRequired: boolean;
  /**
   * Ceiling on free runtimes' funded spend per UTC day, read from the funded
   * reservation ledger. Unset means no free funded admission may be granted.
   */
  dailyFundedSpendMicrousd?: number;
}

export type FreeTierConfigResult =
  | { ok: true; config: FreeTierConfig }
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'incomplete'; invalid: string[] };

const FIELDS = {
  MATRIX_FREE_TIER_MAX_RUNTIMES: z.coerce.number().int().min(1).max(1_000_000),
  MATRIX_FREE_TIER_INVITE_REQUIRED: z.enum(['true', 'false']).default('true'),
  MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
} as const;

const ConfigSchema = z.object(FIELDS);

/** Read once at startup. Problems are reported by setting name only. */
export function loadFreeTierConfig(env: NodeJS.ProcessEnv): FreeTierConfigResult {
  if (env.MATRIX_FREE_TIER_ENABLED !== 'true') return { ok: false, reason: 'disabled' };
  const raw = Object.fromEntries(Object.keys(FIELDS).map((key) => [key, env[key] === '' ? undefined : env[key]]));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const invalid = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    return { ok: false, reason: 'incomplete', invalid };
  }
  return {
    ok: true,
    config: {
      maxRuntimes: parsed.data.MATRIX_FREE_TIER_MAX_RUNTIMES,
      inviteRequired: parsed.data.MATRIX_FREE_TIER_INVITE_REQUIRED === 'true',
      ...(parsed.data.MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD === undefined
        ? {} : { dailyFundedSpendMicrousd: parsed.data.MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD }),
    },
  };
}

/** Startup wrapper: an incomplete configuration is logged by setting name and leaves the free tier off. */
export function loadConfiguredFreeTier(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = (message) => console.warn(message),
): FreeTierConfig | undefined {
  const loaded = loadFreeTierConfig(env);
  if (loaded.ok) return loaded.config;
  if (loaded.reason === 'incomplete') log(`[platform] free tier disabled; invalid settings: ${loaded.invalid.join(', ')}`);
  return undefined;
}

const STORAGE_FIELDS = {
  MATRIX_CONTAINER_HOME_MAX_BYTES: z.coerce.number().int().min(1).max(1024 ** 4).default(DEFAULT_STORAGE_QUOTA_LIMITS.maxBytes),
  MATRIX_CONTAINER_HOME_MAX_FILES: z.coerce.number().int().min(1).max(10_000_000).default(DEFAULT_STORAGE_QUOTA_LIMITS.maxFiles),
} as const;

/**
 * Object-store limits for container owners, read once at startup. The broker
 * always meters container owners, so an invalid override is logged by name
 * and the provisional defaults stay in force.
 */
export function loadContainerStorageLimits(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = (message) => console.warn(message),
): StorageQuotaLimits {
  const raw = Object.fromEntries(Object.keys(STORAGE_FIELDS).map((key) => [key, env[key] === '' ? undefined : env[key]]));
  const parsed = z.object(STORAGE_FIELDS).safeParse(raw);
  if (!parsed.success) {
    const invalid = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    log(`[platform] container storage limits use defaults; invalid settings: ${invalid.join(', ')}`);
    return DEFAULT_STORAGE_QUOTA_LIMITS;
  }
  return { maxBytes: parsed.data.MATRIX_CONTAINER_HOME_MAX_BYTES, maxFiles: parsed.data.MATRIX_CONTAINER_HOME_MAX_FILES };
}
