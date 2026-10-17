import { z } from "zod/v4";
import { canonicalReferenceId } from "#canonical-chat-primitives";
import { ProviderUsageSchema } from "#provider-settings";
import { FundedAiEffectivePolicySchema } from "#funded-ai";

/** Quiet owner funding observation, never a provider snapshot or route grant. */
export const ProviderManagedCreditObservationSchema = z.object({
  contractVersion: z.literal(1),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  gatewayPolicyAccessSourceId: canonicalReferenceId(128).nullable(),
  usage: ProviderUsageSchema.options[0].safeExtend({ scope: z.literal("owner_entitlement"), currency: z.literal("USD") }),
  policy: FundedAiEffectivePolicySchema,
  topUpEnabled: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.policy.checkedAt !== value.usage.asOf || value.policy.monthlyBudgetMicrousd !== value.usage.budget.monthlyBudgetMicrousd) {
    ctx.addIssue({ code: "custom", path: ["policy"], message: "Funding and policy observations must agree" });
  }
});
export type ProviderManagedCreditObservation = z.infer<typeof ProviderManagedCreditObservationSchema>;
