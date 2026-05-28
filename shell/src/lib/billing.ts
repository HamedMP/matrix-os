import type { useAuth } from "@clerk/nextjs";

export const MATRIX_BILLING_PLAN = "early_adopter";
export const MATRIX_BILLING_RETURN_PATH = "/";
export const MATRIX_BILLING_SUCCESS_RETURN_PATH = "/?checkout=success";

export type BillingPlanChecker = ReturnType<typeof useAuth>["has"];

export function hasMatrixBillingAccess(has: BillingPlanChecker): boolean {
  return has?.({ plan: MATRIX_BILLING_PLAN }) === true;
}
