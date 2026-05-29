export const onboardingTestUser = {
  id: "user_onboarding_e2e",
  handle: "founder-test",
};

export const onboardingGoals = {
  coding: "coding",
  assistant: "assistant",
  appBuilding: "app_building",
  companyBrain: "company_brain",
} as const;

export function onboardingApi(path: string): string {
  return `/api/onboarding${path.startsWith("/") ? path : `/${path}`}`;
}

