import { expect, it } from "vitest";
import type { AiProviderSnapshotV3, FundedAiFundingSummary, FundedAiEffectivePolicy, FundedAiChatAvailability } from "@matrix-os/contracts";
import { readProviderSettingsEnrichment } from "../../packages/gateway/src/ai-providers/provider-settings-enrichment.js";

const asOf = "2026-10-05T09:00:00.000Z";
const funding: FundedAiFundingSummary = { asOf, periodStart: "2026-10-01T00:00:00.000Z", monthlyBudgetMicrousd: 2_000_000,
  settledThisMonthMicrousd: 0, reservedMicrousd: 0, reservedThisMonthMicrousd: 0, promotionalBalanceMicrousd: 1_000_000,
  addonBalanceMicrousd: 0, creditBalanceMicrousd: 1_000_000, remainingBalanceMicrousd: 1_000_000, remainingBudgetMicrousd: 2_000_000 };
const policy: FundedAiEffectivePolicy = { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [],
  monthlyBudgetMicrousd: 2_000_000, checkedAt: asOf, staleAfter: "2026-10-05T09:01:00.000Z" };
const chatAvailability: FundedAiChatAvailability = { contractVersion: 1, asOf, eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 };
const canonical = { accessSources: [{ fundingKind: "matrix_included" }] } as AiProviderSnapshotV3;
async function read(projection?: FundedAiChatAvailability) {
  return readProviderSettingsEnrichment({ canonical, refresh: false, catalogFailureHarnesses: [],
    fundingSummary: { getFundingSummary: async () => ({ funding, policy, ...(projection ? { chatAvailability: projection } : {}) }) } });
}
it("carries independently validated Chat projection with its original total funding", async () => {
  expect(await read(chatAvailability)).toMatchObject({ fundingSummary: funding, fundedPolicy: policy, chatAvailability });
});
it("retains legacy aggregate information without inventing Chat capacity", async () => {
  const result = await read(); expect(result.fundingSummary).toEqual(funding); expect(result.chatAvailability).toBeUndefined();
});
it.each([
  { asOf: "2026-10-05T08:59:59.000Z" }, { eligibleBalanceMicrousd: 1_000_001 }, { availableBalanceMicrousd: 1 },
])("drops inconsistent independent funding observations: %j", async patch => {
  const result = await read({ ...chatAvailability, ...patch });
  expect(result.fundingSummary).toBeUndefined(); expect(result.chatAvailability).toBeUndefined();
});
