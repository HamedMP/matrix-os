import { createReadinessService } from "../../packages/gateway/src/onboarding/readiness-service.js";
import { InMemoryReadinessRepository } from "../../packages/gateway/src/onboarding/readiness-repository.js";
import type { CodingSetupProvider, CodingSetupStatus } from "../../packages/gateway/src/onboarding/coding-setup.js";
import type { AgentCredentialStatusResponse } from "../../packages/gateway/src/onboarding/activation-contracts.js";
import type { AgentCredentialStatusService } from "../../packages/gateway/src/onboarding/agent-credential-status.js";

export const testPrincipal = {
  userId: "user_activation_test",
  source: "dev-default" as const,
};

export function createTestReadinessService(
  now: Date = new Date("2026-05-23T00:00:00.000Z"),
  options: { codingSetup?: CodingSetupStatus; agentCredentials?: AgentCredentialStatusResponse } = {},
) {
  const repository = new InMemoryReadinessRepository();
  const codingSetup: CodingSetupProvider | undefined = options.codingSetup
    ? { getCodingSetup: async () => options.codingSetup! }
    : undefined;
  const agentCredentials: AgentCredentialStatusService | undefined = options.agentCredentials
    ? {
      getStatus: async () => options.agentCredentials!,
      verifyAgent: async (_ownerId, agent) => ({
        agent,
        status: "available",
        verifiedAt: now.toISOString(),
      }),
    }
    : undefined;
  const service = createReadinessService({
    repository,
    codingSetup,
    agentCredentials,
    now: () => now,
  });
  return { repository, service };
}
