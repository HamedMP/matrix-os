import {
  FundedAiEffectivePolicySchema,
  FundedAiFundingSummarySchema,
  type AiProviderSnapshotV3,
} from "@matrix-os/contracts";
import type { FundedAiFundingSummaryReader } from "../funded-ai-funding-summary-client.js";
import type { GenericHarnessModelCatalogReader } from "./generic-harness-model-catalog.js";

/** Independent reads run together; canonical state still gates funded projection. */
export async function readProviderSettingsEnrichment(input: {
  canonical: AiProviderSnapshotV3 | Promise<AiProviderSnapshotV3>;
  fundingSummary?: FundedAiFundingSummaryReader;
  genericModelCatalog?: GenericHarnessModelCatalogReader;
  refresh: boolean;
}) {
  const [canonical, funded, genericModelCatalog] = await Promise.all([
    input.canonical,
    (async () => {
      if (!input.fundingSummary) return undefined;
      try {
        const state = await input.fundingSummary.getFundingSummary();
        return {
          fundingSummary: FundedAiFundingSummarySchema.parse(state.funding),
          fundedPolicy: FundedAiEffectivePolicySchema.parse(state.policy),
        };
      } catch (error) {
        console.warn("[provider-settings] Matrix funding summary unavailable:",
          error instanceof Error ? error.name : "UnknownError");
        return undefined;
      }
    })(),
    (async () => {
      if (!input.genericModelCatalog) return undefined;
      try {
        return await input.genericModelCatalog.getCatalog({ refresh: input.refresh });
      } catch (error) {
        console.warn("[provider-settings] Generic harness model catalog unavailable:",
          error instanceof Error ? error.name : "UnknownError");
        return undefined;
      }
    })(),
  ]);
  const hasMatrixSource = canonical.accessSources.some((source) =>
    source.fundingKind === "matrix_included" || source.fundingKind === "matrix_addon");
  return { ...(hasMatrixSource ? funded : undefined), genericModelCatalog };
}

export type ProviderSettingsEnrichment = Awaited<ReturnType<typeof readProviderSettingsEnrichment>>;
