import { createReadinessService } from "../../packages/gateway/src/onboarding/readiness-service.js";
import { InMemoryReadinessRepository } from "../../packages/gateway/src/onboarding/readiness-repository.js";
import type { CodingSetupProvider, CodingSetupStatus } from "../../packages/gateway/src/onboarding/coding-setup.js";

export const testPrincipal = {
  userId: "user_activation_test",
  source: "dev-default" as const,
};

export function createTestReadinessService(
  now: Date = new Date("2026-05-23T00:00:00.000Z"),
  options: { codingSetup?: CodingSetupStatus } = {},
) {
  const repository = new InMemoryReadinessRepository();
  const codingSetup: CodingSetupProvider | undefined = options.codingSetup
    ? { getCodingSetup: async () => options.codingSetup! }
    : undefined;
  const service = createReadinessService({
    repository,
    codingSetup,
    now: () => now,
  });
  return { repository, service };
}
