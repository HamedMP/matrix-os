import type { useAuth } from "@clerk/nextjs";
import {
  MATRIX_HOSTED_BILLING_PLANS,
  MATRIX_HOSTED_BILLING_REGIONS,
  MATRIX_HOSTED_MACHINE_PROFILES,
  closestMatrixRegionSlug,
  resolveMatrixMachineProfile,
  type MatrixHostedBillingPlanSlug,
  type MatrixHostedBillingRegionSlug,
  type MatrixHostedPlanFeatureSlug,
} from "@matrix-os/contracts";

export const MATRIX_BILLING_PLAN_SLUGS = MATRIX_HOSTED_BILLING_PLANS.map((plan) => plan.slug);
export const MATRIX_BILLING_RETURN_PATH = "/";
export const MATRIX_BILLING_SUCCESS_RETURN_PATH = "/?checkout=success";
export const MATRIX_BILLING_DEFAULT_APP_URL = "https://app.matrix-os.com";

export type BillingPlanChecker = ReturnType<typeof useAuth>["has"];
export type MatrixServerProfileSlug = MatrixHostedPlanFeatureSlug;
export type MatrixRegionSlug = MatrixHostedBillingRegionSlug;

export type MatrixServerProfile = {
  featureSlug: MatrixServerProfileSlug;
  planSlug: MatrixHostedBillingPlanSlug;
  hetznerType: string;
  label: string;
  vcpus: number;
  cpu: "AMD";
  memoryGb: number;
  diskGb: number;
  monthlyCapEur: string;
  hourlyEur: string;
  monthlyPriceUsd: string | null;
  annualPriceUsd: null;
};

export type MatrixRegion = {
  featureSlug: MatrixRegionSlug;
  location: string;
  flag: string;
  label: string;
  networkZone: "eu-central" | "us-east" | "us-west";
};

export const MATRIX_BILLING_SERVER_PROFILES: MatrixServerProfile[] = MATRIX_HOSTED_BILLING_PLANS.map((plan) => {
  const machine = resolveMatrixMachineProfile(plan.slug, "region_fsn1");
  if (!machine) throw new Error(`Missing default hosted machine profile for ${plan.slug}`);
  return {
    featureSlug: plan.featureSlug,
    planSlug: plan.slug,
    hetznerType: machine.serverType.toUpperCase(),
    label: plan.label,
    vcpus: machine.vcpus,
    cpu: "AMD" as const,
    memoryGb: machine.memoryGb,
    diskGb: machine.diskGb,
    monthlyCapEur: "",
    hourlyEur: "",
    monthlyPriceUsd: String(plan.monthlyUsd),
    annualPriceUsd: null,
  };
});

export const MATRIX_BILLING_MACHINE_PROFILES = MATRIX_HOSTED_MACHINE_PROFILES;

export const MATRIX_BILLING_REGIONS: MatrixRegion[] = MATRIX_HOSTED_BILLING_REGIONS.map((region) => ({
  featureSlug: region.slug,
  location: region.location,
  flag: region.flag,
  label: region.label,
  networkZone: region.networkZone,
}));

export function resolveMatrixServerProfile(
  profile: MatrixServerProfile,
  region: MatrixRegion,
): MatrixServerProfile {
  const machine = resolveMatrixMachineProfile(profile.planSlug, region.featureSlug);
  if (!machine) return profile;
  return {
    ...profile,
    hetznerType: machine.serverType.toUpperCase(),
    vcpus: machine.vcpus,
    memoryGb: machine.memoryGb,
    diskGb: machine.diskGb,
  };
}

export function getClosestMatrixRegionSlug(timeZone?: string | null): MatrixRegionSlug {
  return closestMatrixRegionSlug(timeZone);
}

export function hasMatrixBillingAccess(has: BillingPlanChecker): boolean {
  return MATRIX_BILLING_PLAN_SLUGS.some((plan) => has?.({ plan }) === true);
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
