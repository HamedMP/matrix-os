import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { PlatformDB } from "../db.js";
import { createAiFundedSpeechFundingPort } from "../speech/funding.js";
import type { PlatformSpeechConfig } from "../speech/config.js";
import { createPlatformAoedeLiveService, type LivePolicy } from "./service.js";

const Config = z.object({ model: z.literal("gpt-live-1"), voice: z.string().regex(/^[a-z]{1,40}$/),
  revision: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  microusdPerMinute: z.coerce.number().int().min(1).max(1_000_000_000),
  maxDurationMs: z.coerce.number().int().min(30_000).max(30 * 60_000) });
export function createConfiguredPlatformAoedeLiveService(options: {
  db: PlatformDB; speechConfig: PlatformSpeechConfig; env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env;
  if (env.PLATFORM_AOEDE_LIVE_ENABLED !== "true") return undefined;
  const speech = options.speechConfig;
  if (!speech.enabled || speech.provider !== "openai" || speech.fundingMode !== "existing_wallet") {
    throw new Error("Live requires enabled wallet-backed speech configuration");
  }
  const policy: LivePolicy = { enabled: true, ...Config.parse({
    model: env.PLATFORM_AOEDE_LIVE_MODEL, voice: env.PLATFORM_AOEDE_LIVE_VOICE,
    revision: env.PLATFORM_AOEDE_LIVE_POLICY_REVISION,
    microusdPerMinute: env.PLATFORM_AOEDE_LIVE_MICROUSD_PER_MINUTE,
    maxDurationMs: env.PLATFORM_AOEDE_LIVE_MAX_DURATION_MS,
  }) };
  const secret = createHmac("sha256", speech.speechSecret).update("matrix-platform-aoede-live").digest("hex");
  return createPlatformAoedeLiveService({ db: options.db, policy, apiKey: speech.apiKey, fingerprintSecret: secret,
    funding: createAiFundedSpeechFundingPort({ capability: "speech:live", credentialHashSecret: secret,
      allowedSources: speech.allowedFundingSources, reservationIdFactory: () => "live_" + randomUUID(),
      inFlightTtlMs: policy.maxDurationMs + 120_000,
      monthlyAllowance: { monthlyBudgetMicrousd: speech.monthlyBudgetMicrousd,
        monthlyPromotionalCreditMicrousd: speech.monthlyPromotionalCreditMicrousd } }) });
}
