/** Product terms approved by requester, 2026-10-23. Activation is separate. */
export const SUBSCRIPTION_CREDIT_AMOUNTS = Object.freeze({
  matrix_starter: 5_000_000, matrix_builder: 10_000_000, matrix_max: 20_000_000,
});
export function subscriptionCreditAmount(plan: string): number | undefined {
  return Object.hasOwn(SUBSCRIPTION_CREDIT_AMOUNTS, plan)
    ? SUBSCRIPTION_CREDIT_AMOUNTS[plan as keyof typeof SUBSCRIPTION_CREDIT_AMOUNTS] : undefined;
}
export interface SubscriptionCreditTermsTable {
  subscription_id: string; owner_id: string; runtime_slot: string; anchor_at: string;
  observed_plan_slug: string; floor_cycle_start: string; floor_microusd: number; updated_at: string;
}
export interface SubscriptionCreditPaymentsTable {
  invoice_id: string; subscription_id: string; owner_id: string; plan_slug: string;
  paid_from: string; paid_until: string; created_at: string;
}
export interface SubscriptionCreditCyclesTable {
  owner_id: string; runtime_slot: string; cycle_start: string; cycle_end: string;
  subscription_id: string; entitlement_microusd: number; legacy_offset_microusd: number; updated_at: string;
}
