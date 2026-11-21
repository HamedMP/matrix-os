import { z } from 'zod/v4';

/**
 * Free plan configuration (spec 2691, ENG-520; ported from PR #3414). The free
 * tier is off unless `MATRIX_FREE_TIER_ENABLED` is `1` or `true`, and it provisions
 * only metal runtimes, so it also needs a configured metal substrate.
 */
export interface FreeTierConfig {
  /** Global ceiling on admitted free owners; admission beyond it is refused as busy. */
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

function isEnabled(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === '1' || flag === 'true';
}

/** Read once at startup. Problems are reported by setting name only. */
export function loadFreeTierConfig(env: NodeJS.ProcessEnv): FreeTierConfigResult {
  if (!isEnabled(env.MATRIX_FREE_TIER_ENABLED)) return { ok: false, reason: 'disabled' };
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
