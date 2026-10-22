import { describe, expect, it } from "vitest";
import { ProviderManagedCreditObservationSchema } from "@matrix-os/contracts";
import { projectManagedCreditUsage } from "../../packages/gateway/src/ai-providers/provider-managed-credit-usage.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsFundingSummaryFixture } from "../gateway/provider-settings-test-support.js";
function fixture() {
  const { funding, policy } = providerSettingsFundingSummaryFixture();
  return { contractVersion: 1, revision: 0, gatewayPolicyAccessSourceId: "matrix_included", usage: projectManagedCreditUsage(funding, undefined, PROVIDER_SETTINGS_NOW), policy, topUpEnabled: false };
}
describe("managed credit observation contract", () => {
  it("accepts bounded coherent managed authority including legacy unknown Chat", () => expect(ProviderManagedCreditObservationSchema.parse(fixture()).usage.kind).toBe("managed_credit"));
  it("rejects unrelated fields, policy timestamp/budget mismatches and non-entitlement usage", () => {
    const valid = fixture();
    for (const value of [{ ...valid, ownerId: "private" }, { ...valid, policy: { ...valid.policy, checkedAt: "2026-08-30T09:59:59.000Z" } },
      { ...valid, policy: { ...valid.policy, monthlyBudgetMicrousd: 2 } }, { ...valid, usage: { ...valid.usage, scope: "access_source" } },
      { ...valid, usage: { ...valid.usage, currency: "EUR" } },
      { ...valid, usage: { ...valid.usage, chatAvailability: { contractVersion: 1, asOf: valid.usage.asOf, eligibleBalanceMicrousd: 1, availableBalanceMicrousd: 2 } } }]) {
      expect(ProviderManagedCreditObservationSchema.safeParse(value).success).toBe(false);
    }
  });
});

it("preserves the unchanged five-minute validity without restamping stale ledger evidence", () => {
  const { funding } = providerSettingsFundingSummaryFixture();
  expect(projectManagedCreditUsage(funding, undefined, new Date(+PROVIDER_SETTINGS_NOW + 300_000)).state).toBe("current");
  const expired = projectManagedCreditUsage(funding, undefined, new Date(+PROVIDER_SETTINGS_NOW + 300_001));
  expect(expired.state).toBe("stale"); expect(expired.asOf).toBe(funding.asOf);
});
