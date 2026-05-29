import type { useAuth } from "@clerk/nextjs";

export const MATRIX_BILLING_PLAN_SLUGS = ["early_adopter"] as const;
export const MATRIX_BILLING_RETURN_PATH = "/";
export const MATRIX_BILLING_SUCCESS_RETURN_PATH = "/?checkout=success";
export const MATRIX_BILLING_DEFAULT_APP_URL = "https://app.matrix-os.com";

export type BillingPlanChecker = ReturnType<typeof useAuth>["has"];
export type MatrixServerProfileSlug =
  | "server_cpx11"
  | "server_cpx22"
  | "server_cpx32"
  | "server_cpx52";
export type MatrixRegionSlug =
  | "region_fsn1"
  | "region_nbg1"
  | "region_ash"
  | "region_hil";

export type MatrixServerProfile = {
  featureSlug: MatrixServerProfileSlug;
  hetznerType: string;
  label: string;
  vcpus: number;
  cpu: "AMD";
  memoryGb: number;
  diskGb: number;
  monthlyCapEur: string;
  hourlyEur: string;
  monthlyPriceUsd: string | null;
};

export type MatrixRegion = {
  featureSlug: MatrixRegionSlug;
  location: string;
  flag: string;
  label: string;
  networkZone: "eu-central" | "us-east" | "us-west" | "ap-southeast";
};

export const MATRIX_BILLING_SERVER_PROFILES: MatrixServerProfile[] = [
  {
    featureSlug: "server_cpx22",
    hetznerType: "CPX22",
    label: "Starter",
    vcpus: 2,
    cpu: "AMD",
    memoryGb: 4,
    diskGb: 80,
    monthlyCapEur: "8.49",
    hourlyEur: "0.0136",
    monthlyPriceUsd: "14",
  },
  {
    featureSlug: "server_cpx32",
    hetznerType: "CPX32",
    label: "Builder",
    vcpus: 4,
    cpu: "AMD",
    memoryGb: 8,
    diskGb: 160,
    monthlyCapEur: "14.49",
    hourlyEur: "0.0232",
    monthlyPriceUsd: "19",
  },
  {
    featureSlug: "server_cpx52",
    hetznerType: "CPX52",
    label: "Max",
    vcpus: 12,
    cpu: "AMD",
    memoryGb: 24,
    diskGb: 480,
    monthlyCapEur: "36.99",
    hourlyEur: "0.0593",
    monthlyPriceUsd: "49",
  },
];

export const MATRIX_TRIAL_WARMUP_SERVER_PROFILE: MatrixServerProfile = {
  featureSlug: "server_cpx11",
  hetznerType: "CPX11",
  label: "Trial warmup",
  vcpus: 2,
  cpu: "AMD",
  memoryGb: 2,
  diskGb: 40,
  monthlyCapEur: "6.49",
  hourlyEur: "0.0104",
  monthlyPriceUsd: null,
};

export const MATRIX_BILLING_REGIONS: MatrixRegion[] = [
  {
    featureSlug: "region_fsn1",
    location: "fsn1",
    flag: "🇩🇪",
    label: "Falkenstein, Germany",
    networkZone: "eu-central",
  },
  {
    featureSlug: "region_nbg1",
    location: "nbg1",
    flag: "🇩🇪",
    label: "Nuremberg, Germany",
    networkZone: "eu-central",
  },
  {
    featureSlug: "region_ash",
    location: "ash",
    flag: "🇺🇸",
    label: "US East",
    networkZone: "us-east",
  },
  {
    featureSlug: "region_hil",
    location: "hil",
    flag: "🇺🇸",
    label: "US West",
    networkZone: "us-west",
  },
];

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
