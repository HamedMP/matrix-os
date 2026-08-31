export const MATRIX_HOSTED_BILLING_PLAN_SLUGS = [
  "matrix_starter",
  "matrix_builder",
  "matrix_max",
] as const;

export const MATRIX_HOSTED_BILLING_REGION_SLUGS = [
  "region_fsn1",
  "region_nbg1",
  "region_ash",
  "region_hil",
] as const;

export type MatrixHostedBillingPlanSlug = typeof MATRIX_HOSTED_BILLING_PLAN_SLUGS[number];
export type MatrixHostedBillingRegionSlug = typeof MATRIX_HOSTED_BILLING_REGION_SLUGS[number];
export type MatrixHostedPlanFeatureSlug = "server_starter" | "server_builder" | "server_max";

export interface MatrixHostedBillingPlan {
  slug: MatrixHostedBillingPlanSlug;
  featureSlug: MatrixHostedPlanFeatureSlug;
  label: "Starter" | "Builder" | "Max";
  monthlyUsd: number;
  rank: number;
}

export interface MatrixHostedBillingRegion {
  slug: MatrixHostedBillingRegionSlug;
  location: "fsn1" | "nbg1" | "ash" | "hil";
  flag: "🇩🇪" | "🇺🇸";
  label: string;
  countryLabel: "Germany" | "United States";
  networkZone: "eu-central" | "us-east" | "us-west";
}

export interface MatrixMachineProfile {
  planSlug: MatrixHostedBillingPlanSlug;
  regionSlug: MatrixHostedBillingRegionSlug;
  serverType: "cpx21" | "cpx22" | "cpx31" | "cpx41" | "cpx42" | "cpx52";
  vcpus: number;
  memoryGb: number;
  diskGb: number;
}

export const MATRIX_HOSTED_BILLING_PLANS: readonly MatrixHostedBillingPlan[] = [
  { slug: "matrix_starter", featureSlug: "server_starter", label: "Starter", monthlyUsd: 20, rank: 10 },
  { slug: "matrix_builder", featureSlug: "server_builder", label: "Builder", monthlyUsd: 100, rank: 20 },
  { slug: "matrix_max", featureSlug: "server_max", label: "Max", monthlyUsd: 200, rank: 30 },
];

export const MATRIX_HOSTED_BILLING_REGIONS: readonly MatrixHostedBillingRegion[] = [
  {
    slug: "region_fsn1",
    location: "fsn1",
    flag: "🇩🇪",
    label: "Falkenstein, Germany",
    countryLabel: "Germany",
    networkZone: "eu-central",
  },
  {
    slug: "region_nbg1",
    location: "nbg1",
    flag: "🇩🇪",
    label: "Nuremberg, Germany",
    countryLabel: "Germany",
    networkZone: "eu-central",
  },
  {
    slug: "region_ash",
    location: "ash",
    flag: "🇺🇸",
    label: "Ashburn, Virginia",
    countryLabel: "United States",
    networkZone: "us-east",
  },
  {
    slug: "region_hil",
    location: "hil",
    flag: "🇺🇸",
    label: "Hillsboro, Oregon",
    countryLabel: "United States",
    networkZone: "us-west",
  },
];

const EU_MACHINE_SHAPES = {
  matrix_starter: { serverType: "cpx22", vcpus: 2, memoryGb: 4, diskGb: 80 },
  matrix_builder: { serverType: "cpx42", vcpus: 8, memoryGb: 16, diskGb: 320 },
  matrix_max: { serverType: "cpx52", vcpus: 12, memoryGb: 24, diskGb: 480 },
} as const;

const US_MACHINE_SHAPES = {
  matrix_starter: { serverType: "cpx21", vcpus: 3, memoryGb: 4, diskGb: 80 },
  matrix_builder: { serverType: "cpx31", vcpus: 4, memoryGb: 8, diskGb: 160 },
  matrix_max: { serverType: "cpx41", vcpus: 8, memoryGb: 16, diskGb: 240 },
} as const;

export const MATRIX_HOSTED_MACHINE_PROFILES: readonly MatrixMachineProfile[] =
  MATRIX_HOSTED_BILLING_REGIONS.flatMap((region) => {
    const shapes = region.networkZone === "eu-central" ? EU_MACHINE_SHAPES : US_MACHINE_SHAPES;
    return MATRIX_HOSTED_BILLING_PLANS.map((plan) => ({
      planSlug: plan.slug,
      regionSlug: region.slug,
      ...shapes[plan.slug],
    }));
  });

export function resolveMatrixMachineProfile(
  planSlug: MatrixHostedBillingPlanSlug,
  regionSlug: MatrixHostedBillingRegionSlug,
): MatrixMachineProfile | undefined {
  return MATRIX_HOSTED_MACHINE_PROFILES.find(
    (profile) => profile.planSlug === planSlug && profile.regionSlug === regionSlug,
  );
}

const FALKENSTEIN_TIMEZONES = new Set([
  "Europe/Berlin",
  "Europe/Copenhagen",
  "Europe/Oslo",
  "Europe/Prague",
  "Europe/Stockholm",
  "Europe/Warsaw",
]);

const HILLSBORO_AMERICAN_TIMEZONES = new Set([
  "America/Anchorage",
  "America/Boise",
  "America/Denver",
  "America/Edmonton",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Tijuana",
  "America/Vancouver",
]);

export function closestMatrixRegionSlug(timeZone: string | null | undefined): MatrixHostedBillingRegionSlug {
  const normalized = timeZone?.trim();
  if (!normalized) return "region_fsn1";
  if (HILLSBORO_AMERICAN_TIMEZONES.has(normalized)) return "region_hil";
  if (normalized.startsWith("America/")) return "region_ash";
  if (FALKENSTEIN_TIMEZONES.has(normalized)) return "region_fsn1";
  if (normalized.startsWith("Europe/") || normalized.startsWith("Africa/")) return "region_nbg1";
  if (
    normalized.startsWith("Asia/")
    || normalized.startsWith("Australia/")
    || normalized.startsWith("Pacific/")
  ) return "region_hil";
  return "region_fsn1";
}
