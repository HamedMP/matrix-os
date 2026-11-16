import { z } from 'zod/v4';

export interface FreeTierConfig {
  /** Global ceiling on non-deleted free runtimes; creation beyond it is refused as busy. */
  maxRuntimes: number;
  /** Invite-only signup (spec decision D4) unless explicitly opened. */
  inviteRequired: boolean;
}

export type FreeTierConfigResult =
  | { ok: true; config: FreeTierConfig }
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'incomplete'; invalid: string[] };

const FIELDS = {
  MATRIX_FREE_TIER_MAX_RUNTIMES: z.coerce.number().int().min(1).max(1_000_000),
  MATRIX_FREE_TIER_INVITE_REQUIRED: z.enum(['true', 'false']).default('true'),
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
