import type { useAuth } from "@clerk/nextjs";

export const MATRIX_BILLING_PLAN = "early_adopter";
export const MATRIX_BILLING_RETURN_PATH = "/";
export const MATRIX_BILLING_SUCCESS_RETURN_PATH = "/?checkout=success";
export const MATRIX_BILLING_DEFAULT_APP_URL = "https://app.matrix-os.com";

export type BillingPlanChecker = ReturnType<typeof useAuth>["has"];

export function hasMatrixBillingAccess(has: BillingPlanChecker): boolean {
  return has?.({ plan: MATRIX_BILLING_PLAN }) === true;
}

export function getMatrixBillingSuccessRedirectUrl(): string {
  // Only called from "use client" components after Clerk has loaded; window is
  // expected there. The configured/default URL is a safety net for tests and
  // non-browser evaluation, not the normal checkout target.
  const configuredAppUrl = process.env.NEXT_PUBLIC_MATRIX_APP_URL;
  const fallbackOrigin =
    configuredAppUrl && URL.canParse(configuredAppUrl)
      ? new URL(configuredAppUrl).origin
      : MATRIX_BILLING_DEFAULT_APP_URL;
  const appOrigin =
    typeof window !== "undefined" && window.location.origin
      ? window.location.origin
      : fallbackOrigin;

  return new URL(MATRIX_BILLING_SUCCESS_RETURN_PATH, appOrigin).toString();
}
