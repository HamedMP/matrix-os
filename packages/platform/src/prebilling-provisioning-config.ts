import { createHash } from 'node:crypto';
import { z } from 'zod/v4';

const MAX_COST_ENTRIES = 20;
const ServerTypeSchema = z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
const CostMapSchema = z.record(ServerTypeSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export interface PrebillingProvisioningConfig {
  enabled: boolean;
  rolloutPercent: number;
  allowlist: ReadonlySet<string>;
  maxActive: number;
  maxHourlyCostMicros: number;
  leaseMs: number;
  serverHourlyCostMicros: ReadonlyMap<string, number>;
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

function parseCosts(value: string | undefined): ReadonlyMap<string, number> {
  if (!value) return new Map();
  try {
    const parsed = CostMapSchema.parse(JSON.parse(value));
    const entries = Object.entries(parsed);
    return entries.length <= MAX_COST_ENTRIES ? new Map(entries) : new Map();
  } catch (err: unknown) {
    if (err instanceof SyntaxError || err instanceof z.ZodError) return new Map();
    throw err;
  }
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
    maxHourlyCostMicros: enabled
      ? boundedInteger(env.MATRIX_PREBILLING_PROVISIONING_MAX_HOURLY_COST_MICROS, 0, 0, Number.MAX_SAFE_INTEGER)
      : 0,
    leaseMs: 30 * 60 * 1_000,
    serverHourlyCostMicros: parseCosts(env.MATRIX_PREBILLING_PROVISIONING_COSTS_JSON),
  };
}

export function prebillingRolloutIncludesUser(
  config: PrebillingProvisioningConfig,
  clerkUserId: string,
): boolean {
  if (!config.enabled || config.maxActive <= 0 || config.maxHourlyCostMicros <= 0) return false;
  if (config.allowlist.has(clerkUserId)) return true;
  if (config.rolloutPercent <= 0) return false;
  if (config.rolloutPercent >= 100) return true;
  const bucket = createHash('sha256').update(`prebilling:${clerkUserId}`).digest().readUInt32BE(0) % 100;
  return bucket < config.rolloutPercent;
}

export function prebillingHourlyCostMicros(
  config: PrebillingProvisioningConfig,
  serverType: string,
): number | null {
  return config.serverHourlyCostMicros.get(serverType.trim().toLowerCase()) ?? null;
}
