import { BotRunLimitsSchema, type BotRunSpec } from "@matrix-os/contracts";

/** Trusted Gateway process configuration; ordinary Chat/recipe input cannot widen it. */
export function readTrustedBotRunLimits(): BotRunSpec["limits"] {
  const configuredCalls = process.env.MATRIX_BOT_MAX_INFERENCE_CALLS;
  if (configuredCalls !== undefined && !/^[1-9]\d?$/.test(configuredCalls)) {
    throw new Error("Invalid Bot inference limit");
  }
  return BotRunLimitsSchema.parse({ maxToolActions: 60,
    ...(configuredCalls !== undefined ? { maxInferenceCalls: Number(configuredCalls) } : {}) });
}
