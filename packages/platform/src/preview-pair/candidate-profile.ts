import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairPrSchema, PreviewPairOriginSchema,
  previewPairHandle, previewPairTag } from "@matrix-os/contracts/preview-pair";
import { PreviewPairConfigurationError } from "./config.js";

export interface PreviewPairCandidateRuntimeProfile {
  pairId: string; generation: number; pr: number; apiOrigin: string;
  handles: readonly [string, string];
}
export function loadPreviewPairCandidateRuntimeProfile(env: NodeJS.ProcessEnv): PreviewPairCandidateRuntimeProfile | undefined {
  const flag = env.MATRIX_PREVIEW_PAIR_RUNTIME_ONLY;
  if (!flag || flag === "false") return undefined;
  try {
    if (flag !== "true" || ["CUSTOMER_VPS_ENABLED", "MATRIX_PREVIEW_PAIR_ENABLED", "MATRIX_FUNDED_AI_RUNTIME_ENABLED", "MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED"]
      .some(name => env[name] !== "false") || env.MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED === "true"
      || env.GOLDEN_SNAPSHOTS_ENABLED === "true") throw new PreviewPairConfigurationError();
    const forbidden = ["HETZNER_API_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_APP_PRIVATE_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
      "MATRIX_PREVIEW_PAIR_OPERATOR_SECRET", "GOLDEN_SNAPSHOT_OPERATOR_SECRET", "MATRIX_PREVIEW_RUNTIME_SECRET",
      "AI_FUNDED_CREDENTIAL_HASH_SECRET", "AI_FUNDED_RELAY_CONTROL_TOKEN"];
    if (forbidden.some(name => env[name] !== undefined)) throw new PreviewPairConfigurationError();
    z.string().max(512).regex(/^pk_test_[A-Za-z0-9_=-]+$/).parse(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    z.string().max(512).regex(/^sk_test_[A-Za-z0-9_=-]+$/).parse(env.CLERK_SECRET_KEY);
    const secrets = [env.PLATFORM_SECRET, env.PLATFORM_JWT_SECRET, env.EDGE_ROUTER_SECRET]
      .map(value => z.string().min(32).max(4096).parse(value));
    if (secrets.some((value, index) => secrets.indexOf(value) !== index)) throw new PreviewPairConfigurationError();
    const pairId = PreviewPairIdSchema.parse(env.MATRIX_PREVIEW_PAIR_ID);
    const generation = PreviewPairGenerationSchema.parse(Number(z.string().regex(/^[1-9][0-9]{0,2}$/).parse(env.MATRIX_PREVIEW_PAIR_GENERATION)));
    const pr = PreviewPairPrSchema.parse(Number(z.string().regex(/^[1-9][0-9]{0,8}$/).parse(env.MATRIX_PREVIEW_PAIR_PR)));
    const apiOrigin = PreviewPairOriginSchema.parse(env.PLATFORM_PUBLIC_URL);
    const browserOrigin = apiOrigin.replace("-api---", "-ui---");
    if (!apiOrigin.startsWith(`https://${previewPairTag(pairId, generation, "api")}---`)
      || env.MATRIX_APP_DOMAIN_HOSTS !== new URL(browserOrigin).hostname
      || env.MATRIX_API_ORIGIN !== apiOrigin || env.MATRIX_APP_ORIGIN !== browserOrigin
      || env.NEXT_PUBLIC_MATRIX_APP_URL !== browserOrigin) throw new PreviewPairConfigurationError();
    return { pairId, generation, pr, apiOrigin, handles: [previewPairHandle(pr, pairId, generation, "owner"), previewPairHandle(pr, pairId, generation, "member")] };
  } catch (error: unknown) {
    if (error instanceof PreviewPairConfigurationError) throw error;
    if (error instanceof z.ZodError || error instanceof TypeError) throw new PreviewPairConfigurationError();
    throw error;
  }
}
