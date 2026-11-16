import { IsoTimestampSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { intersectModels } from "./ai-funded-metering-helpers.js";

export const FUNDED_CANARY_MODEL_ID = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
export const FUNDED_CANARY_COMPARISON_MODEL_ID = "@cf/zai-org/glm-5.3";
const MAX_BINDING_MS = 6 * 60 * 60_000;
const CANONICAL_ORIGIN = /^https:\/\/(matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app)\/?$/;

const BindingSchema = z.object({
  ownerId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  machineId: z.uuid().regex(/^[0-9a-f-]+$/),
  runtimeSlot: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  runtimeTokenEpoch: z.number().int().min(1).max(2_147_483_647),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  expiresAt: IsoTimestampSchema,
}).strict();

type RuntimeIdentity = { ownerId: string; machineId: string; runtimeSlot: string };
export type FundedCanaryBinding = {
  identity: RuntimeIdentity;
  runtimeTokenEpoch: number;
  expiresAt: string;
  relayOrigin: string;
};

export function loadFundedCanaryBinding(env: NodeJS.ProcessEnv, now = new Date()): FundedCanaryBinding | undefined {
  const raw = env.MATRIX_FUNDED_AI_CANARY_BINDING;
  if (!raw || env.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED !== "true") return undefined;
  const configurationError = new Error("Funded AI canary binding is misconfigured");
  const origin = CANONICAL_ORIGIN.exec(env.MATRIX_FUNDED_AI_RELAY_URL ?? "");
  if (raw.length > 1_024 || !origin) {
    throw configurationError;
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    if (error instanceof SyntaxError) throw configurationError;
    throw error;
  }
  const parsed = BindingSchema.safeParse(value);
  if (!parsed.success) throw configurationError;
  const { ownerId, machineId, runtimeSlot, runtimeTokenEpoch, sourceSha, expiresAt } = parsed.data;
  const expiryMs = Date.parse(expiresAt);
  const remainingMs = expiryMs - now.getTime();
  if (!Number.isFinite(remainingMs) || new Date(expiryMs).toISOString() !== expiresAt
    || remainingMs > MAX_BINDING_MS) throw configurationError;
  if (remainingMs <= 0) return undefined;
  return {
    identity: { ownerId, machineId, runtimeSlot }, runtimeTokenEpoch, expiresAt,
    relayOrigin: `https://relay-${sourceSha.slice(0, 12)}---${origin[1]}`,
  };
}

export function activeFundedCanaryBinding(
  binding: FundedCanaryBinding | undefined, identity: RuntimeIdentity, runtimeTokenEpoch: number, now: Date,
): FundedCanaryBinding | undefined {
  if (binding && runtimeTokenEpoch === binding.runtimeTokenEpoch
    && identity.ownerId === binding.identity.ownerId && identity.machineId === binding.identity.machineId
    && identity.runtimeSlot === binding.identity.runtimeSlot && now.getTime() < Date.parse(binding.expiresAt)) {
    return binding;
  }
  return undefined;
}

export function effectiveFundedCanaryPolicy(
  globalModels: string[], runtimeModels: string[], binding: FundedCanaryBinding | undefined,
  identity: RuntimeIdentity, runtimeTokenEpoch: number, now: Date,
): { allowedModelIds: string[]; canaryExpiresAt?: string } {
  const allowedModelIds = intersectModels(globalModels, runtimeModels);
  const canary = activeFundedCanaryBinding(binding, identity, runtimeTokenEpoch, now);
  if (canary && allowedModelIds.includes(FUNDED_CANARY_COMPARISON_MODEL_ID)
    && !allowedModelIds.includes(FUNDED_CANARY_MODEL_ID) && runtimeModels.includes(FUNDED_CANARY_MODEL_ID)) {
    return { allowedModelIds: [...allowedModelIds, FUNDED_CANARY_MODEL_ID], canaryExpiresAt: canary.expiresAt };
  }
  return { allowedModelIds };
}

export function fundedCanaryDeadline(checked: Date, durationMs: number, canaryExpiresAt?: string): string {
  const cutoff = canaryExpiresAt ? Date.parse(canaryExpiresAt) : Infinity;
  return new Date(Math.min(checked.getTime() + durationMs, cutoff)).toISOString();
}
