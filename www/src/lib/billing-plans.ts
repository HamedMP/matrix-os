// Canonical landing plan data. MUST stay in sync with the shell billing select
// (MATRIX_BILLING_SERVER_PROFILES) — enforced by tests/www/landing-billing-parity.test.ts.

export type PlanUrlSlug = "starter" | "builder" | "max";
export type PlanSlug = "matrix_starter" | "matrix_builder" | "matrix_max";
export type FeatureSlug = "server_cpx22" | "server_cpx32" | "server_cpx52";

export interface LandingPlan {
  urlSlug: PlanUrlSlug;
  planSlug: PlanSlug;
  featureSlug: FeatureSlug;
  label: string;
  machine: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  monthly: string;
  annual: string;
  popular: boolean;
}

export const LANDING_PLANS: LandingPlan[] = [
  {
    urlSlug: "starter",
    planSlug: "matrix_starter",
    featureSlug: "server_cpx22",
    label: "Starter",
    machine: "CPX22",
    vcpus: 2,
    memoryGb: 4,
    diskGb: 80,
    monthly: "$14",
    annual: "$140",
    popular: false,
  },
  {
    urlSlug: "builder",
    planSlug: "matrix_builder",
    featureSlug: "server_cpx32",
    label: "Builder",
    machine: "CPX32",
    vcpus: 4,
    memoryGb: 8,
    diskGb: 160,
    monthly: "$19",
    annual: "$190",
    popular: true,
  },
  {
    urlSlug: "max",
    planSlug: "matrix_max",
    featureSlug: "server_cpx52",
    label: "Max",
    machine: "CPX52",
    vcpus: 12,
    memoryGb: 24,
    diskGb: 480,
    monthly: "$49",
    annual: "$490",
    popular: false,
  },
];

const URL_SLUG_TO_PLAN: Record<PlanUrlSlug, PlanSlug> = {
  starter: "matrix_starter",
  builder: "matrix_builder",
  max: "matrix_max",
};

export function parsePlanUrlSlug(value: string | null | undefined): PlanSlug | null {
  if (!value) return null;
  const key = value.trim().toLowerCase() as PlanUrlSlug;
  return URL_SLUG_TO_PLAN[key] ?? null;
}

export function planSlugToFeatureSlug(planSlug: string): string | null {
  return LANDING_PLANS.find((p) => p.planSlug === planSlug)?.featureSlug ?? null;
}

export function specLine(plan: LandingPlan): string {
  return `${plan.vcpus} vCPU / ${plan.memoryGb} GB RAM / ${plan.diskGb} GB disk`;
}
