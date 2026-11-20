import { createFundedAiCredentialManager, loadFundedAiRuntimeConfig } from "../funded-ai-credential-manager.js";
import { createFundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import { createFundedAiFundingSummaryClient } from "../funded-ai-funding-summary-client.js";
import { createCanonicalPhaseDiscovery } from "./canonical-phase-discovery.js";

/** The gateway's funded AI composition from the host environment; every part is absent without funded config. */
export function createFundedAiServices(env: NodeJS.ProcessEnv) {
  const fundedAiRuntimeConfig = loadFundedAiRuntimeConfig(env);
  const canonicalPhaseDiscovery = createCanonicalPhaseDiscovery(fundedAiRuntimeConfig, env.MATRIX_USER_ID ?? env.MATRIX_CLERK_USER_ID);
  const fundedCredentialProvider = fundedAiRuntimeConfig ? createFundedAiCredentialManager(fundedAiRuntimeConfig) : undefined;
  return {
    fundedAiRuntimeConfig,
    canonicalPhaseDiscovery,
    fundedCredentialProvider,
    // Orders this gateway's own funded retries; the platform enforces owner-wide priority.
    fundedAdmission: fundedCredentialProvider ? createFundedAdmissionQueue() : undefined,
    fundedAiFundingSummaryReader: fundedAiRuntimeConfig
      ? createFundedAiFundingSummaryClient(fundedAiRuntimeConfig, canonicalPhaseDiscovery.routeOptions)
      : undefined,
  };
}
