export const MATRIX_BILLING_PLAN = "early_adopter";
export const MATRIX_BILLING_RETURN_PATH = "/";

export type BillingPlanChecker = ((params: { plan: string }) => boolean) | undefined;

export function hasMatrixBillingAccess(has: BillingPlanChecker): boolean {
  return has?.({ plan: MATRIX_BILLING_PLAN }) === true;
}
