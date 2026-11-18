import { z } from "zod/v4";

const LinearConfigSchema = z.object({
  apiKey: z.string().min(8).max(512).regex(/^[!-~]+$/),
  teamId: z.uuid(),
  openStateId: z.uuid(),
  completedStateId: z.uuid(),
}).refine(value => value.openStateId !== value.completedStateId);

export function fundedPricingReviewRuntimeConfig(
  env: NodeJS.ProcessEnv,
  fundedEnabled: boolean,
  backgroundWorkersEnabled: boolean,
) {
  if (env.MATRIX_FUNDED_AI_PRICING_REVIEW_JOB_ENABLED !== "true") return undefined;
  if (!fundedEnabled) throw new Error("Funded pricing review job requires Funded AI");
  const linear = LinearConfigSchema.safeParse({
    apiKey: env.MATRIX_FUNDED_AI_PRICING_LINEAR_API_KEY,
    teamId: env.MATRIX_FUNDED_AI_PRICING_LINEAR_TEAM_ID,
    openStateId: env.MATRIX_FUNDED_AI_PRICING_LINEAR_OPEN_STATE_ID,
    completedStateId: env.MATRIX_FUNDED_AI_PRICING_LINEAR_COMPLETED_STATE_ID,
  });
  if (!linear.success) throw new Error("Funded pricing review job configuration is incomplete");
  const cloudRun = env.PLATFORM_RUNTIME_MODE === "cloud_run" || env.K_SERVICE !== undefined;
  const mode = cloudRun ? (backgroundWorkersEnabled ? "review" : "watchdog") : "both";
  return { mode, linear: linear.data } as const;
}
