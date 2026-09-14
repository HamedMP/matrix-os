import { createHash } from 'node:crypto';

export interface PrebillingProvisioningConfig {
  enabled: boolean;
  rolloutPercent: number;
  allowlist: ReadonlySet<string>;
  maxActive: number;
  leaseMs: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseAllowlist(value: string | undefined): ReadonlySet<string> {
  if (!value) return new Set();
  return new Set(value.split(',').map((item) => item.trim()).filter((item) => /^[A-Za-z0-9_-]{3,256}$/.test(item)).slice(0, 100));
}

export function loadPrebillingProvisioningConfig(env: NodeJS.ProcessEnv): PrebillingProvisioningConfig {
  const enabled = env.MATRIX_PREBILLING_PROVISIONING_ENABLED === 'true';
  return {
    enabled,
    rolloutPercent: enabled
      ? boundedInteger(env.MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT, 0, 0, 100)
      : 0,
    allowlist: parseAllowlist(env.MATRIX_PREBILLING_PROVISIONING_ALLOWLIST),
    maxActive: enabled
      ? boundedInteger(env.MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE, 0, 0, 10_000)
      : 0,
    // Stripe validates the 30-minute minimum when its server receives the
    // request. Keep one minute of bounded transport/clock-skew headroom so an
    // otherwise valid checkout is not rejected after spending a few seconds
    // in transit.
    leaseMs: 31 * 60 * 1_000,
  };
}

export function prebillingRolloutIncludesUser(
  config: PrebillingProvisioningConfig,
  clerkUserId: string,
): boolean {
  if (!config.enabled || config.maxActive <= 0) return false;
  if (config.allowlist.has(clerkUserId)) return true;
  if (config.rolloutPercent <= 0) return false;
  if (config.rolloutPercent >= 100) return true;
  const bucket = createHash('sha256').update(`prebilling:${clerkUserId}`).digest().readUInt32BE(0) % 100;
  return bucket < config.rolloutPercent;
}
