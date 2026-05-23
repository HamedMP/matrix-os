import { createReadinessService } from "../../packages/gateway/src/onboarding/readiness-service.js";
import { InMemoryReadinessRepository } from "../../packages/gateway/src/onboarding/readiness-repository.js";

export const testPrincipal = {
  userId: "user_activation_test",
  source: "dev-default" as const,
};

export function createTestReadinessService(now: Date = new Date("2026-05-23T00:00:00.000Z")) {
  const repository = new InMemoryReadinessRepository();
  const service = createReadinessService({
    repository,
    now: () => now,
  });
  return { repository, service };
}
